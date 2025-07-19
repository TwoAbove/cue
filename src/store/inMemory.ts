import type { PersistenceAdapter } from "../contracts";

interface EventRecord {
  version: bigint;
  data: string;
  meta: string;
}

interface SnapshotRecord {
  version: bigint;
  data: string;
}

interface LockRecord {
  owner: string;
  expiresAt: number;
}

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  private events = new Map<string, EventRecord[]>();
  private snapshots = new Map<string, SnapshotRecord>();
  private locks = new Map<string, LockRecord>();
  private latestVersions = new Map<string, bigint>();

  async getEvents(
    actorId: string,
    fromVersion: bigint,
  ): Promise<{ version: bigint; data: string; meta: string }[]> {
    const actorEvents = this.events.get(actorId) || [];
    return actorEvents
      .filter((event) => event.version > fromVersion)
      .map((event) => ({
        version: event.version,
        data: event.data,
        meta: event.meta,
      }));
  }

  async commitEvent(
    actorId: string,
    version: bigint,
    data: string,
    meta: string,
  ): Promise<void> {
    const actorEvents = this.events.get(actorId) || [];

    const latestEventVersion =
      actorEvents[actorEvents.length - 1]?.version || 0n;
    const latestSnapshotVersion = this.snapshots.get(actorId)?.version || 0n;
    const actualCurrentVersion =
      latestEventVersion > latestSnapshotVersion
        ? latestEventVersion
        : latestSnapshotVersion;

    const expectedPrevVersion = version - 1n;

    if (
      expectedPrevVersion !== actualCurrentVersion &&
      !(version === 0n && expectedPrevVersion === -1n)
    ) {
      throw new Error(
        `Optimistic lock failure: expected version ${expectedPrevVersion}, got ${actualCurrentVersion}`,
      );
    }

    actorEvents.push({ version, data, meta });
    this.events.set(actorId, actorEvents);
    this.latestVersions.set(actorId, version);
  }

  async getLatestSnapshot(
    actorId: string,
  ): Promise<{ version: bigint; data: string } | null> {
    const snapshot = this.snapshots.get(actorId);
    return snapshot ? { version: snapshot.version, data: snapshot.data } : null;
  }

  async commitSnapshot(
    actorId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    this.snapshots.set(actorId, { version, data });
    this.latestVersions.set(actorId, version);

    const actorEvents = this.events.get(actorId) || [];
    const eventsAfterSnapshot = actorEvents.filter(
      (event) => event.version > version,
    );
    this.events.set(actorId, eventsAfterSnapshot);
  }

  async acquire(
    actorId: string,
    owner: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const currentLock = this.locks.get(actorId);
    const now = Date.now();

    if (currentLock) {
      if (currentLock.expiresAt > now && currentLock.owner !== owner) {
        return false;
      }
    }

    const expiresAt = ttlMs ? now + ttlMs : Number.MAX_SAFE_INTEGER;
    this.locks.set(actorId, { owner, expiresAt });
    return true;
  }

  async release(actorId: string, owner: string): Promise<void> {
    const currentLock = this.locks.get(actorId);

    if (currentLock && currentLock.owner === owner) {
      this.locks.delete(actorId);
    }
  }

  clear(): void {
    this.events.clear();
    this.snapshots.clear();
    this.locks.clear();
    this.latestVersions.clear();
  }

  async clearActor(actorId: string) {
    this.events.delete(actorId);
    this.snapshots.delete(actorId);
    this.locks.delete(actorId);
    this.latestVersions.delete(actorId);
  }
}

export function inMemoryPersistenceAdapter() {
  return new InMemoryPersistenceAdapter();
}
