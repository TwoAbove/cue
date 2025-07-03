import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";

const def = defineActor("Stress")
  .initialState(() => ({ c: 0 }))
  .commands({
    add: (s, n: number) => {
      s.c += n;
    },
  })
  .build();

describe("mailbox throughput", () => {
  it("processes 1000 tells in order", async () => {
    vi.useFakeTimers();
    const mgr = createActorManager({ definition: def });
    const a = mgr.get("x");

    const promises = [...Array(1_000).keys()].map(() => a.tell.add(1));
    vi.runAllTimers();
    await Promise.all(promises);
    expect((await a.inspect()).state.c).toBe(1_000);
    await mgr.shutdown();
    vi.useRealTimers();
  });
});
