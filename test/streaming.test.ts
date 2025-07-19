import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

const streamDef = defineActor("Streamer")
  .initialState(() => ({ items: [] as string[] }))
  .commands({
    process: async function* (state, items: string[], failAt?: string) {
      for (const item of items) {
        state.items.push(item);
        yield `Processed ${item}`;
        if (item === failAt) {
          throw new Error(`Failed at ${item}`);
        }
      }
      return `Completed ${items.length} items.`;
    },
  })
  .build();

describe("Streaming Commands", () => {
  it("should propagate exceptions from the generator to the caller", async () => {
    const manager = createActorManager({ definition: streamDef });
    const actor = manager.get("stream-fail-1");
    const stream = actor.stream.process(["A", "B", "C"], "B");
    const results: string[] = [];
    let error: Error | undefined;

    try {
      for await (const result of stream) {
        results.push(result);
      }
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("Failed at B");
    expect(results).toEqual(["Processed A", "Processed B"]);

    await manager.terminate();
  });

  it("should roll back all state changes if the stream fails", async () => {
    const manager = createActorManager({ definition: streamDef });
    const actor = manager.get("stream-fail-2");
    const { state: initialState, version: initialVersion } =
      await actor.inspect();
    expect(initialState.items).toEqual([]);
    expect(initialVersion).toBe(0n);

    const stream = actor.stream.process(["A", "B", "C"], "C");
    try {
      for await (const _ of stream) {
        // drain
      }
    } catch {
      // ignore error
    }

    const { state: finalState, version: finalVersion } = await actor.inspect();
    expect(finalState.items).toEqual([]);
    expect(finalVersion).toBe(0n);

    await manager.terminate();
  });

  it("should not commit to persistence if the stream fails", async () => {
    const store = inMemoryPersistenceAdapter();
    const commitSpy = vi.spyOn(store, "commitEvent");
    const manager = createActorManager({ definition: streamDef, store });
    const actor = manager.get("stream-fail-3");
    const stream = actor.stream.process(["A", "B"], "B");

    try {
      for await (const _ of stream) {
        // drain
      }
    } catch {
      // ignore error
    }

    expect(commitSpy).not.toHaveBeenCalled();
    await manager.terminate();
  });

  it("should keep the actor and its mailbox usable after a stream failure", async () => {
    const manager = createActorManager({ definition: streamDef });
    const actor = manager.get("stream-fail-4");

    const stream1 = actor.stream.process(["A", "B"], "A");
    await expect(async () => {
      for await (const _ of stream1) {
      }
    }).rejects.toThrow("Failed at A");

    const returnValue = await actor.tell.process(["C", "D"]);
    expect(returnValue).toBe("Completed 2 items.");

    const { state } = await actor.inspect();
    expect(state.items).toEqual(["C", "D"]);

    await manager.terminate();
  });
});
