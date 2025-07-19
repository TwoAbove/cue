import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

const snapshotDef = defineActor("SnapshotTest")
  .initialState(() => ({ count: 0, data: "" }))
  .commands({
    inc: (s) => s.count++,
    setData: (s, d: string) => {
      s.data = d;
    },
    streamInc: async function* (state) {
      state.count++;
      yield;
    },
  })
  .persistence({ snapshotEvery: 3 })
  .build();

describe("Snapshotting", () => {
  it("should create a snapshot at the configured version interval", async () => {
    const store = inMemoryPersistenceAdapter();
    const commitSnapshotSpy = vi.spyOn(store, "commitSnapshot");
    const manager = createActorManager({ definition: snapshotDef, store });
    const actor = manager.get("actor-1");

    await actor.tell.inc();
    await actor.tell.inc();
    expect(commitSnapshotSpy).not.toHaveBeenCalled();

    await actor.tell.inc();
    expect(commitSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(commitSnapshotSpy).toHaveBeenCalledWith(
      "actor-1",
      3n,
      expect.any(String),
    );

    await manager.terminate();
  });

  it("should hydrate from the latest snapshot and apply subsequent events", async () => {
    const store = inMemoryPersistenceAdapter();
    const actorId = "actor-2";

    const manager1 = createActorManager({ definition: snapshotDef, store });
    const actor1 = manager1.get(actorId);
    await actor1.tell.inc();
    await actor1.tell.inc();
    await actor1.tell.inc();
    await actor1.tell.setData("final");
    await manager1.terminate();

    const getEventsSpy = vi.spyOn(store, "getEvents");
    const manager2 = createActorManager({ definition: snapshotDef, store });
    const actor2 = manager2.get(actorId);
    const { state, version } = await actor2.inspect();

    expect(getEventsSpy).toHaveBeenCalledWith(actorId, 3n);
    expect(state.count).toBe(3);
    expect(state.data).toBe("final");
    expect(version).toBe(4n);

    await manager2.terminate();
  });

  it("should not fail the command if snapshot persistence throws an error", async () => {
    const store = inMemoryPersistenceAdapter();
    const snapshotError = new Error("Disk full");
    vi.spyOn(store, "commitSnapshot").mockRejectedValue(snapshotError);
    const manager = createActorManager({ definition: snapshotDef, store });
    const actor = manager.get("actor-3");

    await actor.tell.inc();
    await actor.tell.inc();

    await expect(actor.tell.inc()).resolves.toBe(2);

    // State and version should still be updated correctly
    const { state, version } = await actor.inspect();
    expect(state.count).toBe(3);
    expect(version).toBe(3n);

    await manager.terminate();
  });

  it("should create a snapshot after a streaming command", async () => {
    const streamSnapshotDef = defineActor("StreamSnapshot")
      .initialState(() => ({ count: 0 }))
      // biome-ignore lint/complexity/useLiteralKeys: This is for testing
      // biome-ignore lint/style/noNonNullAssertion: This is for testing
      .commands({ streamInc: snapshotDef._handlers["streamInc"]!.fn })
      .persistence({ snapshotEvery: 1 })
      .build();

    const store = inMemoryPersistenceAdapter();
    const commitSnapshotSpy = vi.spyOn(store, "commitSnapshot");
    const manager = createActorManager({
      definition: streamSnapshotDef,
      store,
    });
    const actor = manager.get("actor-4");

    await actor.tell.streamInc();

    expect(commitSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(commitSnapshotSpy).toHaveBeenCalledWith(
      "actor-4",
      1n,
      expect.any(String),
    );

    await manager.terminate();
  });
});
