import { describe, expect, it } from "vitest";
import {
  create,
  define,
  type HistoryOf,
  InMemoryPersistenceAdapter,
  type VersionState,
} from "../src";

describe("stateAt", () => {
  const Counter = define("Counter")
    .initialState(() => ({ count: 0 }))
    .commands({
      inc: (s) => {
        s.count++;
      },
    })
    .queries({
      value: (s) => s.count,
    })
    .build();

  it("returns historical state at a specific event version", async () => {
    const store = new InMemoryPersistenceAdapter();
    const app = create({ definition: Counter, store });
    const counter = app.get("test-1");

    await counter.send.inc();
    await counter.send.inc();
    await counter.send.inc();

    const atV1 = await counter.stateAt(1n);
    expect(atV1.state).toEqual({ count: 1 });
    expect(atV1.schemaVersion).toBe(1);

    const atV2 = await counter.stateAt(2n);
    expect(atV2.state).toEqual({ count: 2 });

    const atV3 = await counter.stateAt(3n);
    expect(atV3.state).toEqual({ count: 3 });

    await app.stop();
  });

  it("returns initial state at version 0", async () => {
    const store = new InMemoryPersistenceAdapter();
    const app = create({ definition: Counter, store });
    const counter = app.get("test-2");

    await counter.send.inc();

    const atV0 = await counter.stateAt(0n);
    expect(atV0.state).toEqual({ count: 0 });

    await app.stop();
  });

  it("throws without persistence store", async () => {
    const app = create({ definition: Counter });
    const counter = app.get("test-3");

    await expect(counter.stateAt(1n)).rejects.toThrow(
      "stateAt requires a persistence store",
    );

    await app.stop();
  });
});

describe("stateAt with schema evolution", () => {
  const V1Entity = define("Evolved")
    .initialState(() => ({ a: 1 }))
    .commands({
      bump: (s) => {
        s.a++;
      },
    })
    .build();

  const V2Entity = define("Evolved")
    .initialState(() => ({ a: 1 }))
    .evolve((v1) => ({ b: v1.a * 10 }))
    .commands({
      bump: (s) => {
        s.b++;
      },
    })
    .build();

  it("returns correct schema version for historical events", async () => {
    const store = new InMemoryPersistenceAdapter();

    // Create some v1 events
    const app1 = create({ definition: V1Entity, store });
    const ref1 = app1.get("evolved-1");
    await ref1.send.bump();
    await ref1.send.bump();
    await app1.stop();

    // Now use v2 definition to read historical state
    const app2 = create({ definition: V2Entity, store });
    const ref2 = app2.get("evolved-1");

    // Historical v1 events should show schema version 1
    const atV1 = await ref2.stateAt(1n);
    expect(atV1.schemaVersion).toBe(1);
    expect(atV1.state).toEqual({ a: 2 });

    const atV2 = await ref2.stateAt(2n);
    expect(atV2.schemaVersion).toBe(1);
    expect(atV2.state).toEqual({ a: 3 });

    await app2.stop();
  });

  it("handles upcasting at schema boundaries during replay", async () => {
    const store = new InMemoryPersistenceAdapter();

    // Create v1 events
    const app1 = create({ definition: V1Entity, store });
    const ref1 = app1.get("evolve-test");
    await ref1.send.bump();
    await app1.stop();

    // Create v2 events on top
    const app2 = create({ definition: V2Entity, store });
    const ref2 = app2.get("evolve-test");
    await ref2.send.bump();
    await app2.stop();

    // Read back with stateAt
    const app3 = create({ definition: V2Entity, store });
    const ref3 = app3.get("evolve-test");

    // v1 event should return v1 schema state
    const atV1 = await ref3.stateAt(1n);
    expect(atV1.schemaVersion).toBe(1);
    expect(atV1.state).toEqual({ a: 2 });

    // v2 event: upcast { a: 2 } -> { b: 20 }, then bump -> { b: 21 }
    const atV2 = await ref3.stateAt(2n);
    expect(atV2.schemaVersion).toBe(2);
    expect(atV2.state).toEqual({ b: 21 });

    await app3.stop();
  });
});

describe("type machinery", () => {
  const Character = define("Character")
    .initialState(() => ({ hp: 100 }))
    .evolve((v1) => ({ health: { current: v1.hp, max: 100 } }))
    .evolve((v2) => ({ ...v2, mana: 50 }))
    .commands({
      damage: (s, amount: number) => {
        s.health.current -= amount;
      },
    })
    .build();

  it("HistoryOf produces correct union type", () => {
    type H = HistoryOf<typeof Character>;

    // Type test: all three versions should be assignable
    const _v1: H = { schemaVersion: 1, state: { hp: 100 } };
    const _v2: H = {
      schemaVersion: 2,
      state: { health: { current: 100, max: 100 } },
    };
    const _v3: H = {
      schemaVersion: 3,
      state: { health: { current: 100, max: 100 }, mana: 50 },
    };

    expect(_v1.schemaVersion).toBe(1);
    expect(_v2.schemaVersion).toBe(2);
    expect(_v3.schemaVersion).toBe(3);
  });

  it("VersionState extracts individual version types", () => {
    type V1 = VersionState<typeof Character, 1>;
    type V2 = VersionState<typeof Character, 2>;
    type V3 = VersionState<typeof Character, 3>;

    const _v1: V1 = { hp: 100 };
    const _v2: V2 = { health: { current: 100, max: 100 } };
    const _v3: V3 = { health: { current: 100, max: 100 }, mana: 50 };

    expect(_v1.hp).toBe(100);
    expect(_v2.health.current).toBe(100);
    expect(_v3.mana).toBe(50);
  });

  it("discriminated union narrows correctly", async () => {
    const store = new InMemoryPersistenceAdapter();
    const app = create({ definition: Character, store });
    const hero = app.get("hero-1");

    await hero.send.damage(10);

    const historical = await hero.stateAt(1n);

    // This definition is at schema v3 (2 evolves), so all events are v3
    expect(historical.schemaVersion).toBe(3);

    // Type narrowing should work
    if (historical.schemaVersion === 3) {
      expect(historical.state.health.current).toBe(90);
      expect(historical.state.mana).toBe(50);
    }

    await app.stop();
  });
});
