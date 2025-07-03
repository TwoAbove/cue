import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActorManager, defineActor } from "./";
import type { ActorManager } from "./contracts";
import { createInMemoryPatchStore } from "./store/inMemory.mock.js";

const counterActorDef = defineActor("Counter")
  .initialState(() => ({ count: 0 }))
  .commands({
    Inc: (state) => {
      state.count++;
    },
  })
  .queries({
    Get: (state) => state.count,
  })
  .build();

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
      "Actor shutdown-2 is shutdown. Further messages are rejected.",
    );
  });

  it("should throw an error when streaming from a shutdown actor reference", async () => {
    const streamActorDef = defineActor("Streamer")
      .initialState(() => ({}))
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
    const expectedError =
      "ActorManager is shut down. Cannot interact with actors.";
    await expect(actor.tell.Inc()).rejects.toThrow(expectedError);
    await expect(actor.ask.Get()).rejects.toThrow(expectedError);

    expect(() => manager.get("sys-down-2")).toThrow(
      "ActorManager is shut down. Cannot create new actors.",
    );
  });

  it("should prevent streaming from any actor after manager shutdown", async () => {
    const streamActorDef = defineActor("StreamerShutdown")
      .initialState(() => ({}))
      .commands({
        DoStream: async function* (_state) {
          yield 1;
        },
      })
      .build();

    const manager = createActorManager({ definition: streamActorDef });
    const actor = manager.get("shutdown-stream-mgr-1");

    await manager.shutdown();

    const stream = actor.stream.DoStream()[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow(
      "ActorManager is shut down. Cannot interact with actors.",
    );
  });

  it("should not affect persisted state, allowing a new manager to rehydrate", async () => {
    const store = createInMemoryPatchStore();
    const manager1 = createActorManager({
      definition: counterActorDef,
      store: store,
    });
    const actorId = "sys-persist-1";
    const actor1 = manager1.get(actorId);
    await actor1.tell.Inc();
    await manager1.shutdown();

    const manager2 = createActorManager({
      definition: counterActorDef,
      store: store,
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
  const store = createInMemoryPatchStore();
  let manager: ActorManager<typeof counterActorDef>;

  beforeEach(() => {
    manager = createActorManager({
      definition: counterActorDef,
      store: store,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    store.clear();
  });

  it("should not clear persisted state on shutdown", async () => {
    const actorId = "shutdown-persist-1";
    const manager1 = createActorManager({
      definition: counterActorDef,
      store: store,
    });
    const actor1 = manager1.get(actorId);
    await actor1.tell.Inc();
    await actor1.shutdown();
    await manager1.shutdown();

    const manager2 = createActorManager({
      definition: counterActorDef,
      store: store,
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
    store.load.mockRejectedValue(loadError);
    const actor = manager.get(actorId);

    await expect(actor.inspect()).rejects.toThrow(loadError);
    await expect(actor.shutdown()).resolves.toBeUndefined();

    store.load.mockResolvedValue({ snapshot: null, patches: [] });
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

    store.load.mockImplementation(async () => {
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
