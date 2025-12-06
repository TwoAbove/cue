import { describe, expect, it } from "vitest";
import { create, define } from "@/api";
import { HydrationError } from "@/errors";
import type {
  EventEnvelope,
  PersistenceAdapter,
  SnapshotEnvelope,
} from "@/persistence/types";
import { serialize } from "@/serde";

const Base = define("Hydratee")
  .initialState(() => ({ n: 0 }))
  .commands({
    inc: (s, by = 1) => {
      s.n += by;
    },
  })
  .queries({
    get: (s) => s.n,
  })
  .build();

class FakeStore implements PersistenceAdapter {
  constructor(
    private opts: {
      // for out-of-order events
      events?: { version: bigint; data: string }[];
      // for snapshots
      snapshot?: { version: bigint; data: string } | null;
    },
  ) {}
  async getEvents() {
    return this.opts.events ?? [];
  }
  async commitEvent() {}
  async getLatestSnapshot() {
    return this.opts.snapshot ?? null;
  }
  async commitSnapshot() {}
}

describe("Hydration edge cases", () => {
  it("throws if events are out of order", async () => {
    const env: EventEnvelope = {
      entityDefName: "Hydratee",
      schemaVersion: 1,
      handler: "inc",
      payload: [1],
      returnVal: 1,
      patches: [],
    };
    const store = new FakeStore({
      snapshot: null,
      events: [
        { version: 2n, data: serialize(env) },
        { version: 1n, data: serialize(env) },
      ],
    });
    const manager = create({ definition: Base, store });
    const ref = manager.get("ooe");
    await expect(ref.read.get()).rejects.toBeInstanceOf(HydrationError);
    await manager.stop();
  });

  it("throws on definition mismatch in snapshot", async () => {
    const snap: SnapshotEnvelope = {
      entityDefName: "DifferentDef",
      schemaVersion: 1,
      state: { n: 0 },
    };
    const store = new FakeStore({
      snapshot: { version: 0n, data: serialize(snap) },
      events: [],
    });
    const manager = create({ definition: Base, store });
    const ref = manager.get("mismatch");
    await expect(ref.read.get()).rejects.toBeInstanceOf(HydrationError);
    await manager.stop();
  });

  it("applies upcasters from snapshot schema version", async () => {
    const V2 = define("Hydratee")
      .initialState(() => ({ n: 0 })) // v1
      .evolve((prev) => ({ total: prev.n })) // v2 shape
      .queries({
        read: (s) => s.total,
      })
      .build();

    const snap: SnapshotEnvelope = {
      entityDefName: "Hydratee",
      schemaVersion: 1, // indicates v1 state in snapshot
      state: { n: 41 },
    };

    const store = new FakeStore({
      snapshot: { version: 0n, data: serialize(snap) },
      events: [],
    });

    const manager = create({ definition: V2, store });
    const ref = manager.get("evolve");
    await expect(ref.read.read()).resolves.toBe(41);
    await manager.stop();
  });
});
