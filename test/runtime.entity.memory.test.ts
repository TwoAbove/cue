import { afterEach, describe, expect, it, vi } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "@/api";

const Counter = define("Counter")
  .initialState(() => ({ n: 0, history: [] as number[] }))
  .commands({
    inc: (s, by = 1) => {
      s.n += by;
      s.history.push(s.n);
      return s.n;
    },
    fail: () => {
      throw new Error("boom");
    },
    streamGrow: async function* (s, steps: number) {
      for (let i = 0; i < steps; i++) {
        s.n++;
        s.history.push(s.n);
        yield { i: i + 1, n: s.n };
      }
      return s.n;
    },
  })
  .queries({
    get: (s) => s.n,
    getHistory: (s) => [...s.history],
  })
  .persistence({ snapshotEvery: 2 })
  .build();

const newId = () => `entity-${Math.random().toString(36).slice(2)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("Entity (in-memory store)", () => {
  it("send/read/snapshot basics and mailbox ordering", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    expect(await ref.read.get()).toBe(0);
    const [a, b] = await Promise.all([ref.send.inc(1), ref.send.inc(1)]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(await ref.read.get()).toBe(2);

    const snap = await ref.snapshot();
    snap.state.n = 999;
    const snap2 = await ref.snapshot();
    expect(snap2.state.n).toBe(2);

    await manager.stop();
  });

  it("streaming: early return still runs producer to completion (detached streams)", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    let seen = 0;
    for await (const u of ref.stream.streamGrow(3)) {
      expect(u).toMatchObject({ i: 1, n: 1 });
      seen++;
      break;
    }
    expect(seen).toBe(1);

    await new Promise((r) => setTimeout(r, 10));

    expect(await ref.read.get()).toBe(3);

    const final = await ref.send.streamGrow(2);
    expect(final).toBe(5);
    expect(await ref.read.get()).toBe(5);

    await manager.stop();
  });
});
