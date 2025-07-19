import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

describe("Persistence and Hydration", () => {
  const testDef = defineActor("PersistTest")
    .initialState(() => ({
      value: 10,
      data: new Map<string, number>(),
    }))
    .commands({
      setValue: (state, val: number) => {
        state.value = val;
      },
      setData: (state, map: Map<string, number>) => {
        state.data = map;
      },
    })
    .build();

  it("should start with initial state when no persisted data exists", async () => {
    const store = inMemoryPersistenceAdapter();
    const manager = createActorManager({ definition: testDef, store });
    const actor = manager.get("new-actor");

    const { state, version } = await actor.inspect();
    expect(state.value).toBe(10);
    expect(version).toBe(0n);
    await manager.terminate();
  });

  it("should hydrate actor state from existing events", async () => {
    const store = inMemoryPersistenceAdapter();
    const actorId = "hydrate-actor";

    const manager1 = createActorManager({ definition: testDef, store });
    const actor1 = manager1.get(actorId);
    await actor1.tell.setValue(99);
    await actor1.tell.setData(new Map([["a", 1]]));
    await manager1.terminate();

    const manager2 = createActorManager({ definition: testDef, store });
    const actor2 = manager2.get(actorId);
    const { state, version } = await actor2.inspect();

    expect(state.value).toBe(99);
    expect(state.data).toEqual(new Map([["a", 1]]));
    expect(version).toBe(2n);
    await manager2.terminate();
  });

  it("should throw an error when rehydrating with a mismatched definition name", async () => {
    const store = inMemoryPersistenceAdapter();
    const actorId = "mismatch-actor";

    const def1 = defineActor("MyActorV1")
      .initialState(() => ({ v: 0 }))
      .commands({
        foo: (s) => {
          s.v = 1;
        },
      })
      .build();
    const manager1 = createActorManager({ definition: def1, store });
    await manager1.get(actorId).tell.foo();
    await manager1.terminate();

    const def2 = defineActor("MyActorV2")
      .initialState(() => ({}))
      .commands({ bar: () => {} })
      .build();
    const manager2 = createActorManager({ definition: def2, store });
    const actor2 = manager2.get(actorId);

    await expect(actor2.inspect()).rejects.toThrow(
      "Definition mismatch: Actor 'mismatch-actor' was created with definition 'MyActorV1', but is being rehydrated with 'MyActorV2'.",
    );
    await manager2.terminate();
  });

  describe("No-Op Commit Optimizations", () => {
    it("should not commit or increment version if a command causes no state change", async () => {
      const store = inMemoryPersistenceAdapter();
      const commitSpy = vi.spyOn(store, "commitEvent");
      const manager = createActorManager({ definition: testDef, store });
      const actor = manager.get("no-op-actor");

      await actor.tell.setValue(10);
      const { state, version } = await actor.inspect();

      expect(state.value).toBe(10);
      expect(version).toBe(0n);
      expect(commitSpy).not.toHaveBeenCalled();

      await manager.terminate();
    });

    it("should not commit if a command replaces a Map/Set with a deep-equal one", async () => {
      const store = inMemoryPersistenceAdapter();
      const commitSpy = vi.spyOn(store, "commitEvent");
      const manager = createActorManager({ definition: testDef, store });
      const actor = manager.get("no-op-map-actor");

      await actor.tell.setData(new Map([["a", 1]]));
      expect((await actor.inspect()).version).toBe(1n);
      expect(commitSpy).toHaveBeenCalledTimes(1);

      await actor.tell.setData(new Map([["a", 1]]));
      expect((await actor.inspect()).version).toBe(1n);
      expect(commitSpy).toHaveBeenCalledTimes(1);

      await manager.terminate();
    });
  });
});
