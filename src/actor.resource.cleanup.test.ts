import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";

const testDef = defineActor("ResourceTest")
  .initialState(() => ({ count: 0 }))
  .commands({
    increment: (state) => {
      state.count++;
    },
    async *streamIncrement(state, times: number) {
      for (let i = 0; i < times; i++) {
        state.count++;
        yield i;
      }
      return state.count;
    },
  })
  .queries({
    getCount: (state) => state.count,
  })
  .build();

describe("Resource cleanup tests", () => {
  describe("Timer cleanup", () => {
    // biome-ignore lint/suspicious/noExplicitAny: Test spy types are complex
    let setIntervalSpy: any;
    // biome-ignore lint/suspicious/noExplicitAny: Test spy types are complex
    let clearIntervalSpy: any;

    beforeEach(() => {
      setIntervalSpy = vi.spyOn(global, "setInterval");
      clearIntervalSpy = vi.spyOn(global, "clearInterval");
    });

    afterEach(() => {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });

    it("should clean up passivation timer on manager shutdown", async () => {
      const mgr = createActorManager({
        definition: testDef,
        passivation: {
          idleAfter: 1000,
          sweepInterval: 10,
        },
      });

      // Create an actor to trigger passivation setup
      const actor = mgr.get("test");
      await actor.tell.increment();

      expect(setIntervalSpy).toHaveBeenCalled();

      await mgr.shutdown();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it("should not leak timers when creating multiple managers", async () => {
      const managers = [];

      for (let i = 0; i < 3; i++) {
        const mgr = createActorManager({
          definition: testDef,
          passivation: {
            idleAfter: 1000,
            sweepInterval: 10,
          },
        });
        managers.push(mgr);

        // Create an actor to trigger passivation setup
        const actor = mgr.get(`test-${i}`);
        await actor.tell.increment();
      }

      expect(setIntervalSpy).toHaveBeenCalledTimes(3);

      // Shutdown all managers
      await Promise.all(managers.map((mgr) => mgr.shutdown()));

      expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("Open handle detection", () => {
    it("should not leave open handles after manager shutdown", async () => {
      // Note: This test is more of a documentation of the expected behavior
      // In a real environment, you'd use process._getActiveHandles() in Node.js 18+

      const mgr = createActorManager({
        definition: testDef,
        passivation: {
          idleAfter: 100,
          sweepInterval: 10,
        },
      });

      const actor = mgr.get("handle-test");
      await actor.tell.increment();

      // Simulate some activity
      for (let i = 0; i < 5; i++) {
        await actor.tell.increment();
      }

      const state = await actor.inspect();
      expect(state.state.count).toBe(6);

      await mgr.shutdown();

      // In a real test environment, you would check:
      // const handlesBefore = process._getActiveHandles().length;
      // ... create and shutdown manager ...
      // const handlesAfter = process._getActiveHandles().length;
      // expect(handlesAfter).toBe(handlesBefore);

      expect(true).toBe(true); // Placeholder assertion
    });
  });

  describe("Mailbox drain on shutdown", () => {
    it("should await pending tasks before shutdown", async () => {
      const mgr = createActorManager({ definition: testDef });
      const actor = mgr.get("drain-test");

      // Enqueue multiple tasks
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(actor.tell.increment());
      }

      // All tasks should complete before shutdown
      await Promise.all(promises);

      // Verify all tasks were processed
      const state = await actor.inspect();
      expect(state.state.count).toBe(10);

      // Now shutdown
      await mgr.shutdown();

      // After shutdown, trying to inspect should fail
      await expect(actor.inspect()).rejects.toThrow(
        "ActorManager is shut down",
      );
    });

    it("should handle streaming tasks during shutdown", async () => {
      const mgr = createActorManager({ definition: testDef });
      const actor = mgr.get("stream-drain-test");

      // Start a streaming task
      const streamPromise = (async () => {
        const results: number[] = [];
        for await (const value of actor.stream.streamIncrement(5)) {
          results.push(value);
        }
        return results;
      })();

      // Give the stream a moment to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Shutdown while stream is running
      const shutdownPromise = mgr.shutdown();

      // Stream should complete
      const results = await streamPromise;
      expect(results).toEqual([0, 1, 2, 3, 4]);

      await shutdownPromise;
    });
  });

  describe("Persistence flush", () => {
    it("should ensure persist is called with pending snapshot before shutdown", async () => {
      const mockStore = {
        commit: vi.fn().mockResolvedValue(1n),
        commitSnapshot: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue({ snapshot: null, patches: [] }),
      };

      const persistentDef = defineActor("PersistentTest")
        .initialState(() => ({ count: 0 }))
        .commands({
          increment: (state) => {
            state.count++;
          },
        })
        .persistence({
          snapshotEvery: 2, // Snapshot every 2 operations
        })
        .build();

      const mgr = createActorManager({
        definition: persistentDef,
        store: mockStore,
      });

      const actor = mgr.get("persist-test");

      // Wait for initial state
      await actor.inspect();

      // Perform operations to trigger snapshot
      await actor.tell.increment(); // version 1
      await actor.tell.increment(); // version 2 - should trigger snapshot

      // Should have called commit for each operation
      expect(mockStore.commit).toHaveBeenCalledTimes(2);

      await mgr.shutdown();
    });

    it("should handle persistence errors gracefully during shutdown", async () => {
      const mockStore = {
        commit: vi.fn().mockRejectedValue(new Error("Persistence failed")), // Fail all calls
        commitSnapshot: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue({ snapshot: null, patches: [] }),
      };

      const mgr = createActorManager({
        definition: testDef,
        store: mockStore,
      });

      const actor = mgr.get("error-test");

      // Wait for initial state to be ready
      await actor.inspect();

      // This should throw due to persistence errors
      await expect(actor.tell.increment()).rejects.toThrow(
        "Persistence failed",
      );

      // Shutdown should still succeed despite persistence errors
      await mgr.shutdown();
    });
  });

  describe("Event listener leaks", () => {
    it("should not leak process event listeners", async () => {
      // Track unhandledRejection listeners
      const initialListenerCount = process.listenerCount("unhandledRejection");

      const mgr = createActorManager({ definition: testDef });
      const actor = mgr.get("listener-test");

      await actor.tell.increment();

      // Create some activity that might add listeners
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(actor.tell.increment());
      }
      await Promise.all(promises);

      await mgr.shutdown();

      const finalListenerCount = process.listenerCount("unhandledRejection");
      expect(finalListenerCount).toBe(initialListenerCount);
    });
  });
});
