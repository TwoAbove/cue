import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Supervisor } from "./contracts.js";
import { createActorManager, defineActor } from "./index.js";
import { inMemoryStore } from "./store/inMemory.js";

describe("Actor restart behavior", () => {
  let store: ReturnType<typeof inMemoryStore>;

  beforeEach(() => {
    store = inMemoryStore();
  });

  it("should prevent optimistic lock failure after restart", async () => {
    const supervisor: Supervisor = {
      strategy: vi.fn().mockReturnValue("reset"),
    };

    const definition = defineActor("RestartVersionTest")
      .initialState(() => ({ counter: 0 }))
      .commands({
        increment: (state) => {
          state.counter++;
        },
        throwError: () => {
          throw new Error("Test restart");
        },
      })
      .build();

    const manager = createActorManager({
      definition,
      supervisor,
      store,
    });

    const actor = manager.get("restart-version-test");

    // Increment to create some state
    await actor.tell.increment();
    await actor.tell.increment();
    expect((await actor.inspect()).state.counter).toBe(2);

    // Trigger restart
    await expect(actor.tell.throwError()).rejects.toThrow("Test restart");

    // State should be reset after restart
    expect((await actor.inspect()).state.counter).toBe(0);

    // This should not cause optimistic lock failure
    await actor.tell.increment();
    expect((await actor.inspect()).state.counter).toBe(1);

    await manager.shutdown();
  });

  it("should handle multiple operations after reset without lock failures", async () => {
    const supervisor: Supervisor = {
      strategy: vi.fn().mockReturnValue("reset"),
    };

    const definition = defineActor("MultiOpResetTest")
      .initialState(() => ({ counter: 0 }))
      .commands({
        increment: (state) => {
          state.counter++;
        },
        throwError: () => {
          throw new Error("Multi-op restart test");
        },
      })
      .build();

    const manager = createActorManager({
      definition,
      supervisor,
      store,
    });

    const actor = manager.get("multi-op-restart-test");

    // Build up some state
    await actor.tell.increment();
    await actor.tell.increment();
    await actor.tell.increment();
    expect((await actor.inspect()).state.counter).toBe(3);

    // Trigger restart
    await expect(actor.tell.throwError()).rejects.toThrow(
      "Multi-op restart test",
    );

    // State should be reset
    expect((await actor.inspect()).state.counter).toBe(0);

    // Multiple operations should work without optimistic lock failures
    await actor.tell.increment();
    expect((await actor.inspect()).state.counter).toBe(1);

    await actor.tell.increment();
    expect((await actor.inspect()).state.counter).toBe(2);

    await actor.tell.increment();
    expect((await actor.inspect()).state.counter).toBe(3);

    await manager.shutdown();
  });
});
