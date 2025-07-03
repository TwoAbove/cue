import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchStore } from "./contracts.js";
import { createActorManager, defineActor } from "./index.js";

describe("Actor hydration lock management", () => {
  let mockStore: PatchStore;
  let acquireSpy: ReturnType<typeof vi.fn>;
  let releaseSpy: ReturnType<typeof vi.fn>;
  let loadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    acquireSpy = vi.fn().mockResolvedValue(true);
    releaseSpy = vi.fn().mockResolvedValue(undefined);
    loadSpy = vi.fn();

    mockStore = {
      commit: vi.fn().mockResolvedValue(1n),
      load: loadSpy,
      acquire: acquireSpy,
      commitSnapshot: vi.fn(),
      release: releaseSpy,
    };
  });

  it("should release lock when hydration fails during load", async () => {
    // Make load throw an error
    loadSpy.mockRejectedValue(new Error("Load failed"));

    const definition = defineActor("HydrationLockTest")
      .initialState(() => ({ value: "test" }))
      .commands({
        setValue: (state, value: string) => {
          state.value = value;
        },
      })
      .build();

    const manager = createActorManager({
      definition,
      store: mockStore,
    });

    const actor = manager.get("hydration-lock-test");

    // Try to interact with the actor, which should trigger hydration
    await expect(actor.tell.setValue("new-value")).rejects.toThrow(
      "Load failed",
    );

    // Verify that acquire was called
    expect(acquireSpy).toHaveBeenCalledWith(
      "hydration-lock-test",
      expect.any(String),
      30000,
    );

    // Verify that release was called even though hydration failed
    expect(releaseSpy).toHaveBeenCalledWith(
      "hydration-lock-test",
      expect.any(String),
    );

    await manager.shutdown();
  });

  it("should release lock when hydration fails during state processing", async () => {
    // Make load function throw an error during hydration
    loadSpy.mockRejectedValue(new Error("Load failed during hydration"));

    const definition = defineActor("HydrationStateTest")
      .initialState(() => ({ value: "test" }))
      .commands({
        setValue: (state, value: string) => {
          state.value = value;
        },
      })
      .build();

    const manager = createActorManager({
      definition,
      store: mockStore,
    });

    const actor = manager.get("hydration-state-test");

    try {
      // Try to interact with the actor, which should trigger hydration
      await expect(actor.tell.setValue("new-value")).rejects.toThrow();

      // Verify that acquire was called
      expect(acquireSpy).toHaveBeenCalledWith(
        "hydration-state-test",
        expect.any(String),
        30000,
      );

      // Verify that release was called even though hydration failed
      expect(releaseSpy).toHaveBeenCalledWith(
        "hydration-state-test",
        expect.any(String),
      );
    } finally {
      // Restore original function - vitest automatically restores spies
      await manager.shutdown();
    }
  });

  it("should not call release if acquire failed", async () => {
    // Make acquire fail
    acquireSpy.mockResolvedValue(false);

    const definition = defineActor("AcquireFailTest")
      .initialState(() => ({ value: "test" }))
      .commands({
        setValue: (state, value: string) => {
          state.value = value;
        },
      })
      .build();

    const manager = createActorManager({
      definition,
      store: mockStore,
    });

    const actor = manager.get("acquire-fail-test");

    // Try to interact with the actor, which should trigger hydration
    await expect(actor.tell.setValue("new-value")).rejects.toThrow(
      "Failed to acquire lock",
    );

    // Verify that acquire was called
    expect(acquireSpy).toHaveBeenCalledWith(
      "acquire-fail-test",
      expect.any(String),
      30000,
    );

    // Verify that release was NOT called since acquire failed
    expect(releaseSpy).not.toHaveBeenCalled();

    await manager.shutdown();
  });
});
