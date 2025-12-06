import { describe, expect, it, vi } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "@/api";

const Simple = define("Simple")
  .initialState(() => ({ n: 0 }))
  .commands({
    inc: (s) => {
      return ++s.n;
    },
  })
  .persistence({ snapshotEvery: 1 })
  .build();

describe("Passivation", () => {
  it("evicts idle entities and allows transparent rehydration later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const store = new InMemoryPersistenceAdapter();
    const evicted: string[] = [];

    const manager = create({
      definition: Simple,
      store,
      passivation: {
        idleAfter: 50, // ms
        sweepInterval: 10, // ms
      },
      metrics: {
        onEvict: (id) => evicted.push(id),
      },
    });

    const id = "p-1";
    const ref = manager.get(id);
    await ref.send.inc(); // touch

    // advance beyond idleAfter and let sweeper run
    await vi.advanceTimersByTimeAsync(60);

    expect(evicted).toContain(id);
    await expect(ref.send.inc()).resolves.toBe(2);

    await manager.stop();
    vi.useRealTimers();
  });
});
