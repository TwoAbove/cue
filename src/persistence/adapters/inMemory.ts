import { CommitError } from "../../errors/index";
import { clone } from "../../serde/index";
import type { PersistenceAdapter } from "../types";

interface EventRecord {
  version: bigint;
  data: string; // stringified EventEnvelope
}

interface SnapshotRecord {
  version: bigint;
  data: string; // stringified SnapshotEnvelope
}

function auditVersion(currentVersion: bigint, newVersion: bigint) {
  const expectedVersion = currentVersion + 1n;
  if (newVersion !== expectedVersion) {
    throw new CommitError(
      `Optimistic lock failure: expected version ${expectedVersion}, got ${newVersion}.`,
    );
  }
}

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  private events = new Map<string, EventRecord[]>();
  private snapshots = new Map<string, SnapshotRecord>();

  async getEvents(
    entityId: string,
    fromVersion: bigint,
  ): Promise<EventRecord[]> {
    const entityEvents = this.events.get(entityId) ?? [];
    return clone(entityEvents.filter((event) => event.version > fromVersion));
  }

  async commitEvent(
    entityId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    const entityEvents = this.events.get(entityId) ?? [];

    const lastEventVersion = entityEvents.at(-1)?.version ?? 0n;
    const snapshotVersion = this.snapshots.get(entityId)?.version ?? 0n;
    const currentVersion =
      lastEventVersion > snapshotVersion ? lastEventVersion : snapshotVersion;

    auditVersion(currentVersion, version);

    entityEvents.push({ version, data });
    this.events.set(entityId, entityEvents);
  }

  async getLatestSnapshot(entityId: string): Promise<SnapshotRecord | null> {
    const snapshot = this.snapshots.get(entityId);
    return snapshot ? clone(snapshot) : null;
  }

  async commitSnapshot(
    entityId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    this.snapshots.set(entityId, { version, data });
  }

  async clearEntity(entityId: string): Promise<void> {
    this.events.delete(entityId);
    this.snapshots.delete(entityId);
  }

  // test helper
  clear(): void {
    this.events.clear();
    this.snapshots.clear();
  }
}
