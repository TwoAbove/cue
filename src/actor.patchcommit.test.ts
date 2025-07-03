import { beforeEach, describe, expect, it, vi } from "vitest";
import { Actor } from "./actor/Actor.js";
import type { AnyActorDefinition } from "./contracts.js";
import { defineActor } from "./index.js";
import { InMemoryStore } from "./store/inMemory.js";

type TestState = { count: number; name: string };

describe("Actor Patch-Commit Pattern", () => {
  let store: InMemoryStore;
  let definition: AnyActorDefinition;

  beforeEach(() => {
    store = new InMemoryStore();
    definition = defineActor("TestActor")
      .initialState((): TestState => ({ count: 0, name: "test" }))
      .commands({
        increment: (state, amount = 1) => {
          state.count += amount;
          return state.count;
        },
        setName: (state, name: string) => {
          state.name = name;
          return name;
        },
      })
      .queries({
        getState: (state) => state,
      })
      .build();
  });

  it("should commit patches with metadata to store", async () => {
    const commitSpy = vi.spyOn(store, "commit");

    const actor = new Actor("test-actor", definition, store, "instance-1");

    const result = await actor.handleTell("increment", [5]);
    expect(result).toBe(5);

    expect(commitSpy).toHaveBeenCalledWith(
      "test-actor",
      0n,
      [{ op: "replace", path: "/count", value: 5 }],
      {
        handler: "increment",
        payload: [5],
        returnVal: 5,
      },
    );
  });

  it("should handle optimistic lock failures", async () => {
    const storeWithoutLocking = new InMemoryStore();

    const actor1 = new Actor(
      "test-actor",
      definition,
      storeWithoutLocking,
      undefined, // no instanceUUID to disable locking
    );

    const actor2 = new Actor(
      "test-actor",
      definition,
      storeWithoutLocking,
      undefined, // no instanceUUID to disable locking
    );

    await actor1.inspect();
    await actor2.inspect();

    await actor1.handleTell("increment", [1]);

    // Second actor should fail due to optimistic lock (still thinks version is 0, but store has version 1)
    await expect(actor2.handleTell("increment", [1])).rejects.toThrow(
      "Optimistic lock failure",
    );
  });

  it("should increment version correctly with each commit", async () => {
    const actor = new Actor("test-actor", definition, store, "instance-1");

    await actor.handleTell("increment", [1]);
    await actor.handleTell("setName", ["updated"]);
    await actor.handleTell("increment", [2]);

    const inspection = await actor.inspect();
    expect(inspection.version).toBe(3n);
    expect((inspection.state as TestState).count).toBe(3);
    expect((inspection.state as TestState).name).toBe("updated");
  });
});
