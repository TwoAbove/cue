import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import { InMemoryPersistenceAdapter } from "../src/store/inMemory";

const testDef = defineActor("PassivationTest")
  .initialState(() => ({ count: 0 }))
  .commands({
    inc: (s) => s.count++,
  })
  .queries({
    get: (s) => s.count,
  })
  .build();

describe("Actor Passivation", () => {
  let store: InMemoryPersistenceAdapter;

  beforeEach(() => {
    store = new InMemoryPersistenceAdapter();
  });

  it("should passivate an idle actor, which is then rehydrated on next message", async () => {
    const metrics = { onEvict: vi.fn(), onHydrate: vi.fn() };
    const manager = createActorManager({
      definition: testDef,
      store,
      metrics,
      passivation: { idleAfter: 20, sweepInterval: 10 },
    });
    const actorId = "actor-1";
    let actor = manager.get(actorId);

    await actor.tell.inc();
    expect(await actor.ask.get()).toBe(1);
    expect(metrics.onHydrate).toHaveBeenCalledTimes(1);
    expect(metrics.onEvict).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 50));

    expect(metrics.onEvict).toHaveBeenCalledWith(actorId);
    expect(metrics.onEvict).toHaveBeenCalledTimes(1);

    actor = manager.get(actorId);
    expect(await actor.ask.get()).toBe(1);
    expect(metrics.onHydrate).toHaveBeenCalledTimes(2);

    await manager.terminate();
  });

  it("should take a final snapshot before passivation if configured", async () => {
    const commitSnapshotSpy = vi.spyOn(store, "commitSnapshot");

    const snapshotDef = defineActor("PassivationSnapshotTest")
      .initialState(() => ({ count: 0 }))
      .commands({ inc: (s) => s.count++ })
      .persistence({ snapshotEvery: 5 })
      .build();

    const manager = createActorManager({
      definition: snapshotDef,
      store,
      passivation: { idleAfter: 20, sweepInterval: 10 },
    });

    const actor = manager.get("actor-2");
    await actor.tell.inc();

    await new Promise((r) => setTimeout(r, 50));

    expect(commitSnapshotSpy).toHaveBeenCalledWith(
      "actor-2",
      1n,
      expect.any(String),
    );

    await manager.terminate();
  });

  it("should not passivate an actor that is not idle", async () => {
    const metrics = { onEvict: vi.fn() };
    const manager = createActorManager({
      definition: testDef,
      store,
      metrics,
      passivation: { idleAfter: 50, sweepInterval: 10 },
    });
    const actor = manager.get("actor-3");

    // Keep touching the actor so it never becomes idle
    const interval = setInterval(() => {
      actor.tell.inc();
    }, 20);

    // Wait for a few sweep cycles
    await new Promise((r) => setTimeout(r, 100));

    clearInterval(interval);
    expect(metrics.onEvict).not.toHaveBeenCalled();

    await manager.terminate();
  });
});
