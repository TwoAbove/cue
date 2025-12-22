import { RedisClient } from "bun";
import { CommitError } from "../../src/errors/index";
import type { PersistenceAdapter } from "../../src/persistence/types";

export class BunRedisAdapter implements PersistenceAdapter {
  private redis: RedisClient;

  constructor(connectionString: string) {
    this.redis = new RedisClient(connectionString);
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async reset(): Promise<void> {
    await this.redis.send("FLUSHDB", []);
  }

  async close(): Promise<void> {
    this.redis.close();
  }

  private eventStreamKey(entityId: string): string {
    return `cue:events:${entityId}`;
  }

  private snapshotKey(entityId: string): string {
    return `cue:snapshot:${entityId}`;
  }

  private versionKey(entityId: string): string {
    return `cue:version:${entityId}`;
  }

  async getEvents(
    entityId: string,
    fromVersion: bigint,
  ): Promise<{ version: bigint; data: string }[]> {
    const streamKey = this.eventStreamKey(entityId);
    const start = (fromVersion + 1n).toString();

    const result = await this.redis.send("XRANGE", [streamKey, start, "+"]);

    if (!result || !Array.isArray(result)) {
      return [];
    }

    return (result as [string, string[]][]).map(([id, fields]) => {
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldMap[fields[i]] = fields[i + 1];
      }
      return {
        version: BigInt(fieldMap.version),
        data: fieldMap.data,
      };
    });
  }

  async commitEvent(
    entityId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    const versionKey = this.versionKey(entityId);
    const streamKey = this.eventStreamKey(entityId);

    const currentVersion = await this.redis.get(versionKey);
    const expectedVersion = currentVersion ? BigInt(currentVersion) + 1n : 1n;

    if (version !== expectedVersion) {
      throw new CommitError(
        `Optimistic lock failure: expected version ${expectedVersion}, got ${version}.`,
      );
    }

    await this.redis.send("XADD", [
      streamKey,
      version.toString(),
      "version",
      version.toString(),
      "data",
      data,
    ]);

    await this.redis.set(versionKey, version.toString());
  }

  async getLatestSnapshot(
    entityId: string,
  ): Promise<{ version: bigint; data: string } | null> {
    const snapshotKey = this.snapshotKey(entityId);
    const result = await this.redis.send("HGETALL", [snapshotKey]);

    if (!result || !Array.isArray(result) || result.length === 0) {
      return null;
    }

    const fieldMap: Record<string, string> = {};
    for (let i = 0; i < result.length; i += 2) {
      fieldMap[result[i] as string] = result[i + 1] as string;
    }

    if (!fieldMap.version || !fieldMap.data) {
      return null;
    }

    return {
      version: BigInt(fieldMap.version),
      data: fieldMap.data,
    };
  }

  async commitSnapshot(
    entityId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    const snapshotKey = this.snapshotKey(entityId);
    await this.redis.send("HSET", [
      snapshotKey,
      "version",
      version.toString(),
      "data",
      data,
    ]);
  }

  async clearEntity(entityId: string): Promise<void> {
    await this.redis.del(this.eventStreamKey(entityId));
    await this.redis.del(this.snapshotKey(entityId));
    await this.redis.del(this.versionKey(entityId));
  }
}
