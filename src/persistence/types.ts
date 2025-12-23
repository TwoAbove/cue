import type { Patch } from "../types/public";

export type EventEnvelope = {
  entityDefName: string;
  schemaVersion: number;
  handler: string;
  payload: unknown[];
  returnVal?: unknown;
  patches: Patch;
};

export type SnapshotEnvelope = {
  entityDefName: string;
  schemaVersion: number;
  state: unknown;
};

export interface PersistenceAdapter {
  getEvents(
    entityId: string,
    fromVersion: bigint,
  ): Promise<{ version: bigint; data: string }[]>; // data is EventEnvelope string

  commitEvent(
    entityId: string,
    version: bigint,
    data: string, // EventEnvelope string
  ): Promise<void>;

  getLatestSnapshot(
    entityId: string,
  ): Promise<{ version: bigint; data: string } | null>; // data is SnapshotEnvelope string

  commitSnapshot(
    entityId: string,
    version: bigint,
    data: string, // data is SnapshotEnvelope string
  ): Promise<void>;

  clearEntity?(entityId: string): Promise<void>;

  subscribeEvents?(entityId: string, callback: () => void): () => void;
}
