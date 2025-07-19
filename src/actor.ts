import {
  applyPatches as applyImmerPatches,
  createDraft,
  enablePatches,
  finishDraft,
  type Patch as ImmerPatch,
  type Objectish,
} from "immer";
import superjson from "superjson";
import type {
  ActorMetrics,
  AnyActorDefinition,
  PersistenceAdapter,
  Supervisor,
} from "./contracts";
import { ResetError } from "./contracts";
import { clone, deepEqual } from "./utils/serde";

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
  private heartbeatInterval?: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly id: string,
    private readonly def: AnyActorDefinition,
    private readonly store?: PersistenceAdapter,
    private readonly instanceUUID?: string,
    private readonly supervisor?: Supervisor,
    private readonly metrics?: ActorMetrics,
    private readonly lockTtlMs: number = 30000,
  ) {
    this.lastTouch = Date.now();
    enablePatches();
  }

  private get currentState(): TState {
    if (this.state === null) throw new Error("State not ready");
    return this.state;
  }

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.shutdownInProgress) {
      throw new Error(
        `Actor ${this.id} is shutting down. Further messages are rejected.`,
      );
    }
    if (this.status === "failed" || this.status === "shutdown") {
      throw new Error(
        `Actor ${this.id} is ${this.status}. Further messages are rejected.`,
      );
    }
    const taskPromise = this.mailbox.then(async () => {
      try {
        return await task();
      } catch (error) {
        this.metrics?.onError?.(this.id, error as Error);
        if (this.supervisor) {
          const strategy = this.supervisor.strategy(this.state, error as Error);
          switch (strategy) {
            case "resume":
              throw error;
            case "reset": {
              if (this.store) {
                try {
                  if (typeof this.store.clearActor === "function") {
                    await this.store.clearActor(this.id);
                  }

                  const latestSchemaVersion = this.def._upcasters.length + 1;
                  const snapshotData = {
                    schemaVersion: latestSchemaVersion,
                    actorDefName: this.def._name,
                    state: clone(this.getLatestInitialState()),
                  };

                  await this.store.commitSnapshot(
                    this.id,
                    0n,
                    superjson.stringify(snapshotData),
                  );
                } catch (persistenceError) {
                  console.error(
                    `Failed to persist reset for actor ${this.id}:`,
                    persistenceError,
                  );
                  this.status = "failed";
                  this.error = persistenceError as Error;
                  this.metrics?.onError?.(this.id, persistenceError as Error);
                  throw new Error(
                    `Actor reset failed during persistence: ${
                      persistenceError instanceof Error
                        ? persistenceError.message
                        : String(persistenceError)
                    }`,
                  );
                }
              }
              // Reset in-memory state *after* persistence succeeds
              this.state = this.getLatestInitialState();
              this.version = 0n;
              throw new ResetError(error as Error);
            }
            case "stop":
              this.status = "failed";
              this.error = error as Error;
              await this.releaseLock();
              throw error;
          }
        }
        throw error;
      }
    });
    this.mailbox = taskPromise.then(
      () => undefined,
      () => undefined,
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

  private getLatestInitialState(): TState {
    // biome-ignore lint/suspicious/noExplicitAny: State can be any shape during migration
    let state: any = this.def._initialStateFn();
    for (const upcaster of this.def._upcasters) {
      state = upcaster(state);
    }
    return state as TState;
  }

  private async hydrate(): Promise<void> {
    this.status = "hydrating";
    this.hydrationPromise = (async () => {
      try {
        if (this.store?.acquire && this.instanceUUID) {
          const ok = await this.store.acquire(
            this.id,
            this.instanceUUID,
            this.lockTtlMs,
          );
          if (!ok)
            throw new Error(`Failed to acquire lock for actor ${this.id}`);
          this.lockHeld = true;

          this.heartbeatInterval = setInterval(async () => {
            if (
              this.status === "active" &&
              this.store?.acquire &&
              this.instanceUUID
            ) {
              try {
                await this.store.acquire(
                  this.id,
                  this.instanceUUID,
                  this.lockTtlMs,
                );
              } catch {
                // Ignore heartbeat errors
              }
            }
          }, this.lockTtlMs / 2);
          this.heartbeatInterval.unref();
        }

        if (this.store) {
          await this.hydrateFromPersistenceAdapter(this.store);
        } else {
          this.state = this.getLatestInitialState();
          this.version = 0n;
        }
        this.status = "active";
        this.metrics?.onHydrate?.(this.id);
      } catch (error) {
        await this.releaseLock();
        this.status = "failed";
        this.error = error as Error;
        this.metrics?.onError?.(this.id, error as Error);
        throw error;
      }
    })();

    await this.hydrationPromise;
  }

  private async hydrateFromPersistenceAdapter(
    store: PersistenceAdapter,
  ): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: State can be any shape during migration
    let currentState: any;
    let currentVersion = 0n;
    let currentSchemaVersion = 1;

    const snapshotRecord = await store.getLatestSnapshot(this.id);
    if (snapshotRecord) {
      const snapshot = superjson.parse(snapshotRecord.data) as {
        schemaVersion: number;
        actorDefName?: string;
        state: unknown;
      };

      if (snapshot.actorDefName && snapshot.actorDefName !== this.def._name) {
        throw new Error(
          `Definition mismatch: Actor '${this.id}' was created with definition '${snapshot.actorDefName}', but is being rehydrated with '${this.def._name}'.`,
        );
      }

      currentState = snapshot.state;
      currentVersion = snapshotRecord.version;
      currentSchemaVersion = snapshot.schemaVersion;
    } else {
      currentState = this.def._initialStateFn();
      currentVersion = 0n;
      currentSchemaVersion = 1;
    }

    const eventRecords = await store.getEvents(this.id, currentVersion);

    if (eventRecords.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length check ensures this exists
      const firstEventMeta = superjson.parse(eventRecords[0]!.meta) as {
        actorDefName?: string;
      };
      if (
        firstEventMeta.actorDefName &&
        firstEventMeta.actorDefName !== this.def._name
      ) {
        throw new Error(
          `Definition mismatch: Actor '${this.id}' was created with definition '${firstEventMeta.actorDefName}', but is being rehydrated with '${this.def._name}'.`,
        );
      }
    }

    for (const eventRecord of eventRecords) {
      const patches = superjson.parse(eventRecord.data) as ImmerPatch[];
      currentState = applyImmerPatches(currentState, patches);
      currentVersion = eventRecord.version;
    }

    const upcastersToRun = this.def._upcasters.slice(currentSchemaVersion - 1);
    for (const upcaster of upcastersToRun) {
      currentState = upcaster(currentState);
    }

    this.state = currentState as TState;
    this.version = currentVersion;
  }

  private async _commitUpdate(
    patches: ImmerPatch[],
    meta: {
      actorDefName: string;
      handler: string;
      payload: unknown;
      returnVal?: unknown;
    },
  ): Promise<bigint> {
    if (!this.store) {
      throw new Error("Attempted to commit without a store.");
    }
    try {
      const newVersion = this.version + 1n;
      await this.store.commitEvent(
        this.id,
        newVersion,
        superjson.stringify(patches),
        superjson.stringify(meta),
      );
      return newVersion;
    } catch (error) {
      this.status = "failed";
      this.error = error as Error;
      await this.releaseLock();
      throw error;
    }
  }

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

      const draft = createDraft(currentState);
      try {
        returnValue = await Promise.resolve(entry.fn(draft, ...args));
        nextState = finishDraft(draft, (patches) => {
          immerPatches = patches;
        }) as TState;
      } catch (error) {
        finishDraft(draft);
        throw error;
      }

      if (immerPatches.length === 0 || deepEqual(currentState, nextState)) {
        return returnValue;
      }

      if (this.store) {
        const newVersion = await this._commitUpdate(immerPatches, {
          actorDefName: this.def._name,
          handler: handlerKey,
          payload: args,
          returnVal: returnValue,
        });
        this.state = nextState as TState;
        this.version = newVersion;
        this.metrics?.onAfterCommit?.(this.id, newVersion, immerPatches);
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
      finishDraft(draftState);
      throw error;
    }
    finalState = finishDraft(draftState, (patches) => {
      immerPatches = patches;
    }) as TState;

    if (immerPatches.length === 0 || deepEqual(currentState, finalState)) {
      return finalUpdate;
    }

    if (this.store) {
      const newVersion = await this._commitUpdate(immerPatches, {
        actorDefName: this.def._name,
        handler: handlerKey,
        payload: args,
        returnVal: finalUpdate,
      });
      this.state = finalState as TState;
      this.version = newVersion;
      this.metrics?.onAfterCommit?.(this.id, newVersion, immerPatches);
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

  async terminate(): Promise<void> {
    if (this.shutdownInProgress || this.status === "shutdown") {
      return;
    }
    this.shutdownInProgress = true;

    await this.mailbox.catch(() => {});

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

  async maybeSnapshot(force = false): Promise<void> {
    if (
      this.snapshotInProgress ||
      this.status === "shutdown" ||
      !this.def._persistence?.snapshotEvery ||
      this.version === 0n ||
      (!force &&
        this.version % BigInt(this.def._persistence.snapshotEvery) !== 0n) ||
      !this.store
    ) {
      return;
    }

    this.snapshotInProgress = true;
    try {
      this.metrics?.onBeforeSnapshot?.(this.id, this.version);
      const latestSchemaVersion = this.def._upcasters.length + 1;
      const snapshotData = {
        schemaVersion: latestSchemaVersion,
        actorDefName: this.def._name,
        state: clone(this.currentState),
      };

      await this.store.commitSnapshot(
        this.id,
        this.version,
        superjson.stringify(snapshotData),
      );

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

  get isShutdown(): boolean {
    return this.status === "shutdown" || this.shutdownInProgress;
  }
}
