import type { Operation } from "fast-json-patch";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";
import type {
  ActorManager,
  PersistedEvent,
  PersistenceAdapter,
} from "./contracts";

// Re-using the in-memory persistence adapter from internal tests
const createInMemoryPersistenceAdapter = () => {
  const store = new Map<
    string,
    {
      initialState: unknown;
      patches: { version: bigint; patch: Operation[] }[];
      actorDefName: string;
      snapshots: { version: bigint; state: unknown }[];
    }
  >();

  const adapter = {
    persist: vi.fn(async (event: PersistedEvent) => {
      const s = (val: unknown) => superjson.parse(superjson.stringify(val));
      if (event.type === "CREATE") {
        store.set(event.actorId, {
          initialState: s(event.initialState),
          patches: [],
          snapshots: [],
          actorDefName: event.actorDefName,
        });
      } else {
        const record = store.get(event.actorId);
        if (!record) throw new Error("Actor not found");
        if (event.type === "UPDATE") {
          record.patches.push({ version: event.version, patch: event.patch });
        } else if (event.type === "SNAPSHOT") {
          record.snapshots.push({
            version: event.version,
            state: s(event.state),
          });
        }
      }
    }),
    load: vi.fn(async (actorId: string) => {
      const s = (val: unknown) => superjson.parse(superjson.stringify(val));
      const record = store.get(actorId);
      if (!record) return null;

      const latestSnapshot =
        record.snapshots.length > 0
          ? record.snapshots.reduce((a, b) => (a.version > b.version ? a : b))
          : null;

      if (latestSnapshot) {
        const patches = record.patches
          .filter((p) => p.version > latestSnapshot.version)
          .sort((a, b) => (a.version > b.version ? 1 : -1))
          .map((p) => p.patch);
        return {
          baseState: s(latestSnapshot.state),
          baseVersion: latestSnapshot.version,
          patches,
          actorDefName: record.actorDefName,
        };
      }

      const patches = record.patches
        .sort((a, b) => (a.version > b.version ? 1 : -1))
        .map((p) => p.patch);
      return {
        baseState: s(record.initialState),
        baseVersion: 0n,
        patches,
        actorDefName: record.actorDefName,
      };
    }),
    clear: () => {
      store.clear();
      adapter.persist.mockClear();
      adapter.load.mockClear();
    },
  } satisfies PersistenceAdapter & { clear: () => void };
  return adapter;
};

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
  .withInitialState((): ComplexState => ({}))
  .commands({
    Set: (state, payload: Partial<ComplexState>) => {
      Object.assign(state, payload);
    },
  })
  .build();

describe("Actor Data Type Handling", () => {
  const persistenceAdapter = createInMemoryPersistenceAdapter();

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
      persistence: persistenceAdapter,
    });
    const actorId = "data-persist-1";
    const actor1 = manager1.get(actorId);
    await actor1.tell.Set(testData);
    await manager1.shutdown();

    const manager2 = createActorManager({
      definition: dataTypesActorDef,
      persistence: persistenceAdapter,
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
