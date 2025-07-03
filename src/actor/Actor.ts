import { applyPatch } from "fast-json-patch";
import {
  /* @__PURE__ */ createDraft,
  enablePatches,
  finishDraft,
  type Patch as ImmerPatch,
  type Objectish,
} from "immer";

import type {
  ActorMetrics,
  AnyActorDefinition,
  PatchStore,
  Supervisor,
} from "../contracts";
import { RestartedError } from "../contracts";
import { clone, deepEqual, serializeComparable } from "../utils/serde";

/**
 * Escapes a JSON Pointer token according to RFC 6901.
 * '~' becomes '~0' and '/' becomes '~1'
 */
function escapeJsonPointer(token: string | number): string {
  const str = String(token);
  return str.replace(/~/g, "~0").replace(/\//g, "~1");
}

type ActorStatus = "pending" | "hydrating" | "active" | "failed" | "shutdown";

export class Actor<TState extends Objectish> {
  private state: TState | null = null;
  private version = 0n;
  private status: ActorStatus = "pending";
  private lastTouch: number = Date.now();
  private mailbox: Promise<void> = Promise.resolve();

  private hydrationPromise?: Promise<void>;
  private error?: Error;
  private snapshotInProgress = false;
  private shutdownInProgress = false;
  private lockHeld = false;
  private heartbeatInterval?: NodeJS.Timeout | undefined;

  constructor(
    private readonly id: string,
    private readonly def: AnyActorDefinition,
    private readonly store?: PatchStore,
    private readonly instanceUUID?: string,
    private readonly supervisor?: Supervisor,
    private readonly metrics?: ActorMetrics,
  ) {
    this.lastTouch = Date.now();
    enablePatches();
  }

  private get currentState(): TState {
    if (this.state === null) throw new Error("State not ready");
    return this.state;
  }

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.status === "failed" || this.status === "shutdown") {
      throw new Error(
        `Actor ${this.id} is ${this.status}. Further messages are rejected.`,
      );
    }
    const taskPromise = this.mailbox.then(async () => {
      try {
        return await task();
      } catch (error) {
        if (this.supervisor) {
          const strategy = this.supervisor.strategy(this.state, error as Error);
          switch (strategy) {
            case "resume":
              // Keep state, bubble error
              throw error;
            case "restart": {
              // Reset state and version
              // biome-ignore lint/suspicious/noExplicitAny: State can be any shape during migration
              let state: any = this.def._initialStateFn();
              for (const upcaster of this.def._upcasters) {
                state = upcaster(state);
              }
              this.state = state as TState;
              this.version = 0n;
              // Persist the restart by committing a snapshot at version 0
              if (this.store?.commitSnapshot) {
                try {
                  const latestSchemaVersion = this.def._upcasters.length + 1;
                  await this.store.commitSnapshot(this.id, 0n, {
                    schemaVersion: latestSchemaVersion,
                    state: clone(this.state),
                  });
                } catch {
                  // Ignore snapshot errors during restart
                }
              }
              throw new RestartedError(error as Error);
            }
            case "stop":
              await this.releaseLock();
              this.status = "failed";
              this.error = error as Error;
              this.metrics?.onError?.(this.id, error as Error);
              throw error;
          }
        }
        throw error;
      }
    });
    this.mailbox = taskPromise.then(
      () => {
        // Clear reference to help GC
        return undefined;
      },
      () => {
        // Clear reference to help GC
        return undefined;
      },
    );
    return taskPromise;
  }

  private async ensureActive(): Promise<void> {
    this.lastTouch = Date.now();

    switch (this.status) {
      case "active":
        return;
      case "hydrating":
        if (this.hydrationPromise) {
          await this.hydrationPromise;
          return this.ensureActive();
        }
        break;
      case "failed":
        if (this.error) throw this.error;
        break;
      case "shutdown":
        throw new Error(
          `Actor with id "${this.id}" has been shut down. A new reference must be created via get().`,
        );
      case "pending":
        await this.hydrate();
        break;
    }
  }

  private async hydrate(): Promise<void> {
    const getLatestInitialState = (): TState => {
      // biome-ignore lint/suspicious/noExplicitAny: State can be any shape during migration
      let state: any = this.def._initialStateFn();
      for (const upcaster of this.def._upcasters) {
        state = upcaster(state);
      }
      return state as TState;
    };

    if (!this.store) {
      this.state = getLatestInitialState();
      this.version = 0n;
      this.status = "active";
      return;
    }

    this.status = "hydrating";
    this.hydrationPromise = (async () => {
      try {
        // acquire lock first (if supported)
        if (this.store?.acquire && this.instanceUUID) {
          const ttlMs = 30000; // 30 seconds TTL
          const ok = await this.store.acquire(
            this.id,
            this.instanceUUID,
            ttlMs,
          );
          if (!ok)
            throw new Error(`Failed to acquire lock for actor ${this.id}`);
          this.lockHeld = true;

          // Start heartbeat to keep the lock alive
          this.heartbeatInterval = setInterval(async () => {
            if (
              this.status === "active" &&
              this.store?.acquire &&
              this.instanceUUID
            ) {
              try {
                await this.store.acquire(this.id, this.instanceUUID, ttlMs);
              } catch {
                // Ignore heartbeat errors - the lock will expire naturally
              }
            }
          }, ttlMs / 2); // Heartbeat at half the TTL interval
        }

        const loaded = await this.store?.load(this.id, 0n);
        if (loaded && (loaded.snapshot || loaded.patches.length > 0)) {
          // biome-ignore lint/suspicious/noExplicitAny: State can be any shape during migration
          let currentState: any;
          let currentVersion = 0n;
          let currentSchemaVersion = 1;

          if (loaded.snapshot) {
            const { schemaVersion, state: snapshotState } =
              loaded.snapshot.state;
            currentVersion = loaded.snapshot.version;
            currentSchemaVersion = schemaVersion;
            currentState = snapshotState;
          } else {
            // No snapshot, start from V1 initial state
            currentState = this.def._initialStateFn();
            currentVersion = 0n;
            currentSchemaVersion = 1;
          }

          // Apply patches to the state (patches are always applied to their original schema version)
          for (const patchEntry of loaded.patches) {
            const stateAsJson = serializeComparable(currentState);
            const patchResult = applyPatch(
              // biome-ignore lint/suspicious/noExplicitAny: applyPatch requires any type for state
              stateAsJson as any,
              patchEntry.patch,
            );

            // Use clone to properly deserialize the patched state
            currentState = clone(patchResult.newDocument);
            currentVersion = patchEntry.version;
          }

          // Now run upcasters to migrate to the current schema version
          const upcastersToRun = this.def._upcasters.slice(
            currentSchemaVersion - 1,
          );
          for (const upcaster of upcastersToRun) {
            currentState = upcaster(currentState);
          }

          this.state = currentState as TState;
          this.version = currentVersion;
        } else {
          this.state = getLatestInitialState();
          this.version = 0n;
        }
        this.status = "active";
        this.metrics?.onHydrate?.(this.id);
      } catch (error) {
        // Ensure lock is released on hydration failure
        await this.releaseLock();
        this.status = "failed";
        this.error = error as Error;
        this.metrics?.onError?.(this.id, error as Error);
        throw error;
      }
    })();

    await this.hydrationPromise;
  }

  /** Releases the hydration lock (if we still own it) and stops the heartbeat */
  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.store?.release && this.instanceUUID) {
      try {
        await this.store.release(this.id, this.instanceUUID);
      } catch {}
    }
  }

  async handleTell(handlerKey: string, args: unknown[]): Promise<unknown> {
    return this.enqueue(async () => {
      await this.ensureActive();
      const entry = this.def._handlers[handlerKey];
      if (!entry || entry.type !== "command") {
        throw new Error(`Handler "${handlerKey}" not found or not a command`);
      }

      const currentState = this.currentState;
      const currentVersion = this.version;

      let immerPatches: ImmerPatch[] = [];
      let returnValue: unknown;
      let nextState: TState;

      // Create a draft and execute the handler
      const draft = createDraft(currentState);
      try {
        returnValue = await Promise.resolve(entry.fn(draft, ...args));
        nextState = finishDraft(draft, (patches) => {
          immerPatches = patches;
        }) as TState;
      } catch (error) {
        finishDraft(draft); // Clean up draft on error
        throw error;
      }

      // If no patches were generated, the state didn't change
      if (immerPatches.length === 0) {
        return returnValue;
      }

      // Additional check: even if Immer generated patches, verify the state actually changed
      // This handles cases where Immer generates patches for referentially different but
      // semantically identical objects (e.g., Maps, Sets, Dates with same content)
      if (!deepEqual(currentState, nextState)) {
        // State actually changed, proceed with committing
      } else {
        // State is semantically identical, skip committing
        return returnValue;
      }

      if (this.store) {
        // Convert Immer patches to RFC-6902 format
        const jsonPatch = immerPatches.map(
          ({ op, path, value }: ImmerPatch) => ({
            op,
            path: `/${path.map(escapeJsonPointer).join("/")}`,
            value,
          }),
        );

        const newVersion = await this.store.commit(
          this.id,
          currentVersion,
          jsonPatch,
          { handler: handlerKey, payload: args, returnVal: returnValue },
        );
        this.state = nextState as TState;
        this.version = newVersion;
        this.metrics?.onAfterCommit?.(this.id, newVersion, jsonPatch);
        await this.maybeSnapshot();
      } else {
        this.state = nextState as TState;
        this.version = currentVersion + 1n;
      }
      return returnValue;
    });
  }

  async handleAsk(handlerKey: string, args: unknown[]): Promise<unknown> {
    return this.enqueue(async () => {
      await this.ensureActive();
      const entry = this.def._handlers[handlerKey];
      if (!entry || entry.type !== "query") {
        throw new Error(`Handler "${handlerKey}" not found or not a query`);
      }
      const draft = createDraft(this.currentState);
      return entry.fn(draft, ...args);
    });
  }

  async *handleStream(
    handlerKey: string,
    args: unknown[],
  ): AsyncGenerator<unknown, unknown, unknown> {
    await this.ensureActive();
    const entry = this.def._handlers[handlerKey];
    if (!entry || entry.type !== "stream") {
      throw new Error(`Handler "${handlerKey}" not found or not a stream`);
    }

    const currentState = this.currentState;
    const currentVersion = this.version;

    let immerPatches: ImmerPatch[] = [];
    let finalState: TState;

    const draftState = createDraft(currentState);
    let finalUpdate: unknown;
    try {
      const generator = entry.fn(draftState, ...args) as AsyncGenerator;
      finalUpdate = yield* generator;
    } catch (error) {
      finishDraft(draftState); // Clean up on error
      throw error; // Propagate to caller
    }
    finalState = finishDraft(draftState, (patches) => {
      immerPatches = patches;
    }) as TState;

    // If no patches were generated, the state didn't change
    if (immerPatches.length === 0) {
      return finalUpdate;
    }

    // Additional check: even if Immer generated patches, verify the state actually changed
    // This handles cases where Immer generates patches for referentially different but
    // semantically identical objects (e.g., Maps, Sets, Dates with same content)
    if (!deepEqual(currentState, finalState)) {
      // State actually changed, proceed with committing
    } else {
      // State is semantically identical, skip committing
      return finalUpdate;
    }

    if (this.store) {
      const jsonPatch = immerPatches.map(({ op, path, value }: ImmerPatch) => ({
        op,
        path: `/${path.map(escapeJsonPointer).join("/")}`,
        value,
      }));

      const newVersion = await this.store.commit(
        this.id,
        currentVersion,
        jsonPatch,
        { handler: handlerKey, payload: args, returnVal: finalUpdate },
      );
      this.state = finalState as TState;
      this.version = newVersion;
      this.metrics?.onAfterCommit?.(this.id, newVersion, jsonPatch);
      await this.maybeSnapshot();
    } else {
      this.state = finalState as TState;
      this.version = currentVersion + 1n;
    }
    return finalUpdate;
  }

  async inspect(): Promise<{ state: TState; version: bigint }> {
    await this.ensureActive();
    return {
      state: clone(this.currentState),
      version: this.version,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shutdownInProgress || this.status === "shutdown") {
      return;
    }
    this.shutdownInProgress = true;

    if (this.status === "hydrating" && this.hydrationPromise) {
      try {
        await this.hydrationPromise;
      } catch {
        // Ignore hydration error on shutdown
      }
    }
    this.status = "shutdown";

    await this.releaseLock();
  }

  async maybeSnapshot(): Promise<void> {
    if (
      this.snapshotInProgress ||
      this.status === "shutdown" ||
      !this.def._persistence?.snapshotEvery ||
      this.version % BigInt(this.def._persistence.snapshotEvery) !== 0n ||
      !this.store
    ) {
      return;
    }

    this.snapshotInProgress = true;
    try {
      this.metrics?.onBeforeSnapshot?.(this.id, this.version);
      const latestSchemaVersion = this.def._upcasters.length + 1;
      await this.store.commitSnapshot(this.id, this.version, {
        schemaVersion: latestSchemaVersion,
        state: clone(this.currentState),
      });
      this.metrics?.onSnapshot?.(this.id, this.version);
    } catch {
      // It's a non-critical error, so we swallow it to not fail the operation.
    } finally {
      this.snapshotInProgress = false;
    }
  }

  get lastActivity(): number {
    return this.lastTouch;
  }

  get isFailed(): boolean {
    return this.status === "failed";
  }
}
