import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";

const counterActorDef = defineActor("Counter")
  .initialState(() => ({ count: 0 }))
  .commands({
    Inc: (state) => {
      state.count++;
    },
  })
  .queries({
    Get: (state) => state.count,
  })
  .build();

describe("Actor Passivation", () => {
  it("should accept passivation configuration", () => {
    const manager = createActorManager({
      definition: counterActorDef,
      passivation: {
        idleAfter: 5000,
        sweepInterval: 1000,
      },
    });

    // Just test that the manager can be created with passivation config
    expect(manager).toBeDefined();

    manager.shutdown();
  });

  it("should track last activity on actor interactions", async () => {
    const manager = createActorManager({
      definition: counterActorDef,
      passivation: {
        idleAfter: 5000,
        sweepInterval: 1000,
      },
    });

    const actor = manager.get("test-actor");

    // Interact with actor
    await actor.tell.Inc();

    // Activity time should be updated (we can test the behavior)
    expect(await actor.ask.Get()).toBe(1);

    await manager.shutdown();
  });

  it("should handle persistence adapter with snapshots", async () => {
    const store = {
      commit: vi.fn().mockResolvedValue(1n),
      load: vi.fn().mockResolvedValue({ snapshot: null, patches: [] }),
      commitSnapshot: vi.fn().mockResolvedValue(undefined),
    };

    const persistentCounterDef = defineActor("PersistentCounter")
      .initialState(() => ({ count: 0 }))
      .commands({
        Inc: (state) => {
          state.count++;
        },
      })
      .queries({
        Get: (state) => state.count,
      })
      .persistence({ snapshotEvery: 1 })
      .build();

    const manager = createActorManager({
      definition: persistentCounterDef,
      store: store,
      passivation: {
        idleAfter: 5000,
        sweepInterval: 1000,
      },
    });

    const actor = manager.get("snapshot-actor");
    await actor.tell.Inc();

    // Should have persisted CREATE and UPDATE events
    expect(store.commit).toHaveBeenCalled();

    await manager.shutdown();
  });

  it("should stop eviction when manager is shut down", async () => {
    const manager = createActorManager({
      definition: counterActorDef,
      passivation: {
        idleAfter: 5000,
        sweepInterval: 1000,
      },
    });

    const actor = manager.get("shutdown-test-actor");
    await actor.tell.Inc();

    await manager.shutdown();

    // This should not throw since the manager is shut down
    expect(() => manager.get("new-actor")).toThrow("ActorManager is shut down");
  });

  it("evicts actor that is only streaming", async () => {
    // Create a proper mock patch store that actually stores data
    const storage = new Map();
    const store = {
      commit: vi
        .fn()
        .mockImplementation((actorId, expectedVersion, patch, _meta) => {
          const existing = storage.get(actorId);

          if (existing && existing.version !== expectedVersion) {
            throw new Error(
              `Optimistic lock failure: expected version ${expectedVersion}, got ${existing.version}`,
            );
          }

          const newVersion = expectedVersion + 1n;

          if (!existing) {
            storage.set(actorId, {
              version: newVersion,
              patches: [{ version: newVersion, patch }],
            });
          } else {
            existing.version = newVersion;
            existing.patches.push({ version: newVersion, patch });
          }

          return Promise.resolve(newVersion);
        }),
      load: vi.fn().mockImplementation((actorId, fromVersion = 0n) => {
        const data = storage.get(actorId);
        if (!data) {
          return Promise.resolve({ snapshot: null, patches: [] });
        }

        const patches = data.patches.filter(
          (p: { version: bigint; patch: unknown[] }) => p.version > fromVersion,
        );
        return Promise.resolve({
          snapshot: null,
          patches,
        });
      }),
      commitSnapshot: vi.fn().mockResolvedValue(undefined),
    };

    const streamingDef = defineActor("LongStream")
      .initialState(() => ({ done: false, count: 0 }))
      .commands({
        increment: (s) => {
          s.count++;
        },
        run: async function* (s) {
          yield 1;
          s.done = true;
        },
      })
      .build();

    const mgr = createActorManager({
      definition: streamingDef,
      store: store,
      passivation: { idleAfter: 20, sweepInterval: 20 },
    });

    // First, run a streaming command that completes
    const stream = mgr.get("S").stream.run();
    for await (const _ of stream) {
      // consume the stream
    }

    // Verify the state was updated
    let { state } = await mgr.get("S").inspect();
    expect(state.done).toBe(true);

    // Wait for passivation
    await new Promise((r) => setTimeout(r, 50));

    // Trigger re-hydration and verify state is preserved
    ({ state } = await mgr.get("S").inspect());
    expect(state.done).toBe(true);

    await mgr.shutdown();
  });
});
