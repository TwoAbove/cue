import { describe, expect, it, vi } from "vitest";
import type { ActorMetrics, PatchStore, Supervisor } from "./contracts.js";
import { createActorManager, defineActor } from "./index.js";
import { inMemoryStore } from "./store/inMemory.js";

describe("Actor Coverage Tests", () => {
  describe("Supervisor Strategies", () => {
    it("should handle resume strategy on error", async () => {
      const supervisor: Supervisor = {
        strategy: vi.fn().mockReturnValue("resume"),
      };

      const definition = defineActor("ErrorActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          increment: (state) => {
            state.counter++;
          },
          throwError: () => {
            throw new Error("Test error");
          },
        })
        .build();

      const manager = createActorManager({
        definition,
        supervisor,
      });

      const actor = manager.get("test");

      // This should trigger supervisor with resume strategy
      await expect(actor.tell.throwError()).rejects.toThrow("Test error");
      expect(supervisor.strategy).toHaveBeenCalledWith(
        { counter: 0 },
        expect.any(Error),
      );

      // Actor should still be functional after resume
      await actor.tell.increment();
      const state = await actor.inspect();
      expect(state.state.counter).toBe(1);

      await manager.shutdown();
    });

    it("should handle restart strategy on error", async () => {
      const supervisor: Supervisor = {
        strategy: vi.fn().mockReturnValue("restart"),
      };

      const definition = defineActor("RestartActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          increment: (state) => {
            state.counter++;
          },
          throwError: () => {
            throw new Error("Restart test");
          },
        })
        .build();

      const manager = createActorManager({
        definition,
        supervisor,
      });

      const actor = manager.get("restart-test");

      // Increment first
      await actor.tell.increment();
      expect((await actor.inspect()).state.counter).toBe(1);

      // Error should trigger restart, resetting state
      await expect(actor.tell.throwError()).rejects.toThrow("Restart test");

      // State should be reset after restart
      const state = await actor.inspect();
      expect(state.state.counter).toBe(0);

      await manager.shutdown();
    });

    it("should handle stop strategy on error", async () => {
      const supervisor: Supervisor = {
        strategy: vi.fn().mockReturnValue("stop"),
      };

      const definition = defineActor("StopActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          increment: (state) => {
            state.counter++;
          },
          throwError: () => {
            throw new Error("Stop test");
          },
        })
        .build();

      const manager = createActorManager({
        definition,
        supervisor,
      });

      const actor = manager.get("stop-test");

      // Error should trigger stop strategy
      await expect(actor.tell.throwError()).rejects.toThrow("Stop test");

      // Actor should be failed and unusable
      await expect(actor.tell.increment()).rejects.toThrow();

      await manager.shutdown();
    });
  });

  describe("Metrics Hooks", () => {
    it("should call all metrics hooks correctly", async () => {
      const metrics: ActorMetrics = {
        onHydrate: vi.fn(),
        onSnapshot: vi.fn(),
        onEvict: vi.fn(),
        onError: vi.fn(),
      };

      const _store: PatchStore = {
        commit: vi.fn().mockResolvedValue(1n),
        load: vi.fn().mockResolvedValue({ snapshot: null, patches: [] }),
        commitSnapshot: vi.fn().mockResolvedValue(undefined),
      };

      const supervisor: Supervisor = {
        strategy: vi.fn().mockReturnValue("stop"),
      };

      const definition = defineActor("MetricsActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          increment: (state) => {
            state.counter++;
          },
          throwError: () => {
            throw new Error("Metrics test");
          },
        })
        .persistence({ snapshotEvery: 1 })
        .build();

      const manager = createActorManager({
        definition,
        metrics,
        supervisor,
        store: inMemoryStore(),
        passivation: { idleAfter: 100, sweepInterval: 50 },
      });

      const actor = manager.get("metrics-test");

      // Trigger hydration by calling a method
      await actor.tell.increment();

      // onHydrate should be called when actor is hydrated
      expect(metrics.onHydrate).toHaveBeenCalledWith("metrics-test");

      // Trigger snapshot
      await actor.tell.increment();

      // onSnapshot should be called
      expect(metrics.onSnapshot).toHaveBeenCalledWith(
        "metrics-test",
        BigInt(1),
      );

      // Trigger error
      await expect(actor.tell.throwError()).rejects.toThrow();

      // onError should be called
      expect(metrics.onError).toHaveBeenCalledWith(
        "metrics-test",
        expect.any(Error),
      );

      // Wait for passivation to trigger onEvict (idleAfter: 100ms + sweepInterval: 50ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(metrics.onEvict).toHaveBeenCalledWith("metrics-test");

      await manager.shutdown();
    });
  });

  describe("Mailbox Queue Coverage", () => {
    it("should handle parallel tell operations correctly", async () => {
      const definition = defineActor("MailboxActor")
        .initialState(() => ({ counter: 0, operations: [] as string[] }))
        .commands({
          slowIncrement: async (state, id: string) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            state.counter++;
            state.operations.push(id);
          },
        })
        .build();

      const manager = createActorManager({ definition });
      const actor = manager.get("mailbox-test");

      // Fire multiple parallel operations
      const promises = [
        actor.tell.slowIncrement("op1"),
        actor.tell.slowIncrement("op2"),
        actor.tell.slowIncrement("op3"),
        actor.tell.slowIncrement("op4"),
        actor.tell.slowIncrement("op5"),
      ];

      await Promise.all(promises);

      const state = await actor.inspect();
      expect(state.state.counter).toBe(5);
      expect(state.state.operations).toEqual([
        "op1",
        "op2",
        "op3",
        "op4",
        "op5",
      ]);

      await manager.shutdown();
    });

    it("should handle mixed tell/ask operations in sequence", async () => {
      const definition = defineActor("MixedActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          increment: (state) => {
            state.counter++;
          },
        })
        .queries({
          getCounter: (state) => state.counter,
        })
        .build();

      const manager = createActorManager({ definition });
      const actor = manager.get("mixed-test");

      // Interleave tell and ask operations
      await actor.tell.increment();
      expect(await actor.ask.getCounter()).toBe(1);

      await actor.tell.increment();
      await actor.tell.increment();
      expect(await actor.ask.getCounter()).toBe(3);

      await manager.shutdown();
    });

    it("should handle streaming operations with mailbox", async () => {
      const definition = defineActor("StreamActor")
        .initialState(() => ({ items: [] as number[] }))
        .commands({
          addItem: (state, item: number) => {
            state.items.push(item);
          },
          generateItems: async function* (state, count: number) {
            for (let i = 0; i < count; i++) {
              state.items.push(i);
              yield i;
            }
            return state.items.length;
          },
        })
        .build();

      const manager = createActorManager({ definition });
      const actor = manager.get("stream-test");

      // Send tell operations first, then stream
      await actor.tell.addItem(100);

      // Start streaming
      const streamResults: number[] = [];
      for await (const item of actor.stream.generateItems(3)) {
        streamResults.push(item);
      }

      // Send more tell operations after streaming
      await actor.tell.addItem(200);

      expect(streamResults).toEqual([0, 1, 2]);

      const state = await actor.inspect();
      expect(state.state.items).toEqual([100, 0, 1, 2, 200]);

      await manager.shutdown();
    });
  });

  describe("Error Handling Coverage", () => {
    it("should handle errors in async commands", async () => {
      const metrics: ActorMetrics = {
        onError: vi.fn(),
      };

      const supervisor: Supervisor = {
        strategy: vi.fn().mockReturnValue("stop"),
      };

      const definition = defineActor("AsyncErrorActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          asyncError: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error("Async error");
          },
        })
        .build();

      const manager = createActorManager({ definition, metrics, supervisor });
      const actor = manager.get("async-error-test");

      await expect(actor.tell.asyncError()).rejects.toThrow("Async error");
      expect(metrics.onError).toHaveBeenCalledWith(
        "async-error-test",
        expect.any(Error),
      );

      await manager.shutdown();
    });

    it("should handle errors in streaming commands", async () => {
      const definition = defineActor("StreamErrorActor")
        .initialState(() => ({ counter: 0 }))
        .commands({
          errorStream: async function* () {
            yield 1;
            yield 2;
            throw new Error("Stream error");
          },
        })
        .build();

      const manager = createActorManager({ definition });
      const actor = manager.get("stream-error-test");

      const results = [];
      try {
        for await (const item of actor.stream.errorStream()) {
          results.push(item);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Stream error");
      }

      expect(results).toEqual([1, 2]);

      await manager.shutdown();
    });
  });
});
