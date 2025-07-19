import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";

const counterDef = defineActor("Counter")
  .initialState(() => ({ count: 0 }))
  .commands({
    increment: (state, amount = 1) => {
      state.count += amount;
      return state.count;
    },
    slowIncrement: async (state, amount = 1) => {
      await new Promise((res) => setTimeout(res, 5));
      state.count += amount;
      return state.count;
    },
    reset: (state) => {
      state.count = 0;
    },
    generate: async function* (state, limit: number) {
      for (let i = 1; i <= limit; i++) {
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

describe("Core API & Mailbox", () => {
  describe("Actor Initialization and State", () => {
    it("should initialize an actor with the correct initial state and version 0", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("init-test");
      const { state, version } = await actor.inspect();

      expect(state.count).toBe(0);
      expect(version).toBe(0n);
      await manager.terminate();
    });
  });

  describe("tell (Commands)", () => {
    it("should process a 'tell' command, update state, and increment version", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("tell-test");

      await actor.tell.increment(10);

      const { state, version } = await actor.inspect();
      expect(state.count).toBe(10);
      expect(version).toBe(1n);

      await manager.terminate();
    });

    it("should return the command's return value", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("tell-return-test");

      const result = await actor.tell.increment(5);
      expect(result).toBe(5);

      await manager.terminate();
    });
  });

  describe("ask (Queries)", () => {
    it("should process an 'ask' query and return a value without changing state", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("ask-test");
      await actor.tell.increment(7);

      const result = await actor.ask.getCount();
      expect(result).toBe(7);

      const { version } = await actor.inspect();
      expect(version).toBe(1n);

      await manager.terminate();
    });
  });

  describe("stream (Streaming Commands)", () => {
    it("should stream progress updates via `for await...of`", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("stream-test");
      const stream = actor.stream.generate(3);
      const received: number[] = [];

      for await (const progress of stream) {
        received.push(progress);
      }

      expect(received).toEqual([1, 2, 3]);

      await manager.terminate();
    });

    it("should commit the final state update after the stream completes", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("stream-commit-test");
      const stream = actor.stream.generate(3);

      for await (const _ of stream) {
        // drain
      }

      const { state, version } = await actor.inspect();
      expect(state.count).toBe(3);
      expect(version).toBe(1n);

      await manager.terminate();
    });

    it("should return the final value when using `tell` on a streaming command", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("stream-tell-test");

      const result = await actor.tell.generate(5);
      expect(result).toBe(5);

      const { state, version } = await actor.inspect();
      expect(state.count).toBe(5);
      expect(version).toBe(1n);

      await manager.terminate();
    });
  });

  describe("Command Error Handling", () => {
    it("should not update state or version if a command handler throws an error", async () => {
      const errorDef = defineActor("ErrorActor")
        .initialState(() => ({ balance: 100 }))
        .commands({
          withdraw: (state, amount: number) => {
            if (amount > state.balance) {
              throw new Error("Insufficient funds");
            }
            state.balance -= amount;
          },
        })
        .build();
      const manager = createActorManager({ definition: errorDef });
      const actor = manager.get("error-test");

      const { state: initialState, version: initialVersion } =
        await actor.inspect();
      expect(initialState.balance).toBe(100);
      expect(initialVersion).toBe(0n);

      await expect(actor.tell.withdraw(500)).rejects.toThrow(
        "Insufficient funds",
      );

      const { state: finalState, version: finalVersion } =
        await actor.inspect();
      expect(finalState.balance).toBe(100);
      expect(finalVersion).toBe(0n);

      await manager.terminate();
    });
  });

  describe("Mailbox Behavior", () => {
    it("should process concurrent commands sequentially and in order", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("mailbox-test");

      const p1 = actor.tell.slowIncrement(1);
      const p2 = actor.tell.slowIncrement(2);
      const p3 = actor.tell.slowIncrement(3);

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual([1, 3, 6]);

      const { state } = await actor.inspect();
      expect(state.count).toBe(6);

      await manager.terminate();
    });

    it("should process interleaved tell and ask operations correctly", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("mailbox-interleave-test");

      await actor.tell.increment(1);
      expect(await actor.ask.getCount()).toBe(1);

      await actor.tell.increment(2);
      await actor.tell.increment(3);
      expect(await actor.ask.getCount()).toBe(6);

      await manager.terminate();
    });

    it("should process 1000 tells in order under stress", async () => {
      vi.useFakeTimers();
      const manager = createActorManager({ definition: counterDef });
      const actor = manager.get("stress-test");

      const promises = [...Array(1000).keys()].map(() =>
        actor.tell.increment(1),
      );
      vi.runAllTimers();
      await Promise.all(promises);

      expect((await actor.inspect()).state.count).toBe(1000);

      await manager.terminate();
      vi.useRealTimers();
    });
  });

  describe("Manager Behavior", () => {
    it("should manage separate states for actors with different IDs", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actor1 = manager.get("actor-1");
      const actor2 = manager.get("actor-2");

      await actor1.tell.increment(5);
      await actor2.tell.increment(10);

      expect((await actor1.inspect()).state.count).toBe(5);
      expect((await actor2.inspect()).state.count).toBe(10);

      await manager.terminate();
    });

    it("should retrieve the same actor instance for the same ID", async () => {
      const manager = createActorManager({ definition: counterDef });
      const actorRef1 = manager.get("shared-actor");
      await actorRef1.tell.increment(1);

      const actorRef2 = manager.get("shared-actor");
      await actorRef2.tell.increment(1);

      expect((await actorRef1.inspect()).state.count).toBe(2);
      expect((await actorRef2.inspect()).state.count).toBe(2);

      await manager.terminate();
    });
  });
});
