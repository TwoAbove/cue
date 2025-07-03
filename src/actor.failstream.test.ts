import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";

const failStreamDef = defineActor("FailStream")
  .initialState(() => ({ count: 0, processed: [] as string[] }))
  .commands({
    async *processItems(state, items: string[], failAt?: number) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        state.count++;
        state.processed.push(item);

        yield `Processing ${item}`;

        if (failAt !== undefined && i === failAt) {
          throw new Error(`Failed at item ${i}: ${item}`);
        }
      }

      return { totalProcessed: state.count };
    },

    async *processWithMutationBeforeFailure(state, items: string[]) {
      state.count = 100; // Mutate state first
      yield "Started processing";

      for (const item of items) {
        state.processed.push(item);
        yield `Processing ${item}`;
      }

      throw new Error("Failure after mutations");
    },
  })
  .build();

describe("FailStream actor tests", () => {
  it("should propagate exceptions from streaming generators", async () => {
    const mgr = createActorManager({ definition: failStreamDef });
    const actor = mgr.get("test1");

    const items = ["a", "b", "c"];
    const stream = actor.stream.processItems(items, 1); // Fail at index 1

    const results: string[] = [];
    let error: Error | undefined;

    try {
      for await (const result of stream) {
        results.push(result);
      }
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toBe("Failed at item 1: b");
    expect(results).toEqual(["Processing a", "Processing b"]);

    await mgr.shutdown();
  });

  it("should leave actor version unchanged on streaming failure", async () => {
    const mgr = createActorManager({ definition: failStreamDef });
    const actor = mgr.get("test2");

    const initialState = await actor.inspect();
    expect(initialState.version).toBe(0n);
    expect(initialState.state.count).toBe(0);

    const items = ["x", "y"];
    const stream = actor.stream.processItems(items, 0); // Fail immediately

    let error: Error | undefined;
    try {
      for await (const _result of stream) {
        // Should not reach here
      }
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();

    const finalState = await actor.inspect();
    expect(finalState.version).toBe(0n); // Version should be unchanged
    expect(finalState.state.count).toBe(0); // State should be unchanged
    expect(finalState.state.processed).toEqual([]);

    await mgr.shutdown();
  });

  it("should not persist UPDATE on streaming failure", async () => {
    const mockStore = {
      commit: vi.fn().mockResolvedValue(1n),
      load: vi.fn().mockResolvedValue({ snapshot: null, patches: [] }),
      commitSnapshot: vi.fn().mockResolvedValue(undefined),
    };

    const mgr = createActorManager({
      definition: failStreamDef,
      store: mockStore,
    });
    const actor = mgr.get("test3");

    // Wait for initial state to be ready
    await actor.inspect();

    const items = ["p", "q"];
    const stream = actor.stream.processItems(items, 1); // Fail at index 1

    let error: Error | undefined;
    try {
      for await (const _result of stream) {
        // Process some items before failure
      }
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();

    // No commits should have been made due to failure
    expect(mockStore.commit).toHaveBeenCalledTimes(0);

    await mgr.shutdown();
  });

  it("should keep mailbox usable after streaming failure", async () => {
    const mgr = createActorManager({ definition: failStreamDef });
    const actor = mgr.get("test4");

    // First, cause a streaming failure
    const stream1 = actor.stream.processItems(["a"], 0);
    let error: Error | undefined;
    try {
      for await (const _result of stream1) {
        // Should fail immediately
      }
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();

    // Now verify the mailbox is still usable
    const stream2 = actor.stream.processItems(["b", "c"]); // No failure
    const results: string[] = [];

    for await (const result of stream2) {
      results.push(result);
    }

    expect(results).toEqual(["Processing b", "Processing c"]);

    const finalState = await actor.inspect();
    expect(finalState.state.count).toBe(2);
    expect(finalState.state.processed).toEqual(["b", "c"]);

    await mgr.shutdown();
  });

  it("should handle failure after state mutations but before final return", async () => {
    const mgr = createActorManager({ definition: failStreamDef });
    const actor = mgr.get("test5");

    const initialState = await actor.inspect();
    expect(initialState.state.count).toBe(0);

    const stream = actor.stream.processWithMutationBeforeFailure(["x", "y"]);
    const results: string[] = [];
    let error: Error | undefined;

    try {
      for await (const result of stream) {
        results.push(result);
      }
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toBe("Failure after mutations");
    expect(results).toEqual([
      "Started processing",
      "Processing x",
      "Processing y",
    ]);

    // State should remain unchanged due to failure
    const finalState = await actor.inspect();
    expect(finalState.version).toBe(0n);
    expect(finalState.state.count).toBe(0); // Should not be 100
    expect(finalState.state.processed).toEqual([]);

    await mgr.shutdown();
  });
});
