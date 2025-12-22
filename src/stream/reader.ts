import type { PersistenceAdapter } from "../persistence/types";
import { deserialize } from "../serde";
import { STREAM_ENTITY_DEF_NAME } from "./constants";
import type {
  ReadStreamOptions,
  StreamChunk,
  StreamEventEnvelope,
  StreamReader,
  StreamStatus,
} from "./types";

export async function streamStatus(
  store: PersistenceAdapter,
  streamId: string,
): Promise<StreamStatus | null> {
  const events = await store.getEvents(streamId, 0n);

  if (events.length === 0) {
    return null;
  }

  const lastEvent = events[events.length - 1];
  if (!lastEvent) return null;

  const envelope = deserialize<StreamEventEnvelope>(lastEvent.data);

  if (envelope.entityDefName !== STREAM_ENTITY_DEF_NAME) {
    return null;
  }

  if (envelope.handler === "end") {
    const endPayload = envelope.payload[0];
    if (endPayload.state === "error") {
      return {
        state: "error",
        seq: BigInt(events.length - 1),
        error: endPayload.error,
      };
    }
    return {
      state: "complete",
      seq: BigInt(events.length - 1),
      returnValue: endPayload.returnValue,
    };
  }

  return {
    state: "running",
    seq: BigInt(events.length),
  };
}

export function readStream<T>(
  store: PersistenceAdapter,
  streamId: string,
  options?: ReadStreamOptions,
): StreamReader<T> {
  const afterSeq = options?.after ?? 0n;
  let isLive = true;

  const reader: StreamReader<T> = {
    get isLive() {
      return isLive;
    },

    async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk<T>> {
      const events = await store.getEvents(streamId, afterSeq);

      for (const event of events) {
        const envelope = deserialize<StreamEventEnvelope>(event.data);

        if (envelope.entityDefName !== STREAM_ENTITY_DEF_NAME) {
          continue;
        }

        if (envelope.handler === "end") {
          isLive = false;
          return;
        }

        if (envelope.handler === "chunk") {
          yield {
            seq: event.version,
            data: envelope.payload[0] as T,
          };
        }
      }

      const status = await streamStatus(store, streamId);
      if (status && status.state !== "running") {
        isLive = false;
      }
    },
  };

  return reader;
}
