import { beforeEach, describe, expect, it, vi } from "vitest";
import { Actor } from "../src/actor";
import type { AnyActorDefinition } from "../src/contracts";
import { defineActor } from "../src/index";
import type { InMemoryPersistenceAdapter } from "../src/store/inMemory";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

type TestState = { count: number };

describe("Persistence Error Handling", () => {
  let store: InMemoryPersistenceAdapter;
  let definition: AnyActorDefinition;

  beforeEach(() => {
    store = inMemoryPersistenceAdapter();
    definition = defineActor("ErrorTestActor")
      .initialState((): TestState => ({ count: 0 }))
      .commands({
        inc: (s) => s.count++,
      })
      .queries({
        get: (s) => s.count,
      })
      .build();
  });

  it("should mark actor as failed and reject messages if commit fails", async () => {
    const actor = new Actor("actor-1", definition, store, "instance-1");
    vi.spyOn(store, "commitEvent").mockRejectedValue(
      new Error("DB Write Error"),
    );

    await expect(actor.handleTell("inc", [])).rejects.toThrow("DB Write Error");

    expect(actor.isFailed).toBe(true);

    await expect(actor.handleTell("inc", [])).rejects.toThrow(
      "Actor actor-1 is failed. Further messages are rejected.",
    );
    await expect(actor.handleAsk("get", [])).rejects.toThrow(
      "Actor actor-1 is failed. Further messages are rejected.",
    );
  });

  it("should call onError metric when a persistence error occurs", async () => {
    const onError = vi.fn();
    const commitError = new Error("DB Connection Lost");
    vi.spyOn(store, "commitEvent").mockRejectedValue(commitError);

    const actor = new Actor(
      "actor-2",
      definition,
      store,
      "instance-1",
      undefined,
      {
        onError,
      },
    );

    await expect(actor.handleTell("inc", [])).rejects.toThrow(commitError);
    expect(onError).toHaveBeenCalledWith("actor-2", commitError);
  });

  it("should release the distributed lock if commit fails", async () => {
    const releaseSpy = vi.spyOn(store, "release");
    vi.spyOn(store, "commitEvent").mockRejectedValue(new Error("DB Error"));
    const actor = new Actor("actor-3", definition, store, "instance-1");

    await actor.inspect();

    await expect(actor.handleTell("inc", [])).rejects.toThrow("DB Error");
    expect(releaseSpy).toHaveBeenCalledWith("actor-3", "instance-1");
  });

  it("should fail on optimistic lock violation", async () => {
    // Simulate two concurrent instances by not providing an instanceUUID,
    // which disables the distributed lock and allows both to hydrate.
    const actor1 = new Actor("shared-actor", definition, store, undefined);
    const actor2 = new Actor("shared-actor", definition, store, undefined);

    // Hydrate both, they now both think the version is 0.
    await actor1.inspect();
    await actor2.inspect();

    // Actor 1 succeeds, advancing the version in the store to 1.
    await actor1.handleTell("inc", []);
    expect((await actor1.inspect()).version).toBe(1n);

    // Actor 2 tries to commit based on version 0, which the store will reject.
    await expect(actor2.handleTell("inc", [])).rejects.toThrow(
      "Optimistic lock failure: expected version 0, got 1",
    );

    // Actor 2 is now failed because its state is out of sync.
    expect(actor2.isFailed).toBe(true);
    // Actor 1 is still healthy.
    expect(actor1.isFailed).toBe(false);
  });

  it("should allow recovery by creating a new actor reference", async () => {
    const commitError = new Error("Temporary DB failure");
    const commitSpy = vi.spyOn(store, "commitEvent");

    // Instance 1: Fails
    const actor1 = new Actor("recovery-actor", definition, store, "instance-1");
    // This call uses the original implementation and succeeds
    await actor1.handleTell("inc", []);

    // Now mock the next call to fail
    commitSpy.mockRejectedValueOnce(commitError);
    await expect(actor1.handleTell("inc", [])).rejects.toThrow(commitError);
    expect(actor1.isFailed).toBe(true);

    // Instance 2: Recovers
    // The store still has the state from before the failure (count: 1, version: 1)
    const actor2 = new Actor<TestState>(
      "recovery-actor",
      definition,
      store,
      "instance-2",
    );
    await expect(actor2.inspect()).resolves.toEqual({
      state: { count: 1 },
      version: 1n,
    });
    await expect(actor2.handleTell("inc", [])).resolves.toBe(1);
    expect((await actor2.inspect()).state.count).toBe(2);
  });
});
