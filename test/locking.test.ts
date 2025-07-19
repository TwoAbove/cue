import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { InMemoryPersistenceAdapter } from "../src/store/inMemory";

const testDef = defineActor("LockTest")
  .initialState(() => ({ value: 0 }))
  .commands({
    inc: (s) => s.value++,
  })
  .build();

describe("Distributed Locking", () => {
  let store: InMemoryPersistenceAdapter;
  beforeEach(() => {
    store = new InMemoryPersistenceAdapter();
  });

  it("should acquire a lock on hydration and release it on shutdown", async () => {
    const acquireSpy = vi.spyOn(store, "acquire");
    const releaseSpy = vi.spyOn(store, "release");

    const manager = createActorManager({ definition: testDef, store });
    const actor = manager.get("actor-1");

    await actor.inspect();
    expect(acquireSpy).toHaveBeenCalledWith(
      "actor-1",
      expect.any(String),
      expect.any(Number),
    );
    expect(releaseSpy).not.toHaveBeenCalled();

    await actor.terminate();
    expect(releaseSpy).toHaveBeenCalledWith("actor-1", expect.any(String));

    await manager.terminate();
  });

  it("should fail to hydrate if lock cannot be acquired", async () => {
    const manager1 = createActorManager({
      definition: testDef,
      store,
      lockTtlMs: 5000,
    });
    const actor1 = manager1.get("locked-actor");
    await actor1.inspect();

    const manager2 = createActorManager({
      definition: testDef,
      store,
      lockTtlMs: 5000,
    });
    const actor2 = manager2.get("locked-actor");
    await expect(actor2.inspect()).rejects.toThrow(
      "Failed to acquire lock for actor locked-actor",
    );

    await manager1.terminate();
    await manager2.terminate();
  });

  it("should release lock even if hydration fails", async () => {
    const releaseSpy = vi.spyOn(store, "release");
    const hydrationError = new Error("DB read failed");
    vi.spyOn(store, "getEvents").mockRejectedValue(hydrationError);

    const manager = createActorManager({ definition: testDef, store });
    const actor = manager.get("hydration-fail-actor");

    await expect(actor.inspect()).rejects.toThrow(hydrationError);

    expect(releaseSpy).toHaveBeenCalledWith(
      "hydration-fail-actor",
      expect.any(String),
    );

    await manager.terminate();
  });

  it("should not attempt to release lock if acquire failed", async () => {
    const releaseSpy = vi.spyOn(store, "release");
    vi.spyOn(store, "acquire").mockResolvedValue(false);

    const manager = createActorManager({ definition: testDef, store });
    const actor = manager.get("acquire-fail-actor");

    await expect(actor.inspect()).rejects.toThrow(
      "Failed to acquire lock for actor acquire-fail-actor",
    );

    expect(releaseSpy).not.toHaveBeenCalled();
    await manager.terminate();
  });

  it("should function without locking if store does not implement it", async () => {
    const storeWithoutLocking = new InMemoryPersistenceAdapter();
    // @ts-expect-error - testing missing methods
    storeWithoutLocking.acquire = undefined;
    // @ts-expect-error - testing missing methods
    storeWithoutLocking.release = undefined;

    const manager = createActorManager({
      definition: testDef,
      store: storeWithoutLocking,
    });
    const actor = manager.get("no-lock-actor");

    // Should succeed without trying to lock, and return the command's result
    await expect(actor.tell.inc()).resolves.toBe(0);

    await manager.terminate();
  });
});
