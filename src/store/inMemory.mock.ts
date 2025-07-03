import superjson from "superjson";
import { vi } from "vitest";
import type { Patch, PatchStore, StateSnapshot } from "../contracts.js";

export const createInMemoryPatchStore = () => {
  const store = new Map<
    string,
    {
      version: bigint;
      patches: { version: bigint; patch: Patch }[];
      snapshots: { version: bigint; state: StateSnapshot }[];
    }
  >();

  const patchStore = {
    commit: vi.fn(
      async (
        actorId: string,
        expectedVersion: bigint,
        patch: Patch,
        _meta?: { handler: string; payload: unknown; returnVal?: unknown },
      ): Promise<bigint> => {
        const record = store.get(actorId);

        if (record && record.version !== expectedVersion) {
          throw new Error(
            `Optimistic lock failure: expected version ${expectedVersion}, got ${record.version}`,
          );
        }

        const newVersion = expectedVersion + 1n;

        if (!record) {
          store.set(actorId, {
            version: newVersion,
            patches: [{ version: newVersion, patch }],
            snapshots: [],
          });
        } else {
          record.version = newVersion;
          record.patches.push({ version: newVersion, patch });
        }

        return newVersion;
      },
    ),

    load: vi.fn(
      async (
        actorId: string,
        fromVersion = 0n,
      ): Promise<{
        snapshot: { state: StateSnapshot; version: bigint } | null;
        patches: { version: bigint; patch: Patch }[];
      }> => {
        const record = store.get(actorId);

        if (!record) {
          return {
            snapshot: null,
            patches: [],
          };
        }

        // Find the latest snapshot at or before fromVersion
        const snapshots = record.snapshots.filter(
          (s) => s.version <= fromVersion,
        );
        const latestSnapshot =
          snapshots.length > 0
            ? snapshots.reduce((latest, current) =>
                current.version > latest.version ? current : latest,
              )
            : null;

        // If we have a snapshot, return patches after the snapshot version
        // Otherwise, return patches after fromVersion
        const patchFilterVersion = latestSnapshot
          ? latestSnapshot.version
          : fromVersion;
        const patches = record.patches.filter(
          (p) => p.version > patchFilterVersion,
        );

        return {
          snapshot: latestSnapshot
            ? {
                state: superjson.parse(
                  superjson.stringify(latestSnapshot.state),
                ),
                version: latestSnapshot.version,
              }
            : null,
          patches: patches.map((p) => ({
            version: p.version,
            patch: superjson.parse(superjson.stringify(p.patch)),
          })),
        };
      },
    ),

    commitSnapshot: vi.fn(
      async (
        actorId: string,
        version: bigint,
        snapshot: StateSnapshot,
      ): Promise<void> => {
        const record = store.get(actorId);
        if (record) {
          record.snapshots.push({
            version,
            state: superjson.parse(superjson.stringify(snapshot)),
          });
          // Keep only patches after the snapshot version
          record.patches = record.patches.filter((p) => p.version > version);
        }
      },
    ),

    clear: () => {
      store.clear();
      patchStore.commit.mockClear();
      patchStore.load.mockClear();
      patchStore.commitSnapshot.mockClear();
    },
  } satisfies PatchStore & { clear: () => void };

  return patchStore;
};
