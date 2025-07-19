import { beforeEach, describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "../src/index";
import type { InMemoryPersistenceAdapter } from "../src/store/inMemory";
import { inMemoryPersistenceAdapter } from "../src/store/inMemory";
import { deepEqual } from "../src/utils/serde";

type ComplexState = {
  aDate?: Date;
  aMap?: Map<string, { value: bigint }>;
  aSet?: Set<string>;
  aBigInt?: bigint;
  aRegex?: RegExp;
  aNull?: null;
  anUndefined?: undefined;
  willBeDeleted?: string;
};

const dataTypesDef = defineActor("DataTypes")
  .initialState((): ComplexState => ({}))
  .commands({
    set: (state, payload: ComplexState) => {
      Object.assign(state, payload);
      delete state.willBeDeleted;
    },
  })
  .queries({
    get: (state) => state,
  })
  .build();

describe("Data Type Serialization", () => {
  let store: InMemoryPersistenceAdapter;
  beforeEach(() => {
    store = inMemoryPersistenceAdapter();
  });

  it("should correctly persist and rehydrate complex data types", async () => {
    const actorId = "complex-data-actor";
    const testData: ComplexState = {
      aDate: new Date("2024-05-20T10:00:00.000Z"),
      aMap: new Map([["key", { value: 9007199254740991n }]]),
      aSet: new Set(["one", "two"]),
      aBigInt: 12345678901234567890n,
      aRegex: /test/gi,
      aNull: null,
      anUndefined: undefined,
      willBeDeleted: "This will be removed",
    };

    const manager1 = createActorManager({ definition: dataTypesDef, store });
    const actor1 = manager1.get(actorId);
    await actor1.tell.set(testData);
    await manager1.terminate();

    const manager2 = createActorManager({ definition: dataTypesDef, store });
    const actor2 = manager2.get(actorId);
    const state = await actor2.ask.get();

    expect(state.aDate).toEqual(testData.aDate);
    expect(deepEqual(state.aMap, testData.aMap)).toBe(true);
    expect(deepEqual(state.aSet, testData.aSet)).toBe(true);
    expect(state.aBigInt).toEqual(testData.aBigInt);
    expect(state.aRegex).toEqual(testData.aRegex);
    expect(state.aNull).toBeNull();
    expect("anUndefined" in state).toBe(true);
    expect("willBeDeleted" in state).toBe(false);

    await manager2.terminate();
  });
});
