import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "./";
import type { ActorManager } from "./contracts";

describe("Actor Manager API", () => {
  const counterActorDef = defineActor("Counter")
    .initialState((): { count: number; lastUpdated?: Date } => ({
      count: 0,
    }))
    .commands({
      Increment: (state, payload: { by: number }) => {
        state.count += payload.by;
        state.lastUpdated = new Date();
      },
      Reset: (state) => {
        state.count = 0;
      },
    })
    .queries({
      GetCount: (state) => state.count,
    })
    .build();

  let counterManager: ActorManager<typeof counterActorDef>;

  beforeEach(() => {
    counterManager = createActorManager({
      definition: counterActorDef,
    });
  });

  afterEach(async () => {
    await counterManager.shutdown();
  });

  describe("Basic Actor: Counter", () => {
    it("should initialize an actor with the correct initial state and version", async () => {
      const counterActor = counterManager.get("counter-init");
      const { state, version } = await counterActor.inspect();

      expect(state.count).toBe(0);
      expect(state.lastUpdated).toBeUndefined();
      expect(version).toBe(0n);
    });

    it('should process a "tell" command with a payload and update state', async () => {
      const counterActor = counterManager.get("counter-tell");
      await counterActor.tell.Increment({ by: 10 });
      const newCount = await counterActor.ask.GetCount();
      expect(newCount).toBe(10);
      const { state, version } = await counterActor.inspect();
      expect(state.count).toBe(10);
      expect(state.lastUpdated).toBeInstanceOf(Date);
      expect(version).toBe(1n);
    });

    it('should process a "tell" command without a payload', async () => {
      const counterActor = counterManager.get("counter-reset");
      await counterActor.tell.Increment({ by: 99 });
      await counterActor.tell.Reset();
      const finalCount = await counterActor.ask.GetCount();
      expect(finalCount).toBe(0);
      expect((await counterActor.inspect()).version).toBe(2n);
    });

    it('should process an "ask" query and return the correct value', async () => {
      const counterActor = counterManager.get("counter-ask");
      await counterActor.tell.Increment({ by: 7 });
      const result = await counterActor.ask.GetCount();
      expect(result).toBe(7);
    });
  });

  describe("Error Handling", () => {
    class InsufficientFundsError extends Error {
      constructor() {
        super("Insufficient funds");
        this.name = "InsufficientFundsError";
      }
    }
    const bankActorDef = defineActor("BankAccount")
      .initialState((): { balance: number } => ({ balance: 100 }))
      .commands({
        Withdraw: (state, payload: { amount: number }) => {
          if (payload.amount > state.balance) {
            throw new InsufficientFundsError();
          }
          state.balance -= payload.amount;
        },
      })
      .build();
    let bankManager: ActorManager<typeof bankActorDef>;

    beforeEach(() => {
      bankManager = createActorManager({ definition: bankActorDef });
    });
    afterEach(async () => {
      await bankManager.shutdown();
    });

    it("should reject the promise when a command handler throws an error", async () => {
      const bankActor = bankManager.get("bank-error");
      await expect(bankActor.tell.Withdraw({ amount: 500 })).rejects.toThrow(
        "Insufficient funds",
      );
      await expect(
        bankActor.tell.Withdraw({ amount: 500 }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);
    });

    it("should not update state or version if a command handler throws", async () => {
      const bankActor = bankManager.get("bank-transaction");
      const initialState = await bankActor.inspect();
      expect(initialState.state.balance).toBe(100);
      expect(initialState.version).toBe(0n);
      await expect(bankActor.tell.Withdraw({ amount: 500 })).rejects.toThrow();
      const finalState = await bankActor.inspect();
      expect(finalState.state.balance).toBe(100);
      expect(finalState.version).toBe(0n);
    });

    it("should reject the promise when a query handler throws an error", async () => {
      const errorActorDef = defineActor("ErrorQuery")
        .initialState((): object => ({}))
        .queries({
          BadQuery: (_state) => {
            throw new Error("This query failed");
          },
        })
        .build();
      const errorManager = createActorManager({ definition: errorActorDef });
      const actor = errorManager.get("error-query");
      await expect(actor.ask.BadQuery()).rejects.toThrow("This query failed");
      await errorManager.shutdown();
    });
  });

  describe("Streaming Commands", () => {
    const storyActorDef = defineActor("StoryGenerator")
      .initialState((): { final?: string; progressUpdates: number } => ({
        progressUpdates: 0,
      }))
      .commands({
        Generate: async function* (state) {
          state.progressUpdates++;
          yield { type: "Token", value: "Once" };
          state.progressUpdates++;
          yield { type: "Token", value: "upon" };
          state.progressUpdates++;
          yield { type: "Token", value: "a time." };
          state.final = "Once upon a time.";
          return { final: "Once upon a time." };
        },
      })
      .build();

    let storyManager: ActorManager<typeof storyActorDef>;
    beforeEach(() => {
      storyManager = createActorManager({ definition: storyActorDef });
    });
    afterEach(async () => {
      await storyManager.shutdown();
    });

    it("should stream progress updates to the caller via `for await...of`", async () => {
      const storyActor = storyManager.get("story-stream");
      const stream = storyActor.stream.Generate();
      const receivedTokens: string[] = [];
      for await (const progress of stream) {
        expect(progress.type).toBe("Token");
        receivedTokens.push(progress.value);
      }
      expect(receivedTokens).toEqual(["Once", "upon", "a time."]);
    });

    it("should commit the final state update after the stream completes", async () => {
      const storyActor = storyManager.get("story-commit");
      const stream = storyActor.stream.Generate();
      for await (const _ of stream) {
        // drain stream - we just care about the final state
      }
      const { state, version } = await storyActor.inspect();
      expect(state.final).toBe("Once upon a time.");
      expect(state.progressUpdates).toBe(3);
      expect(version).toBe(1n);
    });

    it('should update state when using "tell" on a streaming command', async () => {
      const storyActor = storyManager.get("story-tell-stream");
      await storyActor.tell.Generate();
      const { state, version } = await storyActor.inspect();
      expect(state.final).toBe("Once upon a time.");
      expect(state.progressUpdates).toBe(3);
      expect(version).toBe(1n);
    });
  });

  describe("Manager-level Behavior", () => {
    it("should manage separate states for different actor instances", async () => {
      const actor1 = counterManager.get("iso-1");
      const actor2 = counterManager.get("iso-2");

      await actor1.tell.Increment({ by: 2 });
      await actor1.tell.Increment({ by: 2 });

      const state1 = await actor1.inspect();
      const state2 = await actor2.inspect();

      expect(state1.state.count).toBe(4);
      expect(state2.state.count).toBe(0);
    });

    it("should retrieve the existing state when getting a new reference to the same actor ID", async () => {
      const actor1Ref = counterManager.get("persist-1");
      await actor1Ref.tell.Increment({ by: 1 });
      const actor2Ref = counterManager.get("persist-1");
      const { state, version } = await actor2Ref.inspect();
      expect(state.count).toBe(1);
      expect(version).toBe(1n);
    });
  });

  describe("Commands with Return Values", () => {
    const returnerActorDef = defineActor("Returner")
      .initialState((): { value: number } => ({ value: 0 }))
      .commands({
        SyncAdd: (state, payload: { num: number }) => {
          state.value += payload.num;
          return state.value;
        },
        AsyncAdd: async (state, payload: { num: number }) => {
          await new Promise((res) => setTimeout(res, 10));
          state.value += payload.num;
          return state.value;
        },
        StreamAndReturn: async function* (state) {
          state.value = 10;
          yield "progress";
          state.value = 20;
          return "final-value";
        },
      })
      .build();
    let returnerManager: ActorManager<typeof returnerActorDef>;

    beforeEach(() => {
      returnerManager = createActorManager({ definition: returnerActorDef });
    });
    afterEach(async () => {
      await returnerManager.shutdown();
    });

    it("should return a value from a synchronous command", async () => {
      const actor = returnerManager.get("ret-sync");
      const result = await actor.tell.SyncAdd({ num: 5 });
      expect(result).toBe(5);
      const { state } = await actor.inspect();
      expect(state.value).toBe(5);
    });

    it("should return a value from an asynchronous command", async () => {
      const actor = returnerManager.get("ret-async");
      const result = await actor.tell.AsyncAdd({ num: 8 });
      expect(result).toBe(8);
      const { state } = await actor.inspect();
      expect(state.value).toBe(8);
    });

    it("should return a value from a streaming command via tell", async () => {
      const actor = returnerManager.get("ret-stream");
      const result = await actor.tell.StreamAndReturn();
      expect(result).toBe("final-value");
      const { state } = await actor.inspect();
      expect(state.value).toBe(20);
    });

    it("should process concurrent commands sequentially and return correct values", async () => {
      const actor = returnerManager.get("ret-concurrent");
      const promises = [
        actor.tell.SyncAdd({ num: 1 }), // returns 1
        actor.tell.SyncAdd({ num: 2 }), // returns 3
        actor.tell.SyncAdd({ num: 3 }), // returns 6
      ];

      const results = await Promise.all(promises);
      expect(results).toEqual([1, 3, 6]);

      const { state } = await actor.inspect();
      expect(state.value).toBe(6);
    });
  });
});
