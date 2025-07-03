import { beforeEach, describe, expect, it } from "vitest";
import { Actor } from "./actor/Actor.js";
import type { AnyActorDefinition } from "./contracts.js";
import { defineActor } from "./index.js";
import { InMemoryStore } from "./store/inMemory.js";

type TestState = { count: number; name: string };

describe("Actor Hydration with Store", () => {
  let store: InMemoryStore;
  let definition: AnyActorDefinition;

  beforeEach(() => {
    store = new InMemoryStore();
    definition = defineActor("TestActor")
      .initialState((): TestState => ({ count: 0, name: "initial" }))
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

  it("should start with initial state when no data exists", async () => {
    const actor = new Actor("new-actor", definition, store, "instance-1");

    const state = await actor.inspect();
    expect(state.version).toBe(0n);
    expect((state.state as TestState).count).toBe(0);
    expect((state.state as TestState).name).toBe("initial");
  });

  it("should hydrate from existing patches", async () => {
    const actor1 = new Actor("test-actor", definition, store, "instance-1");

    await actor1.handleTell("increment", [5]);
    await actor1.handleTell("setName", ["updated"]);
    await actor1.handleTell("increment", [3]);

    await actor1.shutdown();

    const actor2 = new Actor("test-actor", definition, store, "instance-2");

    const state = await actor2.inspect();
    expect(state.version).toBe(3n);
    expect((state.state as TestState).count).toBe(8);
    expect((state.state as TestState).name).toBe("updated");
  });

  it("should handle partial hydration from specific version", async () => {
    const actor1 = new Actor("test-actor", definition, store, "instance-1");

    await actor1.handleTell("increment", [1]);
    await actor1.handleTell("increment", [2]);
    await actor1.handleTell("setName", ["middle"]);
    await actor1.handleTell("increment", [3]);

    const loaded = await store.load("test-actor", 2n);
    expect(loaded.patches).toHaveLength(2);
    expect(loaded.patches[0]?.version).toBe(3n);
    expect(loaded.patches[1]?.version).toBe(4n);
  });

  it("should work with basic operations", async () => {
    const actor = new Actor("snapshot-actor", definition, store, "instance-1");

    await actor.handleTell("increment", [5]);

    const state = await actor.inspect();
    expect(state.version).toBe(1n);
    expect((state.state as TestState).count).toBe(5);
  });

  it("should handle empty store gracefully", async () => {
    const emptyStore = new InMemoryStore();

    const actor = new Actor(
      "empty-actor",
      definition,
      emptyStore,
      "instance-1",
    );

    const state = await actor.inspect();
    expect(state.version).toBe(0n);
    expect((state.state as TestState).count).toBe(0);
    expect((state.state as TestState).name).toBe("initial");
  });

  it("should maintain version consistency across hydration", async () => {
    const actor1 = new Actor("test-actor", definition, store, "instance-1");

    // Create some state changes
    await actor1.handleTell("increment", [1]);
    await actor1.handleTell("increment", [1]);
    await actor1.handleTell("increment", [1]);

    const state1 = await actor1.inspect();
    expect(state1.version).toBe(3n);

    // Shutdown first actor to release the lock
    await actor1.shutdown();

    // New actor with same ID should hydrate to the same version
    const actor2 = new Actor("test-actor", definition, store, "instance-2");

    const state2 = await actor2.inspect();
    expect(state2.version).toBe(3n);
    expect((state2.state as TestState).count).toBe(3);
  });
});
