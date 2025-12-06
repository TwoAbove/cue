import { describe, expect, it } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "@/api";
import { ResetError, StoppedEntityError } from "@/errors";

const Faulty = define("Faulty")
  .initialState(() => ({ n: 0 }))
  .commands({
    fail: () => {
      throw new Error("boom");
    },
    inc: (s, by = 1) => {
      s.n += by;
      return s.n;
    },
  })
  .build();

describe("Supervision strategies", () => {
  it("resume: error bubbles, entity stays healthy", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({
      definition: Faulty,
      store,
      supervisor: {
        strategy: () => "resume",
      },
    });
    const ref = manager.get("a1");

    await expect(ref.send.fail()).rejects.toThrowError("boom");
    await expect(ref.send.inc(2)).resolves.toBe(2);

    await manager.stop();
  });

  it("stop: entity enters failed state; new ref after stop works", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({
      definition: Faulty,
      store,
      supervisor: {
        strategy: (_state, _err) => "stop",
      },
    });
    const id = "stop-1";
    const ref = manager.get(id);

    await expect(ref.send.fail()).rejects.toBeInstanceOf(StoppedEntityError);
    await expect(ref.send.inc(1)).rejects.toBeInstanceOf(StoppedEntityError);

    const ref2 = manager.get(id);
    await expect(ref2.send.inc(3)).resolves.toBe(3);

    await manager.stop();
  });

  it("reset: clears persisted history and reinitializes state", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({
      definition: Faulty,
      store,
      supervisor: {
        strategy: (_state, _err) => "reset",
      },
    });
    const id = "reset-1";
    const ref = manager.get(id);

    await ref.send.inc(5);
    const state = await ref.snapshot();
    expect(state.state.n).toBe(5);

    await expect(ref.send.fail()).rejects.toBeInstanceOf(ResetError);

    const stateAfterReset = await ref.snapshot();
    expect(stateAfterReset.state.n).toBe(0);
    expect(stateAfterReset.version).toBe(0n);

    await manager.stop();
  });
});
