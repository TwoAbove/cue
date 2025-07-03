import { beforeEach, describe, expect, it } from "vitest";
import { Actor } from "./actor/Actor.js";
import type { PatchStore } from "./contracts.js";
import { defineActor } from "./index.js";
import { InMemoryStore } from "./store/inMemory.js";

// Define the state shape once
type TestState = { count: number };

describe("Actor Locking", () => {
  let store: InMemoryStore;
  // biome-ignore lint/suspicious/noExplicitAny: Complex actor definition type from defineActor builder
  let definition: any;

  beforeEach(() => {
    store = new InMemoryStore();
    definition = defineActor("TestActor")
      .initialState((): TestState => ({ count: 0 }))
      .commands({
        increment: (state) => {
          state.count++;
          return state.count;
        },
      })
      .build();
  });

  it("should acquire lock during hydration", async () => {
    const actor = new Actor(
      "test-actor",
      definition,
      store,
      "instance-1",
      undefined,
      undefined,
    );

    await actor.handleTell("increment", []);

    const acquired = await store.acquire("test-actor", "instance-2");
    expect(acquired).toBe(false);
  });

  it("should release lock on shutdown", async () => {
    const actor = new Actor(
      "test-actor",
      definition,
      store,
      "instance-1",
      undefined,
      undefined,
    );

    await actor.handleTell("increment", []);

    let acquired = await store.acquire("test-actor", "instance-2");
    expect(acquired).toBe(false);

    await actor.shutdown();

    acquired = await store.acquire("test-actor", "instance-2");
    expect(acquired).toBe(true);
  });

  it("should fail to hydrate if lock cannot be acquired", async () => {
    await store.acquire("test-actor", "instance-1");

    const actor = new Actor(
      "test-actor",
      definition,
      store,
      "instance-2",
      undefined,
      undefined,
    );

    await expect(actor.handleTell("increment", [])).rejects.toThrow(
      "Failed to acquire lock for actor test-actor",
    );
  });

  it("should work without locking when store has no acquire method", async () => {
    const storeWithoutLocking: PatchStore = {
      async commit() {
        return 1n;
      },
      async load() {
        return { snapshot: null, patches: [] };
      },
      async commitSnapshot() {
        //noop
      },
    };

    const actor = new Actor(
      "test-actor",
      definition,
      storeWithoutLocking,
      "instance-1",
      undefined,
      undefined,
    );

    const result = await actor.handleTell("increment", []);
    expect(result).toBe(1);
  });
});
