import { beforeEach, describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "../../src/index";
import { InMemoryPersistenceAdapter } from "../../src/store/inMemory";

describe("InMemoryPersistenceAdapter", () => {
  let store: InMemoryPersistenceAdapter;

  beforeEach(() => {
    store = new InMemoryPersistenceAdapter();
  });

  const testDef = defineActor("TestActor")
    .initialState(() => ({ value: 0 }))
    .commands({
      set: (state, value: number) => {
        state.value = value;
      },
    })
    .persistence({ snapshotEvery: 2 })
    .build();

  it("should persist events and allow rehydration", async () => {
    const manager1 = createActorManager({ definition: testDef, store });
    const actor1 = manager1.get("actor-1");
    await actor1.tell.set(42);
    await manager1.terminate();

    const manager2 = createActorManager({ definition: testDef, store });
    const actor2 = manager2.get("actor-1");
    const { state, version } = await actor2.inspect();
    expect(state.value).toBe(42);
    expect(version).toBe(1n);
    await manager2.terminate();
  });

  it("should correctly handle snapshots", async () => {
    const manager = createActorManager({ definition: testDef, store });
    const actor = manager.get("snapshot-actor");

    await actor.tell.set(1); // v1
    await actor.tell.set(2); // v2, creates snapshot
    await actor.tell.set(3); // v3

    const snapshot = await store.getLatestSnapshot("snapshot-actor");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(2n);

    // Events before the snapshot version should be pruned
    const events = await store.getEvents("snapshot-actor", 0n);
    expect(events.length).toBe(1);
    expect(events[0]?.version).toBe(3n);

    await manager.terminate();
  });

  it("should correctly implement optimistic locking at the commit level", async () => {
    await store.commitEvent("lock-actor", 1n, "{}", "{}");

    // Trying to commit version 1 again should fail
    await expect(
      store.commitEvent("lock-actor", 1n, "{}", "{}"),
    ).rejects.toThrow("Optimistic lock failure: expected version 0, got 1");

    // Trying to commit a non-sequential version should fail
    await expect(
      store.commitEvent("lock-actor", 3n, "{}", "{}"),
    ).rejects.toThrow("Optimistic lock failure: expected version 2, got 1");

    // Committing the correct next version should succeed
    await expect(
      store.commitEvent("lock-actor", 2n, "{}", "{}"),
    ).resolves.toBeUndefined();
  });

  it("should correctly implement distributed locking", async () => {
    const acquired1 = await store.acquire("dist-lock", "owner-1", 1000);
    expect(acquired1).toBe(true);

    const acquired2 = await store.acquire("dist-lock", "owner-2", 1000);
    expect(acquired2).toBe(false);

    await store.release("dist-lock", "owner-1");

    const acquired3 = await store.acquire("dist-lock", "owner-2", 1000);
    expect(acquired3).toBe(true);
  });
});
