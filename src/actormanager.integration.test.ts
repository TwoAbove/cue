import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./index.js";
import { inMemoryStore } from "./store/inMemory.js";

const counterDef = defineActor("Counter")
  .initialState(() => ({ count: 0 }))
  .commands({
    increment: (state, amount = 1) => {
      state.count += amount;
      return state.count;
    },
  })
  .queries({
    getCount: (state) => state.count,
  })
  .build();

describe("ActorManager Integration", () => {
  it("should work with a persistence store", async () => {
    const manager = createActorManager({
      definition: counterDef,
      store: inMemoryStore(),
    });

    const actor = manager.get("test-actor");

    const result = await actor.tell.increment(5);
    expect(result).toBe(5);

    const count = await actor.ask.getCount();
    expect(count).toBe(5);

    await manager.shutdown();
  });

  it("should work without a persistence store", async () => {
    const manager = createActorManager({
      definition: counterDef,
    });

    const actor = manager.get("test-actor");

    const result = await actor.tell.increment();
    expect(result).toBe(1);

    const count = await actor.ask.getCount();
    expect(count).toBe(1);

    await manager.shutdown();
  });

  it("should persist updates by calling store.commit", async () => {
    const store = inMemoryStore();
    const commitSpy = vi.spyOn(store, "commit");

    const mgr = createActorManager({ definition: counterDef, store });
    const a = mgr.get("id");
    await a.tell.increment(1);

    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith(
      "id",
      0n,
      [{ op: "replace", path: "/count", value: 1 }],
      expect.objectContaining({ handler: "increment", returnVal: 1 }),
    );

    await mgr.shutdown();
  });
});
