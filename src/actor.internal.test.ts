import type { Operation } from "fast-json-patch";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";
import type {
  ActorManager,
  PersistedEvent,
  PersistenceAdapter,
} from "./contracts";

const createInMemoryPersistenceAdapter = () => {
  const store = new Map<
    string,
    {
      initialState: unknown;
      // Store version with patch to allow filtering.
      patches: { version: bigint; patch: Operation[] }[];
      actorDefName: string;
      snapshots: { version: bigint; state: unknown }[];
    }
  >();

  const adapter = {
    persist: vi.fn(async (event: PersistedEvent) => {
      if (event.type === "CREATE") {
        if (store.has(event.actorId)) {
          throw new Error("Actor already exists in mock store");
        }
        store.set(event.actorId, {
          initialState: superjson.parse(
            superjson.stringify(event.initialState),
          ),
          patches: [],
          snapshots: [],
          actorDefName: event.actorDefName,
        });
      } else {
        const record = store.get(event.actorId);
        if (!record) {
          throw new Error("Cannot update non-existent actor in mock store");
        }
        if (event.type === "UPDATE") {
          record.patches.push({ version: event.version, patch: event.patch });
        } else if (event.type === "SNAPSHOT") {
          record.snapshots.push({
            version: event.version,
            state: superjson.parse(superjson.stringify(event.state)),
          });
        }
      }
    }),
    load: vi.fn(async (actorId: string) => {
      const record = store.get(actorId);
      if (!record) {
        return null;
      }

      // Find the latest snapshot, if any.
      const latestSnapshot =
        record.snapshots.length > 0
          ? record.snapshots.reduce((latest, current) =>
              current.version > latest.version ? current : latest,
            )
          : null;

      if (latestSnapshot) {
        const patches = record.patches
          .filter((p) => p.version > latestSnapshot.version)
          .sort((a, b) =>
            a.version > b.version ? 1 : a.version < b.version ? -1 : 0,
          ) // Ensure order
          .map((p) => p.patch);

        return {
          baseState: superjson.parse(superjson.stringify(latestSnapshot.state)),
          baseVersion: latestSnapshot.version,
          patches,
          actorDefName: record.actorDefName,
        };
      }

      // No snapshot, use initial state.
      const patches = record.patches
        .sort((a, b) =>
          a.version > b.version ? 1 : a.version < b.version ? -1 : 0,
        )
        .map((p) => p.patch);

      return {
        baseState: superjson.parse(superjson.stringify(record.initialState)),
        baseVersion: 0n,
        patches,
        actorDefName: record.actorDefName,
      };
    }),
    clear: () => {
      store.clear();
      adapter.persist.mockClear();
      adapter.load.mockClear();
    },
  } satisfies PersistenceAdapter & { clear: () => void };

  return adapter;
};

