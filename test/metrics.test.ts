import { describe, expect, it, vi } from "vitest";
import type { ActorMetrics, Supervisor } from "../src/contracts";
import { createActorManager, defineActor } from "../src/index";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";

describe("Metrics Hooks", () => {
  it("should call all metrics hooks at the correct lifecycle points", async () => {
    const metrics: ActorMetrics = {
      onHydrate: vi.fn(),
      onSnapshot: vi.fn(),
      onEvict: vi.fn(),
      onError: vi.fn(),
      onAfterCommit: vi.fn(),
    };

    const supervisor: Supervisor = {
      strategy: (_state, _error) => "resume",
    };

    const errorToThrow = new Error("Metrics test error");
    const metricsDef = defineActor("MetricsTest")
      .initialState(() => ({ value: 0 }))
      .persistence({ snapshotEvery: 2 })
      .commands({
        increment: (state) => {
          state.value++;
        },
        throwError: () => {
          throw errorToThrow;
        },
      })
      .build();

    const manager = createActorManager({
      definition: metricsDef,
      metrics,
      supervisor,
      store: inMemoryPersistenceAdapter(),
      passivation: { idleAfter: 50, sweepInterval: 25 },
    });

    const actorId = "metrics-actor";
    const actor = manager.get(actorId);

    await actor.tell.increment();
    expect(metrics.onHydrate).toHaveBeenCalledWith(actorId);
    expect(metrics.onHydrate).toHaveBeenCalledTimes(1);

    expect(metrics.onAfterCommit).toHaveBeenCalledWith(
      actorId,
      1n,
      expect.any(Array),
    );
    expect(metrics.onAfterCommit).toHaveBeenCalledTimes(1);

    await actor.tell.increment();
    expect(metrics.onSnapshot).toHaveBeenCalledWith(actorId, 2n);
    expect(metrics.onSnapshot).toHaveBeenCalledTimes(1);
    expect(metrics.onAfterCommit).toHaveBeenCalledTimes(2);

    await expect(actor.tell.throwError()).rejects.toThrow(errorToThrow);
    expect(metrics.onError).toHaveBeenCalledWith(actorId, errorToThrow);
    expect(metrics.onError).toHaveBeenCalledTimes(1);
    expect(metrics.onAfterCommit).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(metrics.onEvict).toHaveBeenCalledWith(actorId);
    expect(metrics.onEvict).toHaveBeenCalledTimes(1);

    await manager.terminate();
  });
});
