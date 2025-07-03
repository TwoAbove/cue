import { describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "./";
import { createInMemoryPatchStore } from "./store/inMemory.mock.js";

type ComplexState = {
  aDate?: Date;
  aMap?: Map<string, number>;
  aSet?: Set<string>;
  aBigInt?: bigint;
  anUndefined?: undefined;
  aNull?: null;
  aRegex?: RegExp;
};

const dataTypesActorDef = defineActor("DataTypes")
  .initialState((): ComplexState => ({}))
  .commands({
    Set: (state, payload: Partial<ComplexState>) => {
      Object.assign(state, payload);
    },
  })
  .build();

describe("Actor Data Type Handling", () => {
  const store = createInMemoryPatchStore();

  const testData: ComplexState = {
    aDate: new Date("2024-01-01T00:00:00.000Z"),
    aMap: new Map([
      ["a", 1],
      ["b", 2],
    ]),
    aSet: new Set(["x", "y"]),
    aBigInt: 12345678901234567890n,
    anUndefined: undefined,
    aNull: null,
    aRegex: /test/gi,
  };

  it("should persist and rehydrate various data types correctly", async () => {
    const manager1 = createActorManager({
      definition: dataTypesActorDef,
      store: store,
    });
    const actorId = "data-persist-1";
    const actor1 = manager1.get(actorId);
    await actor1.tell.Set(testData);
    await manager1.shutdown();

    const manager2 = createActorManager({
      definition: dataTypesActorDef,
      store: store,
    });
    const actor2 = manager2.get(actorId);
    const { state } = await actor2.inspect();

    expect(state.aDate?.toISOString()).toEqual(testData.aDate?.toISOString());
    expect(state.aMap).toEqual(testData.aMap);
    expect(state.aSet).toEqual(testData.aSet);
    expect(state.aBigInt).toEqual(testData.aBigInt);
    expect(state.aNull).toBeNull();
    expect(state.aRegex).toEqual(testData.aRegex);
    expect(state.anUndefined).toBeUndefined();

    await manager2.shutdown();
  });
});
