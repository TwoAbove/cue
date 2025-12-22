export interface StreamChunk<T> {
  seq: bigint;
  data: T;
}

export interface StreamStatus {
  state: "running" | "complete" | "error";
  seq: bigint;
  error?: string;
  returnValue?: unknown;
}

export interface StreamRun<T> extends AsyncIterable<T> {
  readonly id: string;
  readonly seq: bigint;
  readonly isLive: boolean;
}

export interface StreamReader<T> extends AsyncIterable<StreamChunk<T>> {
  readonly isLive: boolean;
}

export interface ReadStreamOptions {
  after?: bigint;
}

export interface StreamChunkEnvelope {
  entityDefName: "__stream__";
  schemaVersion: 1;
  handler: "chunk";
  payload: [unknown];
  patches: readonly [];
}

export type StreamEndPayload =
  | { state: "complete"; returnValue?: unknown }
  | { state: "error"; error: string };

export interface StreamEndEnvelope {
  entityDefName: "__stream__";
  schemaVersion: 1;
  handler: "end";
  payload: [StreamEndPayload];
  patches: readonly [];
}

export type StreamEventEnvelope = StreamChunkEnvelope | StreamEndEnvelope;
