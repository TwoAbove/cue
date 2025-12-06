import { describe, expect, it } from "vitest";
import { define } from "@/api/define";
import { _handlers, _persistence } from "@/types/internal";

describe("define builder", () => {
  it("classifies command/query/stream correctly", async () => {
    const def = define("Sample")
      .initialState(() => ({ n: 0 }))
      .commands({
        inc: (s, by = 1) => {
          s.n += by;
          return s.n;
        },
        // streaming command
        wave: async function* (s, times: number) {
          for (let i = 0; i < times; i++) {
            s.n++;
            yield { i, n: s.n };
          }
          return s.n;
        },
      })
      .queries({
        get: (s) => s.n,
      })
      .persistence({ snapshotEvery: 10 })
      .build();

    const handlers = def[_handlers];
    expect(handlers.inc.type).toBe("command");
    expect(handlers.wave.type).toBe("stream");
    expect(handlers.get.type).toBe("query");
    expect(def[_persistence]).toMatchObject({ snapshotEvery: 10 });
  });

  it("evolve composes upcasters and resets handlers for the new shape", () => {
    const v1 = define("Thing")
      .initialState(() => ({ hp: 100 }))
      .commands({
        take: (s, n: number) => {
          s.hp -= n;
        },
      });

    const v2 = v1
      .evolve((prev) => ({ health: { current: prev.hp, max: 100 } }))
      .queries({
        stats: (s) => s.health.current,
      })
      .build();

    const handlers = v2[_handlers];
    expect(handlers["take"]).toBeUndefined();
    expect(handlers["stats"].type).toBe("query");
  });
});
