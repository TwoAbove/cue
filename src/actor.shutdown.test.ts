import type { Operation } from "fast-json-patch";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorManager, defineActor } from "./";
import type {
  ActorManager,
  PersistedEvent,
  PersistenceAdapter,
} from "./contracts";

const counterActorDef = defineActor("Counter")
  .withInitialState(() => ({ count: 0 }))
  .commands({
    Inc: (state) => {
      state.count++;
    },
  })
  .queries({
    Get: (state) => state.count,
  })
  .build();

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
      if (event.type === "CREATE") {
        store.set(event.actorId, {
          initialState: superjson.parse(
            superjson.stringify(event.initialState),
          ),
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
            state: superjson.parse(superjson.stringify(event.state)),
          });
        }
      }
    }),
    load: vi.fn(async (actorId: string) => {
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
          baseState: superjson.parse(superjson.stringify(latestSnapshot.state)),
          baseVersion: latestSnapshot.version,
          patches,
          actorDefName: record.actorDefName,
        };
      }
      const patches = record.patches
        .sort((a, b) => (a.version > b.version ? 1 : -1))
        .map((p) => p.patch);
      return {
        baseState: superjson.parse(superjson.stringify(record.initialState)),
        baseVersion: 0n,
        patches,
        actorDefName: record.actorDefName,
      };
    }),
    clear: () => {
      store.clear();
      (adapter.persist as unknown as { mockClear: () => void }).mockClear();
      (adapter.load as unknown as { mockClear: () => void }).mockClear();
    },
  } satisfies PersistenceAdapter & { clear: () => void };
  return adapter;
};

describe("Actor Shutdown", () => {
  let manager: ActorManager<typeof counterActorDef>;

  beforeEach(() => {
    manager = createActorManager({ definition: counterActorDef });
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("should remove the actor from memory after shutdown", async () => {
    const actor = manager.get("shutdown-1");
    await actor.tell.Inc();
    await actor.shutdown();
    const newActorRef = manager.get("shutdown-1");
    const { state } = await newActorRef.inspect();
    expect(state.count).toBe(0);
  });

  it("should throw an error when interacting with a shutdown actor reference", async () => {
    const actor = manager.get("shutdown-2");
    await actor.shutdown();
    await expect(actor.tell.Inc()).rejects.toThrow(
      'Actor with id "shutdown-2" has been shut down. A new reference must be created via get().',
    );
  });

  it("should throw an error when streaming from a shutdown actor reference", async () => {
    const streamActorDef = defineActor("Streamer")
      .withInitialState(() => ({}))
      .commands({
        DoStream: async function* (_state) {
          yield 1;
        },
      })
      .build();

    const streamManager = createActorManager({ definition: streamActorDef });
    const actor = streamManager.get("shutdown-stream-1");
    await actor.shutdown();

    const expectedError =
      'Actor with id "shutdown-stream-1" has been shut down. A new reference must be created via get().';
    const stream = actor.stream.DoStream()[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow(expectedError);
    await expect(actor.tell.DoStream()).rejects.toThrow(expectedError);
    await streamManager.shutdown();
  });
});

describe("Manager Shutdown", () => {
  it("should prevent interactions with any actor after manager shutdown", async () => {
    const manager = createActorManager({ definition: counterActorDef });
    const actor = manager.get("sys-down-1");
    await actor.tell.Inc();
    expect(await actor.ask.Get()).toBe(1);

    await manager.shutdown();

    await expect(actor.tell.Inc()).rejects.toThrow(
      "ActorManager is shut down. Cannot interact with actors.",
    );
    await expect(actor.ask.Get()).rejects.toThrow(
      "ActorManager is shut down. Cannot interact with actors.",
    );

    expect(() => manager.get("sys-down-2")).toThrow(
      "ActorManager is shut down. Cannot create new actors.",
    );
  });

  it("should not affect persisted state, allowing a new manager to rehydrate", async () => {
    const persistenceAdapter = createInMemoryPersistenceAdapter();
    const manager1 = createActorManager({
      definition: counterActorDef,
      persistence: persistenceAdapter,
    });
    const actorId = "sys-persist-1";
    const actor1 = manager1.get(actorId);
    await actor1.tell.Inc();
    await manager1.shutdown();

    const manager2 = createActorManager({
      definition: counterActorDef,
      persistence: persistenceAdapter,
    });
    const actor2 = manager2.get(actorId);
    const { state } = await actor2.inspect();
    expect(state.count).toBe(1);
    await manager2.shutdown();
  });

  it("should handle shutdown call on actor ref after manager shutdown", async () => {
    const manager = createActorManager({ definition: counterActorDef });
    const actor = manager.get("sys-down-shutdown-race");
    await actor.inspect();
    await manager.shutdown();

    await expect(actor.shutdown()).resolves.toBeUndefined();
  });

  it("should be idempotent and not throw on second call", async () => {
    const manager = createActorManager({ definition: counterActorDef });
    await manager.shutdown();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe("Actor Shutdown with Persistence", () => {
  const persistenceAdapter = createInMemoryPersistenceAdapter();
  let manager: ActorManager<typeof counterActorDef>;

  beforeEach(() => {
    manager = createActorManager({
      definition: counterActorDef,
      persistence: persistenceAdapter,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    persistenceAdapter.clear();
  });

  it("should not clear persisted state on shutdown", async () => {
    const actorId = "shutdown-persist-1";
    const manager1 = createActorManager({
      definition: counterActorDef,
      persistence: persistenceAdapter,
    });
    const actor1 = manager1.get(actorId);
    await actor1.tell.Inc();
    await actor1.shutdown();
    await manager1.shutdown();

    const manager2 = createActorManager({
      definition: counterActorDef,
      persistence: persistenceAdapter,
    });
    const actor2 = manager2.get(actorId);
    const { state, version } = await actor2.inspect();
    expect(state.count).toBe(1);
    expect(version).toBe(1n);
    await manager2.shutdown();
  });

  it("should allow shutting down a failing-to-hydrate actor", async () => {
    const actorId = "shutdown-fail-hydrate";
    const loadError = new Error("DB Load Failed");
    persistenceAdapter.load.mockRejectedValue(loadError);
    const actor = manager.get(actorId);

    await expect(actor.inspect()).rejects.toThrow(loadError);
    await expect(actor.shutdown()).resolves.toBeUndefined();

    persistenceAdapter.load.mockResolvedValue(null);
    await expect(actor.inspect()).rejects.toThrow(
      `Actor with id "${actorId}" has been shut down. A new reference must be created via get().`,
    );
  });

  it("should correctly shutdown actor while it is failing to hydrate", async () => {
    const actorId = "shutdown-while-hydrating";
    const loadError = new Error("DB Load Failed");
    let release: (value?: unknown) => void;
    const lock = new Promise((res) => {
      release = res;
    });

    persistenceAdapter.load.mockImplementation(async () => {
      await lock;
      throw loadError;
    });
    const actor = manager.get(actorId);
    const inspectPromise = actor.inspect();
    const shutdownPromise = actor.shutdown();

    // biome-ignore lint/style/noNonNullAssertion: This is safe in the test
    release!();

    await expect(shutdownPromise).resolves.toBeUndefined();
    await expect(inspectPromise).rejects.toThrow(loadError);
  });
});
