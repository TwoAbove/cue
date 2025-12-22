import { SQL } from "bun";
import { CommitError } from "../../src/errors/index";
import type { PersistenceAdapter } from "../../src/persistence/types";

export class BunPostgresAdapter implements PersistenceAdapter {
  private sql: SQL;

  constructor(connectionString: string) {
    this.sql = new SQL(connectionString);
  }

  async init(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS cue_events (
        entity_id TEXT NOT NULL,
        version BIGINT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (entity_id, version)
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS cue_snapshots (
        entity_id TEXT PRIMARY KEY,
        version BIGINT NOT NULL,
        data TEXT NOT NULL
      )
    `;
  }

  async reset(): Promise<void> {
    await this.sql`TRUNCATE cue_events, cue_snapshots`;
  }

  async close(): Promise<void> {
    this.sql.close();
  }

  async getEvents(
    entityId: string,
    fromVersion: bigint,
  ): Promise<{ version: bigint; data: string }[]> {
    const rows = await this.sql`
      SELECT version, data
      FROM cue_events
      WHERE entity_id = ${entityId} AND version > ${fromVersion}
      ORDER BY version ASC
    `;
    return rows.map((row) => ({
      version: BigInt(row.version),
      data: row.data as string,
    }));
  }

  async commitEvent(
    entityId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    try {
      await this.sql`
        INSERT INTO cue_events (entity_id, version, data)
        VALUES (${entityId}, ${version}, ${data})
      `;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("duplicate key value")
      ) {
        throw new CommitError(
          `Optimistic lock failure: version ${version} already exists.`,
        );
      }
      throw err;
    }
  }

  async getLatestSnapshot(
    entityId: string,
  ): Promise<{ version: bigint; data: string } | null> {
    const rows = await this.sql`
      SELECT version, data
      FROM cue_snapshots
      WHERE entity_id = ${entityId}
    `;
    if (rows.length === 0) return null;
    return {
      version: BigInt(rows[0].version),
      data: rows[0].data as string,
    };
  }

  async commitSnapshot(
    entityId: string,
    version: bigint,
    data: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO cue_snapshots (entity_id, version, data)
      VALUES (${entityId}, ${version}, ${data})
      ON CONFLICT (entity_id)
      DO UPDATE SET version = ${version}, data = ${data}
    `;
  }

  async clearEntity(entityId: string): Promise<void> {
    await this.sql`DELETE FROM cue_events WHERE entity_id = ${entityId}`;
    await this.sql`DELETE FROM cue_snapshots WHERE entity_id = ${entityId}`;
  }
}
