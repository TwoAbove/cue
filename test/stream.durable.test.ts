import { afterEach, describe, expect, it, vi } from "vitest";
import { create, define, InMemoryPersistenceAdapter } from "@/api";

const Counter = define("Counter")
  .initialState(() => ({ n: 0 }))
  .commands({
    streamGrow: async function* (s, steps: number) {
      for (let i = 0; i < steps; i++) {
        s.n++;
        yield { i: i + 1, n: s.n };
      }
      return s.n;
    },
    streamFail: async function* (_s) {
      yield { step: 1 };
      throw new Error("stream error");
    },
  })
  .queries({
    get: (s) => s.n,
  })
  .persistence({ snapshotEvery: 10 })
  .build();

const newId = () => `entity-${Math.random().toString(36).slice(2)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("Durable Streams", () => {
  it("stream returns StreamRun with id, seq, and isLive", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(3);

    expect(run.id).toBeDefined();
    expect(typeof run.id).toBe("string");
    expect(run.seq).toBe(0n);
    expect(run.isLive).toBe(true);

    const chunks: unknown[] = [];
    for await (const chunk of run) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(run.isLive).toBe(false);
    expect(run.seq).toBe(4n);

    await manager.stop();
  });

  it("chunks are persisted and can be read back by streamId", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(3);
    const streamId = run.id;

    for await (const _ of run) {
    }

    const reader = manager.readStream<{ i: number; n: number }>(streamId);
    const chunks: Array<{ seq: bigint; data: { i: number; n: number } }> = [];
    for await (const chunk of reader) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ seq: 1n, data: { i: 1, n: 1 } });
    expect(chunks[1]).toEqual({ seq: 2n, data: { i: 2, n: 2 } });
    expect(chunks[2]).toEqual({ seq: 3n, data: { i: 3, n: 3 } });

    await manager.stop();
  });

  it("streamStatus returns correct state for completed stream", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(2);
    const streamId = run.id;

    const statusBefore = await manager.streamStatus(streamId);
    expect(statusBefore).toBeNull();

    for await (const _ of run) {
    }

    const status = await manager.streamStatus(streamId);
    expect(status).toEqual({
      state: "complete",
      seq: 2n,
      returnValue: 2,
    });

    await manager.stop();
  });

  it("streamStatus returns error state when stream throws", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamFail();
    const streamId = run.id;

    try {
      for await (const _ of run) {
      }
    } catch {}

    const status = await manager.streamStatus(streamId);
    expect(status?.state).toBe("error");
    expect(status?.error).toBe("stream error");

    await manager.stop();
  });

  it("readStream with after option resumes from position", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(5);
    const streamId = run.id;

    for await (const _ of run) {
    }

    const reader = manager.readStream<{ i: number; n: number }>(streamId, {
      after: 2n,
    });
    const chunks: Array<{ seq: bigint; data: { i: number; n: number } }> = [];
    for await (const chunk of reader) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ seq: 3n, data: { i: 3, n: 3 } });
    expect(chunks[1]).toEqual({ seq: 4n, data: { i: 4, n: 4 } });
    expect(chunks[2]).toEqual({ seq: 5n, data: { i: 5, n: 5 } });

    await manager.stop();
  });

  it("stream id format includes entity id and handler name", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const entityId = "my-entity-123";
    const ref = manager.get(entityId);

    const run = ref.stream.streamGrow(1);

    expect(run.id).toContain(entityId);
    expect(run.id).toContain("streamGrow");

    for await (const _ of run) {
    }

    await manager.stop();
  });

  it("producer continues to completion after consumer breaks (detached)", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(5);
    const streamId = run.id;

    let count = 0;
    for await (const _ of run) {
      count++;
      if (count === 2) break;
    }

    await new Promise((r) => setTimeout(r, 50));

    const status = await manager.streamStatus(streamId);
    expect(status?.state).toBe("complete");
    expect(status?.returnValue).toBe(5);

    const reader = manager.readStream<{ i: number; n: number }>(streamId);
    const chunks: Array<{ seq: bigint; data: { i: number; n: number } }> = [];
    for await (const chunk of reader) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(5);
    expect(chunks[4]).toEqual({ seq: 5n, data: { i: 5, n: 5 } });

    await manager.stop();
  });

  it("readStream/streamStatus throw without persistence store", async () => {
    const manager = create({ definition: Counter });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(1);

    const chunks: unknown[] = [];
    for await (const chunk of run) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);

    expect(() => manager.readStream(run.id)).toThrow(
      "readStream requires a persistence store",
    );
    await expect(manager.streamStatus(run.id)).rejects.toThrow(
      "streamStatus requires a persistence store",
    );

    await manager.stop();
  });

  it("readStream waits for and receives live events", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(3);
    const streamId = run.id;

    const chunks: Array<{ seq: bigint; data: unknown }> = [];

    {
      await using reader = manager.readStream(streamId);
      for await (const chunk of reader) {
        chunks.push(chunk);
      }
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ seq: 1n, data: { i: 1, n: 1 } });
    expect(chunks[2]).toEqual({ seq: 3n, data: { i: 3, n: 3 } });

    await manager.stop();
  });

  it("readStream cleans up subscription on early break", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(5);
    const streamId = run.id;

    const chunks: Array<{ seq: bigint; data: unknown }> = [];

    {
      await using reader = manager.readStream(streamId);
      for await (const chunk of reader) {
        chunks.push(chunk);
        if (chunks.length === 2) break;
      }
      expect(reader.isLive).toBe(false);
    }

    expect(chunks).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 50));
    const status = await manager.streamStatus(streamId);
    expect(status?.state).toBe("complete");

    await manager.stop();
  });

  it("readStream with await using disposes correctly", async () => {
    const store = new InMemoryPersistenceAdapter();
    const manager = create({ definition: Counter, store });
    const ref = manager.get(newId());

    const run = ref.stream.streamGrow(3);
    const streamId = run.id;

    let readerRef: { isLive: boolean } | undefined;

    {
      await using reader = manager.readStream(streamId);
      readerRef = reader;
      for await (const _ of reader) {
        break;
      }
    }

    expect(readerRef?.isLive).toBe(false);

    await manager.stop();
  });
});
