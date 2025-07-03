import { beforeEach, describe, expect, it, vi } from "vitest";
import { Actor } from "./actor/Actor.js";
import { defineActor } from "./index.js";
import { InMemoryStore } from "./store/inMemory.js";

// Define the state shape once
type TestState = { count: number; data: string };

describe("Actor Snapshotting with Store", () => {
  let store: InMemoryStore;
  // biome-ignore lint/suspicious/noExplicitAny: Complex actor definition type from defineActor builder
  let definition: any;

  beforeEach(() => {
    store = new InMemoryStore();
    definition = defineActor("TestActor")
      .initialState((): TestState => ({ count: 0, data: "initial" }))
      .commands({
        increment: (state, ...args: unknown[]) => {
          const amount = (args[0] as number) ?? 1;
          state.count += amount;
          return state.count;
        },
        setData: (state, ...args: unknown[]) => {
          const data = args[0] as string;
          state.data = data;
          return data;
        },
      })
      .persistence({
        snapshotEvery: 3, // Snapshot every 3 operations
      })
      .build();
  });

  it("should create snapshots at configured intervals", async () => {
    const commitSnapshotSpy = vi.spyOn(store, "commitSnapshot");

    const actor = new Actor("snapshot-actor", definition, store, "instance-1");

    // These operations should not trigger a snapshot
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [2]);
    expect(commitSnapshotSpy).not.toHaveBeenCalled();

    // This operation should trigger a snapshot (version 3)
    await actor.handleTell("setData", ["snapshot-time"]);
    expect(commitSnapshotSpy).toHaveBeenCalledWith("snapshot-actor", 3n, {
      schemaVersion: 1,
      state: {
        count: 3,
        data: "snapshot-time",
      },
    });
  });

  it("should work with stores that have commitSnapshot", async () => {
    let version = 0n;
    const storeWithSnapshot = {
      async commit() {
        return ++version;
      },
      async load() {
        return { snapshot: null, patches: [] };
      },
      async acquire() {
        return true;
      },
      async release() {},
      async commitSnapshot() {
        // Required method - snapshots are now mandatory
      },
    };

    const commitSpy = vi.spyOn(storeWithSnapshot, "commit");
    const snapshotSpy = vi.spyOn(storeWithSnapshot, "commitSnapshot");

    const actor = new Actor(
      "snapshot-actor",
      definition,
      storeWithSnapshot,
      "instance-1",
    );

    // Trigger snapshot
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]);

    // Should have 3 regular commits
    expect(commitSpy).toHaveBeenCalledTimes(3);

    // Should have 1 snapshot call
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(snapshotSpy).toHaveBeenCalledWith("snapshot-actor", 3n, {
      schemaVersion: 1,
      state: {
        count: 3,
        data: "initial",
      },
    });
  });

  it("should hydrate correctly from snapshots", async () => {
    const actor1 = new Actor("hydration-test", definition, store, "instance-1");

    // Create state and trigger snapshot
    await actor1.handleTell("increment", [5]);
    await actor1.handleTell("setData", ["before-snapshot"]);
    await actor1.handleTell("increment", [2]); // This triggers snapshot at version 3

    // Add more changes after snapshot
    await actor1.handleTell("increment", [1]);
    await actor1.handleTell("setData", ["after-snapshot"]);

    await actor1.shutdown();

    // New actor should hydrate from snapshot + patches
    const actor2 = new Actor("hydration-test", definition, store, "instance-2");

    const state = await actor2.inspect();
    expect(state.version).toBe(5n);
    expect((state.state as TestState).count).toBe(8);
    expect((state.state as TestState).data).toBe("after-snapshot");
  });

  it("should not snapshot when conditions are not met", async () => {
    const commitSnapshotSpy = vi.spyOn(store, "commitSnapshot");

    // Definition without snapshotEvery
    const noSnapshotDef = {
      ...definition,
      _persistence: undefined,
    };

    const actor = new Actor(
      "no-snapshot-actor",
      noSnapshotDef,
      store,
      "instance-1",
    );

    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]);

    expect(commitSnapshotSpy).not.toHaveBeenCalled();
  });

  it("should handle snapshot errors gracefully", async () => {
    const commitSnapshotSpy = vi
      .spyOn(store, "commitSnapshot")
      .mockRejectedValue(new Error("Snapshot failed"));

    const actor = new Actor("error-actor", definition, store, "instance-1");

    // Should not throw even if snapshot fails
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]); // Triggers snapshot

    expect(commitSnapshotSpy).toHaveBeenCalled();

    const state = await actor.inspect();
    expect(state.version).toBe(3n);
    expect((state.state as TestState).count).toBe(3);
  });

  it("should call metrics callback on successful snapshot", async () => {
    const onSnapshot = vi.fn();
    const metrics = { onSnapshot };

    const actor = new Actor(
      "metrics-actor",
      definition,
      store,
      "instance-1",
      undefined,
      metrics,
    );

    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]);
    await actor.handleTell("increment", [1]); // Triggers snapshot

    expect(onSnapshot).toHaveBeenCalledWith("metrics-actor", 3n);
  });
});
