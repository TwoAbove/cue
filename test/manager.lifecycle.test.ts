import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

const testDef = defineActor("LifecycleTest")
  .initialState(() => ({ count: 0 }))
  .commands({
    inc: (state) => {
      state.count++;
    },
    slowInc: async (state) => {
      await new Promise((res) => setTimeout(res, 10));
      state.count++;
      return state.count;
    },
  })
  .queries({
    get: (state) => state.count,
  })
  .build();

describe("Manager and Actor Lifecycle", () => {
  describe("Actor Shutdown", () => {
    it("should remove the actor from memory, requiring rehydration on next get", async () => {
      const store = inMemoryPersistenceAdapter();
      const manager = createActorManager({ definition: testDef, store });
      const actor = manager.get("actor-shutdown-1");

      await actor.tell.inc();
      expect(await actor.ask.get()).toBe(1);

      await actor.terminate();

      // Getting a new ref should re-create the actor from the store's initial state
      const newActorRef = manager.get("actor-shutdown-1");
      expect(await newActorRef.ask.get()).toBe(1);

      await manager.terminate();
    });

    it("should reject messages sent to a terminated actor reference", async () => {
      const manager = createActorManager({ definition: testDef });
      const actor = manager.get("actor-shutdown-2");

      await actor.terminate();

      await expect(actor.tell.inc()).rejects.toThrow(
        "Actor actor-shutdown-2 is shutting down. Further messages are rejected.",
      );
    });
  });

  describe("Manager Shutdown", () => {
    it("should reject all interactions after manager.terminate() is called", async () => {
      const manager = createActorManager({ definition: testDef });
      const actor = manager.get("manager-shutdown-1");
      await actor.tell.inc();

      await manager.terminate();

      const expectedError =
        "ActorManager is shut down. Cannot interact with actors.";
      await expect(actor.tell.inc()).rejects.toThrow(expectedError);
      await expect(actor.ask.get()).rejects.toThrow(expectedError);
    });

    it("should prevent new actors from being retrieved after shutdown", async () => {
      const manager = createActorManager({ definition: testDef });
      await manager.terminate();

      expect(() => manager.get("new-actor")).toThrow(
        "ActorManager is shut down. Cannot create new actors.",
      );
    });

    it("should be idempotent and not throw on subsequent calls", async () => {
      const manager = createActorManager({ definition: testDef });
      await manager.terminate();
      await expect(manager.terminate()).resolves.toBeUndefined();
    });
  });

  describe("Resource Cleanup", () => {
    let setIntervalSpy: MockInstance;
    let clearIntervalSpy: MockInstance;

    beforeEach(() => {
      setIntervalSpy = vi.spyOn(global, "setInterval");
      clearIntervalSpy = vi.spyOn(global, "clearInterval");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should clean up passivation timer on manager shutdown", async () => {
      const manager = createActorManager({
        definition: testDef,
        passivation: { idleAfter: 100, sweepInterval: 10 },
      });
      manager.get("cleanup-1");

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      await manager.terminate();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it("should drain the mailbox of pending tasks before shutting down", async () => {
      const manager = createActorManager({ definition: testDef });
      const actor = manager.get("drain-test");

      const promises = [
        actor.tell.slowInc(),
        actor.tell.slowInc(),
        actor.tell.slowInc(),
      ];

      const shutdownPromise = manager.terminate();

      const results = await Promise.all(promises);
      expect(results).toEqual([1, 2, 3]);

      await shutdownPromise;
    });

    it("should ensure persisted state is not lost on shutdown", async () => {
      const store = inMemoryPersistenceAdapter();
      const manager1 = createActorManager({ definition: testDef, store });
      const actor1 = manager1.get("persist-shutdown");
      await actor1.tell.inc();
      await manager1.terminate();

      const manager2 = createActorManager({ definition: testDef, store });
      const actor2 = manager2.get("persist-shutdown");
      const { state } = await actor2.inspect();
      expect(state.count).toBe(1);

      await manager2.terminate();
    });
  });
});
