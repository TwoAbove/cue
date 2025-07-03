import type { Patch, PatchStore, StateSnapshot } from "../contracts.js";
import { clone } from "../utils/serde";

interface ActorRecord {
  version: bigint;
  snapshot?: { state: StateSnapshot; version: bigint };
  patches: { version: bigint; patch: Patch }[];
}

interface LockRecord {
  owner: string;
  expiresAt: number;
}

export class InMemoryStore implements PatchStore {
  private actors = new Map<string, ActorRecord>();
  private locks = new Map<string, LockRecord>();

  async commit(
    actorId: string,
    expectedVersion: bigint,
    patch: Patch,
    _meta?: { handler: string; payload: unknown; returnVal?: unknown },
  ): Promise<bigint> {
    if (patch.length === 0) {
      throw new Error("Empty patch: cannot commit an empty patch array");
    }

    const record = this.actors.get(actorId);

    if (record && record.version !== expectedVersion) {
      throw new Error(
        `Optimistic lock failure: expected version ${expectedVersion}, got ${record.version}`,
      );
    }

    const newVersion = expectedVersion + 1n;

    if (!record) {
      this.actors.set(actorId, {
        version: newVersion,
        patches: [{ version: newVersion, patch }],
      });
    } else {
      record.version = newVersion;
      record.patches.push({ version: newVersion, patch });
    }

    return newVersion;
  }

  async load(
    actorId: string,
    fromVersion = 0n,
  ): Promise<{
    snapshot: { state: StateSnapshot; version: bigint } | null;
    patches: { version: bigint; patch: Patch }[];
  }> {
    const record = this.actors.get(actorId);

    if (!record) {
      return {
        snapshot: null,
        patches: [],
      };
    }

    const snapshot = record.snapshot ? clone(record.snapshot) : null;
    const patchesStartVersion = snapshot ? snapshot.version : fromVersion;
    const patches = record.patches.filter(
      (p) => p.version > patchesStartVersion,
    );

    return { snapshot, patches: clone(patches) };
  }

  async acquire(
    actorId: string,
    owner: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const currentLock = this.locks.get(actorId);
    const now = Date.now();

    // Check if lock exists and is not expired
    if (currentLock) {
      if (currentLock.expiresAt > now && currentLock.owner !== owner) {
        return false; // Lock is held by someone else and not expired
      }
    }

    // Acquire or renew the lock
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

  async commitSnapshot(
    actorId: string,
    version: bigint,
    snapshot: StateSnapshot,
  ): Promise<void> {
    const record = this.actors.get(actorId);

    if (record) {
      record.version = version;
      record.snapshot = { state: clone(snapshot), version };
      // Keep only patches after the snapshot version
      record.patches = record.patches.filter((p) => p.version > version);
    } else {
      // Create new record with snapshot
      this.actors.set(actorId, {
        version,
        snapshot: { state: clone(snapshot), version },
        patches: [],
      });
    }
  }

  clear(): void {
    this.actors.clear();
    this.locks.clear();
  }
}

export function inMemoryStore(): PatchStore {
  return new InMemoryStore();
}