describe("Actor Internals & Persistence", () => {
  describe("Manager-level Persistence Behavior", () => {
    it("should not increment version or persist if a command results in no state change", async () => {
      const persistenceAdapter = createInMemoryPersistenceAdapter();
      const noOpActorDef = defineActor("NoOp")
        .withInitialState((): { value: number } => ({ value: 10 }))
        .commands({
          SetValue: (state, payload: { value: number }) => {
            state.value = payload.value;
          },
        })
        .build();
      const manager = createActorManager({
        definition: noOpActorDef,
        persistence: persistenceAdapter,
      });

      const actor = manager.get("no-op-1");
      await actor.inspect(); // Create
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);

      // This command should not produce a change
      await actor.tell.SetValue({ value: 10 });

      const { state, version } = await actor.inspect();
      expect(state.value).toBe(10);
      expect(version).toBe(0n); // Version should not change

      // Persist should not have been called again
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);

      await manager.shutdown();
    });

    it("should not persist or increment version if a command replaces a Map with an identical one", async () => {
      const persistenceAdapter = createInMemoryPersistenceAdapter();
      const mapActorDef = defineActor("MapActor")
        .withInitialState((): { data: Map<string, number> } => ({
          data: new Map([["a", 1]]),
        }))
        .commands({
          UpdateMap: (state, payload: { map: Map<string, number> }) => {
            state.data = payload.map;
          },
        })
        .build();
      const manager = createActorManager({
        definition: mapActorDef,
        persistence: persistenceAdapter,
      });

      const actor = manager.get("map-1");
      await actor.inspect(); // Create
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);
      await actor.tell.UpdateMap({ map: new Map([["a", 1]]) });
      expect((await actor.inspect()).version).toBe(0n);
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);
      await manager.shutdown();
    });
  });

  // --- 5. Persistence ---
  describe("Persistence", () => {
    const persistenceAdapter = createInMemoryPersistenceAdapter();
    type PersistentCounterState = { count: number };
    const counterActorDef = defineActor("PersistentCounter")
      .withInitialState((): PersistentCounterState => ({ count: 0 }))
      .commands({
        Increment: (state, payload: { by: number }) => {
          state.count += payload.by;
        },
      })
      .build();

    let persistentManager: ActorManager<typeof counterActorDef>;

    beforeEach(() => {
      persistentManager = createActorManager({
        definition: counterActorDef,
        persistence: persistenceAdapter,
      });
    });

    afterEach(async () => {
      await persistentManager.shutdown();
      persistenceAdapter.clear();
      vi.restoreAllMocks();
    });

    it("should persist the creation of a new actor", async () => {
      const actorId = "p-actor-new";
      const actor = persistentManager.get(actorId);

      // Any async call will trigger hydration
      await actor.inspect();

      expect(persistenceAdapter.load).toHaveBeenCalledWith(actorId);
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);
      expect(persistenceAdapter.persist).toHaveBeenCalledWith({
        type: "CREATE",
        actorId: actorId,
        actorDefName: "PersistentCounter",
        initialState: { count: 0 },
      });
    });

    it("should persist state updates for an actor", async () => {
      const actorId = "p-actor-update";
      const actor = persistentManager.get(actorId);

      await actor.tell.Increment({ by: 5 });

      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(2); // CREATE, then UPDATE
      expect(persistenceAdapter.persist).toHaveBeenLastCalledWith({
        type: "UPDATE",
        actorId: actorId,
        version: 1n,
        patch: [{ op: "replace", path: "/json/count", value: 5 }],
      });

      await actor.tell.Increment({ by: 10 });
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(3);
      expect(persistenceAdapter.persist).toHaveBeenLastCalledWith({
        type: "UPDATE",
        actorId: actorId,
        version: 2n,
        patch: [{ op: "replace", path: "/json/count", value: 15 }],
      });
    });

    it("should rehydrate actor state from the persistence layer on first access", async () => {
      const actorId = "p-actor-rehydrate";

      // 1. Create a manager, perform actions, and populate the store
      const initialManager = createActorManager({
        definition: counterActorDef,
        persistence: persistenceAdapter,
      });
      const actor1 = initialManager.get(actorId);
      await actor1.tell.Increment({ by: 20 });
      await actor1.tell.Increment({ by: 2 });
      expect((await actor1.inspect()).state.count).toBe(22);
      await initialManager.shutdown();

      // 2. Create a new manager instance with the same adapter (simulates restart)
      const rehydratingManager = createActorManager({
        definition: counterActorDef,
        persistence: persistenceAdapter,
      });
      const actor2 = rehydratingManager.get(actorId);

      // 3. Verify state is loaded, not created anew
      const { state, version } = await actor2.inspect();
      expect(state.count).toBe(22); // State is restored
      expect(version).toBe(2n); // Version is restored

      // Load was called, but persist was not called again for creation
      expect(persistenceAdapter.load).toHaveBeenCalledWith(actorId);
      // CREATE + 2x UPDATE from the first manager
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(3);

      await rehydratingManager.shutdown();
    });

    it("should throw an error when trying to rehydrate with a mismatched definition", async () => {
      const actorId = "p-actor-mismatch";
      const manager1 = createActorManager({
        definition: counterActorDef,
        persistence: persistenceAdapter,
      });
      const actor1 = manager1.get(actorId);
      await actor1.inspect(); // Persist the creation

      const differentActorDef = defineActor("SomethingElse")
        .withInitialState(() => ({ value: "hello" }))
        .build();

      const manager2 = createActorManager({
        definition: differentActorDef,
        persistence: persistenceAdapter,
      });
      const actor2 = manager2.get(actorId);

      await expect(actor2.inspect()).rejects.toThrow(
        'Definition mismatch for actor "p-actor-mismatch". Stored: "PersistentCounter", Provided: "SomethingElse".',
      );

      await manager1.shutdown();
      await manager2.shutdown();
    });

    it("should persist state updates from a streaming command", async () => {
      const streamActorDef = defineActor("PersistentStreamer")
        .withInitialState((): { value: string } => ({ value: "" }))
        .commands({
          Generate: async function* (state) {
            state.value += "step1";
            yield;
            state.value += "step2";
            yield;
            state.value += "step3";
          },
        })
        .build();

      const manager = createActorManager({
        definition: streamActorDef,
        persistence: persistenceAdapter,
      });

      const actorId = "p-stream-actor";
      const actor = manager.get(actorId);

      await actor.inspect(); // CREATE
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);

      await actor.tell.Generate();

      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(2); // UPDATE
      const lastPersistCall = persistenceAdapter.persist.mock.calls[1][0];
      expect(lastPersistCall).toMatchObject({
        type: "UPDATE",
        actorId: actorId,
        version: 1n,
      });
      // Check patch content specifically to ensure the final state is what's persisted.
      if (lastPersistCall.type === "UPDATE") {
        expect(lastPersistCall.patch).toEqual([
          {
            op: "replace",
            path: "/json/value",
            value: "step1step2step3",
          },
        ]);
      }
      await manager.shutdown();
    });
  });
  // --- 6. Persistence Edge Cases ---
  describe("Persistence Edge Cases", () => {
    const persistenceAdapter = createInMemoryPersistenceAdapter();
    let manager: ActorManager<typeof counterActorDef>;
    type EdgeCaseState = { count: number };
    const counterActorDef = defineActor("PersistentCounterEdgeCase")
      .withInitialState((): EdgeCaseState => ({ count: 0 }))
      .commands({
        Increment: (state) => {
          state.count++;
        },
      })
      .queries({
        GetCount: (state) => state.count,
      })
      .build();

    beforeEach(() => {
      manager = createActorManager({
        definition: counterActorDef,
        persistence: persistenceAdapter,
      });
    });

    afterEach(async () => {
      await manager.shutdown();
      persistenceAdapter.clear();
      persistenceAdapter.persist.mockReset();
      persistenceAdapter.load.mockReset();
      vi.restoreAllMocks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("should handle persistence failure on update and not change state", async () => {
      const actorId = "p-update-fail";
      const actor = manager.get(actorId);
      await actor.inspect(); // Create successfully

      const { state: initialState, version: initialVersion } =
        await actor.inspect();
      expect(initialVersion).toBe(0n);

      // Make the next persist call fail
      const persistError = new Error("DB Update Failed");
      persistenceAdapter.persist.mockRejectedValueOnce(persistError);

      // This should reject
      await expect(actor.tell.Increment()).rejects.toThrow("DB Update Failed");

      // State and version should NOT have been updated due to transactional update
      const { state: finalState, version: finalVersion } =
        await actor.inspect();
      expect(finalState.count).toBe(initialState.count);
      expect(finalVersion).toBe(initialVersion);

      // The persist mock was called once for create, and once for the failed update
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(2);
    });

    it("should clean up and allow re-creation after hydration failure", async () => {
      const actorId = "p-re-create-fail";
      persistenceAdapter.load.mockClear();
      persistenceAdapter.persist.mockClear();

      const loadError = new Error("DB Load Failed");
      persistenceAdapter.load.mockRejectedValueOnce(loadError);

      const actor1 = manager.get(actorId);

      // First interaction fails
      await expect(actor1.inspect()).rejects.toThrow("DB Load Failed");

      // Give event loop a chance to run cleanup microtasks from the promise rejection
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Create a new ref. This should re-trigger hydration because the old one was cleaned up.
      const actor2 = manager.get(actorId);

      // Subsequent calls to load will use the default mock from the adapter, which returns null.
      // This triggers a CREATE persist call.
      await expect(actor2.inspect()).resolves.toBeDefined();

      expect(persistenceAdapter.load).toHaveBeenCalledTimes(2);
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);
      expect(persistenceAdapter.persist).toHaveBeenCalledWith(
        expect.objectContaining({ type: "CREATE", actorId }),
      );
    });
    it("should call persistence.load only once when get() is called multiple times concurrently", async () => {
      const actorId = "p-race-condition";
      // Simulate a slow load
      const slowLoad = new Promise<void>((resolve) => setTimeout(resolve, 50));
      persistenceAdapter.load.mockImplementation(async () => {
        await slowLoad;
        // Standard "not found" response to trigger creation path
        return null;
      });

      const manager = createActorManager({
        definition: counterActorDef,
        persistence: persistenceAdapter,
      });

      // Call get() multiple times without awaiting
      const actor1 = manager.get(actorId);
      const actor2 = manager.get(actorId);

      // Now interact with both, which will trigger hydration
      await expect(
        Promise.all([actor1.inspect(), actor2.inspect()]),
      ).resolves.toBeDefined();

      // load should have been called only for the first one.
      expect(persistenceAdapter.load).toHaveBeenCalledTimes(1);
      expect(persistenceAdapter.load).toHaveBeenCalledWith(actorId);

      // And persist(CREATE) should also only be called once.
      expect(persistenceAdapter.persist).toHaveBeenCalledTimes(1);
      expect(persistenceAdapter.persist).toHaveBeenCalledWith(
        expect.objectContaining({ type: "CREATE" }),
      );

      await manager.shutdown();
    });

    // --- 7. Snapshotting ---
    describe("Snapshotting", () => {
      const persistenceAdapter = createInMemoryPersistenceAdapter();
      let manager: ActorManager<typeof snapshotCounterDef>;

      const snapshotCounterDef = defineActor("SnapshotCounter")
        .withInitialState((): { count: number } => ({ count: 0 }))
        .commands({
          Inc: (state) => {
            state.count++;
          },
        })
        .persistence({
          snapshotEvery: 3, // Snapshot at versions 3, 6, 9...
        })
        .build();

      beforeEach(() => {
        manager = createActorManager({
          definition: snapshotCounterDef,
          persistence: persistenceAdapter,
        });
      });

      afterEach(async () => {
        await manager.shutdown();
        persistenceAdapter.clear();
      });

      it("should create a snapshot at the configured version interval", async () => {
        const actorId = "snap-actor-1";
        const actor = manager.get(actorId);

        // Versions 1, 2
        await actor.tell.Inc();
        await actor.tell.Inc();
        expect(persistenceAdapter.persist).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "SNAPSHOT" }),
        );

        // Version 3 - snapshot should be taken
        await actor.tell.Inc();
        expect(persistenceAdapter.persist).toHaveBeenCalledWith({
          type: "SNAPSHOT",
          actorId,
          version: 3n,
          state: { count: 3 },
        });
        const { version } = await actor.inspect();
        expect(version).toBe(3n);

        // Versions 4, 5
        persistenceAdapter.persist.mockClear();
        await actor.tell.Inc();
        await actor.tell.Inc();
        expect(persistenceAdapter.persist).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "SNAPSHOT" }),
        );
      });

      it("should not fail command if snapshot persistence fails", async () => {
        const actorId = "snap-actor-fail";
        const actor = manager.get(actorId);
        // These will use the default mock and succeed
        await actor.tell.Inc();
        await actor.tell.Inc();
        expect((await actor.inspect()).version).toBe(2n);

        // Temporarily replace persist implementation to simulate failure for snapshots
        const persistError = new Error("Snapshot Persist Failed");
        const originalPersist = persistenceAdapter.persist;
        persistenceAdapter.persist = vi.fn(async (event: PersistedEvent) => {
          if (event.type === "SNAPSHOT") throw persistError;
          return originalPersist(event);
        });

        // This call will trigger a snapshot, which we've mocked to fail.
        // The command should still succeed because snapshot errors are not critical.
        await expect(actor.tell.Inc()).resolves.toBeUndefined();

        // The actor's state and version should be updated regardless of snapshot failure.
        const { state, version } = await actor.inspect();
        expect(version).toBe(3n);
        expect(state.count).toBe(3);

        // Restore the original implementation for other tests
        persistenceAdapter.persist = originalPersist;
      });

      it("should not fail a streaming command if snapshot persistence fails", async () => {
        const snapshotStreamActorDef = defineActor("SnapshotStreamer")
          .withInitialState((): { value: number } => ({ value: 0 }))
          .commands({
            Inc: async function* (state) {
              state.value++;
              yield;
            },
          })
          .persistence({
            snapshotEvery: 2,
          })
          .build();
        const streamManager = createActorManager({
          definition: snapshotStreamActorDef,
          persistence: persistenceAdapter,
        });

        const actorId = "snap-stream-actor-fail";
        const actor = streamManager.get(actorId);
        await actor.tell.Inc(); // v1

        const persistError = new Error("Snapshot Persist Failed");
        const originalPersist = persistenceAdapter.persist;
        persistenceAdapter.persist = vi.fn(async (event: PersistedEvent) => {
          if (event.type === "SNAPSHOT") throw persistError;
          return originalPersist(event);
        });

        await expect(actor.tell.Inc()).resolves.toBeUndefined();

        const { state, version } = await actor.inspect();
        expect(version).toBe(2n);
        expect(state.value).toBe(2);

        persistenceAdapter.persist = originalPersist;
        await streamManager.shutdown();
      });

      it("should hydrate from the latest snapshot", async () => {
        const actorId = "snap-actor-2";
        const setupManager = createActorManager({
          definition: snapshotCounterDef,
          persistence: persistenceAdapter,
        });
        const actor1 = setupManager.get(actorId);
        for (let i = 0; i < 4; i++) {
          await actor1.tell.Inc(); // up to v4. Snapshot was made at v3.
        }
        await setupManager.shutdown();

        // Clear mock history before rehydrating to isolate the `load` call for the new manager.
        persistenceAdapter.load.mockClear();

        const newManager = createActorManager({
          definition: snapshotCounterDef,
          persistence: persistenceAdapter,
        });
        const actor2 = newManager.get(actorId);

        const { state, version } = await actor2.inspect();
        expect(state).toEqual({ count: 4 });
        expect(version).toBe(4n);

        // Verify that load returned the snapshot at v3 with one patch.
        // At this point, `load` has been called only once since the clear.
        expect(persistenceAdapter.load).toHaveBeenCalledTimes(1);
        const loadedData = await persistenceAdapter.load.mock.results[0].value;
        expect(loadedData).not.toBeNull();
        expect(loadedData.baseVersion).toBe(3n);
        expect(loadedData.patches.length).toBe(1);

        await newManager.shutdown();
      });

      it("should create a snapshot for a streaming command at the configured interval", async () => {
        const snapshotStreamActorDef = defineActor("SnapshotStreamer")
          .withInitialState((): { value: number } => ({ value: 0 }))
          .commands({
            Inc: async function* (state) {
              state.value++;
              yield;
            },
          })
          .persistence({
            snapshotEvery: 2,
          })
          .build();

        const streamManager = createActorManager({
          definition: snapshotStreamActorDef,
          persistence: persistenceAdapter,
        });
        const actorId = "snap-stream-actor";
        const actor = streamManager.get(actorId);

        await actor.tell.Inc(); // v1
        const hasSnapshotCall1 = persistenceAdapter.persist.mock.calls.some(
          (call) => call[0].type === "SNAPSHOT",
        );
        expect(hasSnapshotCall1).toBe(false);

        await actor.tell.Inc(); // v2, snapshot should be taken

        expect(persistenceAdapter.persist).toHaveBeenCalledWith({
          type: "SNAPSHOT",
          actorId,
          version: 2n,
          state: { value: 2 },
        });
        await streamManager.shutdown();
      });
    });

    it("should reject actor interaction if persistence.load fails", async () => {
      const loadError = new Error("DB Load Failed");
      persistenceAdapter.load.mockImplementation(() =>
        Promise.reject(loadError),
      );
      const actor = manager.get("p-load-fail");

      await expect(actor.inspect()).rejects.toThrow("DB Load Failed");
      await expect(actor.ask.GetCount()).rejects.toThrow("DB Load Failed");

      expect(persistenceAdapter.persist).not.toHaveBeenCalled();
    });

    it("should reject actor interaction if persistence.persist on create fails", async () => {
      const persistError = new Error("DB Persist Failed");
      persistenceAdapter.load.mockImplementation(async () => null);
      persistenceAdapter.persist.mockImplementation(async () =>
        Promise.reject(persistError),
      );

      const actor = manager.get("p-persist-fail");

      await expect(actor.inspect()).rejects.toThrow("DB Persist Failed");
      await expect(actor.ask.GetCount()).rejects.toThrow("DB Persist Failed");

      expect(persistenceAdapter.persist).toHaveBeenCalled();
    });
  });
});

describe("Internal Error Scenarios", () => {
  const counterActorDef = defineActor("CounterInternal")
    .withInitialState(() => ({ count: 0 }))
    .build();

  it("should throw an internal error if the container is missing unexpectedly", async () => {
    const manager = createActorManager({ definition: counterActorDef });
    const actor = manager.get("internal-error-actor");

    const spy = vi.spyOn(Map.prototype, "get");
    spy.mockReturnValue(undefined);

    await expect(actor.inspect()).rejects.toThrow(
      'Internal error: actor with id "internal-error-actor" not found.',
    );

    // Restore the original Map.prototype.get to not affect other tests
    spy.mockRestore();

    await manager.shutdown();
  });
});
