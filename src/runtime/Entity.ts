import { applyPatches, type Patch as ImmerPatch } from "immer";
import { Evolution } from "../core/Evolution";
import { StateKernel } from "../core/StateKernel";
import {
  CommitError,
  DefinitionMismatchError,
  HydrationError,
  OutOfOrderEventsError,
  StoppedEntityError,
} from "../errors";
import type {
  EventEnvelope,
  PersistenceAdapter,
  SnapshotEnvelope,
} from "../persistence/types";
import { clone, deserialize, serialize } from "../serde";
import {
  STREAM_ENTITY_DEF_NAME,
  STREAM_SCHEMA_VERSION,
} from "../stream/constants";
import type {
  StreamChunkEnvelope,
  StreamEndEnvelope,
  StreamRun,
} from "../stream/types";
import {
  _handlers,
  _initialStateFn,
  _name,
  _persistence,
  _upcasters,
} from "../types/internal";
import type {
  AnyEntityDefinition,
  EntityMetrics,
  Patch,
  Supervisor,
} from "../types/public";
import type { Clock } from "../utils/clock";
import { WallClock } from "../utils/clock";
import { newId } from "../utils/id";
import { Mailbox } from "./Mailbox";
import { Supervise } from "./Supervision";

type EntityStatus = "pending" | "hydrating" | "active" | "failed" | "stopped";

export class Entity<TState extends object> {
  private kernel: StateKernel<TState>;
  private status: EntityStatus = "pending";
  private mailbox = new Mailbox();
  private lastTouch: number;
  private error?: Error;
  private hydrationPromise?: Promise<void>;

  constructor(
    public readonly id: string,
    private readonly def: AnyEntityDefinition,
    private readonly managerId: string,
    private readonly store?: PersistenceAdapter,
    private readonly supervisor?: Supervisor,
    private readonly metrics?: EntityMetrics,
    private readonly clock: Clock = WallClock,
  ) {
    this.kernel = new StateKernel(this.def);
    this.lastTouch = this.clock.now();
  }

  get isFailed(): boolean {
    return this.status === "failed";
  }

  get isShutdown(): boolean {
    return this.status === "stopped";
  }

  get lastActivity(): number {
    return this.lastTouch;
  }

  public tell = (handlerName: string, args: unknown[]): Promise<unknown> => {
    return this.mailbox.enqueue(async () => {
      await this.ensureActive();

      const task = async () => {
        const entry = this.def[_handlers][handlerName];
        if (entry?.type === "stream") {
          const stream = this.kernel.startStream(
            handlerName,
            args,
            this.buildContext(),
          );
          let finalReturn: unknown;
          try {
            while (true) {
              const r = await stream.generator.next();
              if (r.done) {
                finalReturn = r.value;
                break;
              }
            }
            const { patches, nextState } = stream.finalize();
            if (patches.length > 0) {
              await this.commit(
                handlerName,
                args,
                finalReturn,
                patches,
                nextState,
              );
            }
          } catch (e) {
            stream.discard();
            throw e;
          }
          return finalReturn;
        }

        const { returnValue, patches, nextState } =
          await this.kernel.applyCommand(
            handlerName,
            args,
            this.buildContext(),
          );
        if (patches.length > 0) {
          await this.commit(handlerName, args, returnValue, patches, nextState);
        }
        return returnValue;
      };

      if (this.supervisor) {
        return Supervise(
          task,
          this.kernel.state,
          this.supervisor,
          this.onReset,
          this.onStop,
        );
      }
      return task();
    });
  };

  public ask = (handlerName: string, args: unknown[]): Promise<unknown> => {
    return this.mailbox.enqueue(async () => {
      await this.ensureActive();
      return this.kernel.runQuery(handlerName, args, this.buildContext());
    });
  };

  public stream = (
    handlerName: string,
    args: unknown[],
  ): StreamRun<unknown> => {
    const self = this;
    const streamId = `${this.id}:${handlerName}:${newId()}`;

    type ChannelItem =
      | { type: "value"; value: unknown }
      | { type: "done" }
      | { type: "error"; error: unknown };

    const channel: ChannelItem[] = [];
    let consumerWaiting: ((item: ChannelItem) => void) | null = null;
    let producerWaiting: {
      resolve: () => void;
      reject: (e: Error) => void;
    } | null = null;
    let aborted = false;
    let currentSeq = 0n;
    let isLive = true;

    function push(item: ChannelItem) {
      if (consumerWaiting) {
        const resolve = consumerWaiting;
        consumerWaiting = null;
        resolve(item);
      } else {
        channel.push(item);
      }
    }

    function pull(): Promise<ChannelItem> {
      const queued = channel.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        consumerWaiting = resolve;
      });
    }

    function signalProducerContinue() {
      if (producerWaiting) {
        const { resolve } = producerWaiting;
        producerWaiting = null;
        resolve();
      }
    }

    function signalProducerAbort() {
      aborted = true;
      if (producerWaiting) {
        const { reject } = producerWaiting;
        producerWaiting = null;
        reject(new Error("stream aborted"));
      }
    }

    async function commitStreamChunk(value: unknown): Promise<void> {
      if (!self.store) return;
      currentSeq += 1n;
      const envelope: StreamChunkEnvelope = {
        entityDefName: STREAM_ENTITY_DEF_NAME,
        schemaVersion: STREAM_SCHEMA_VERSION,
        handler: "chunk",
        payload: [value],
        patches: [],
      };
      await self.store.commitEvent(streamId, currentSeq, serialize(envelope));
    }

    async function commitStreamEnd(
      state: "complete" | "error",
      error?: string,
    ): Promise<void> {
      if (!self.store) return;
      currentSeq += 1n;
      const payload: StreamEndEnvelope["payload"][0] = { state };
      if (error) {
        payload.error = error;
      }
      const envelope: StreamEndEnvelope = {
        entityDefName: STREAM_ENTITY_DEF_NAME,
        schemaVersion: STREAM_SCHEMA_VERSION,
        handler: "end",
        payload: [payload],
        patches: [],
      };
      await self.store.commitEvent(streamId, currentSeq, serialize(envelope));
    }

    const mailboxTask = self.mailbox.enqueue(async () => {
      await self.ensureActive();
      const stream = self.kernel.startStream(
        handlerName,
        args,
        self.buildContext(),
      );

      try {
        for await (const value of stream.generator) {
          await commitStreamChunk(value);
          push({ type: "value", value });
          await new Promise<void>((resolve, reject) => {
            producerWaiting = { resolve, reject };
          });
        }
        push({ type: "done" });
        await commitStreamEnd("complete");
      } catch (e) {
        if (!aborted) {
          stream.discard();
          const errorMsg = e instanceof Error ? e.message : String(e);
          await commitStreamEnd("error", errorMsg);
          push({ type: "error", error: e });
          return;
        }
        // If aborted by consumer, still write end event
        await commitStreamEnd("complete");
      }

      const { patches, nextState } = stream.finalize();
      if (patches.length > 0) {
        await self.commit(handlerName, args, undefined, patches, nextState);
      }
    });

    async function* outerGenerator(): AsyncGenerator<unknown, void, unknown> {
      try {
        while (true) {
          const item = await pull();
          if (item.type === "done") {
            isLive = false;
            return;
          }
          if (item.type === "error") {
            isLive = false;
            throw item.error;
          }
          yield item.value;
          signalProducerContinue();
        }
      } finally {
        signalProducerAbort();
        await mailboxTask;
        isLive = false;
      }
    }

    const streamRun: StreamRun<unknown> = {
      id: streamId,
      get seq() {
        return currentSeq;
      },
      get isLive() {
        return isLive;
      },
      [Symbol.asyncIterator]() {
        return outerGenerator();
      },
    };

    return streamRun;
  };

  public inspect = async (): Promise<{ state: TState; version: bigint }> => {
    await this.ensureActive();
    return {
      state: clone(this.kernel.state),
      version: this.kernel.version,
    };
  };

  public terminate = async (): Promise<void> => {
    if (this.isShutdown) return;
    await this.mailbox.enqueue(async () => {
      this.status = "stopped";
    });
  };

  public stateAt = async (
    targetVersion: bigint,
  ): Promise<{ schemaVersion: number; state: unknown }> => {
    if (!this.store) {
      throw new Error("stateAt requires a persistence store");
    }

    const snapshotRec = await this.store.getLatestSnapshot(this.id);

    let state: unknown;
    let schemaVersion: number;
    let currentVersion: bigint;

    if (snapshotRec && snapshotRec.version <= targetVersion) {
      const envelope = deserialize<SnapshotEnvelope>(snapshotRec.data);
      state = envelope.state;
      schemaVersion = envelope.schemaVersion;
      currentVersion = snapshotRec.version;
    } else {
      state = this.def[_initialStateFn]();
      schemaVersion = 1;
      currentVersion = 0n;
    }

    const events = await this.store.getEvents(this.id, currentVersion);

    for (const eventRec of events) {
      if (eventRec.version > targetVersion) break;

      const envelope = deserialize<EventEnvelope>(eventRec.data);

      if (envelope.schemaVersion > schemaVersion) {
        state = Evolution.applyUpcastersTo(
          state,
          schemaVersion,
          envelope.schemaVersion,
          this.def,
        );
        schemaVersion = envelope.schemaVersion;
      }

      state = applyPatches(state as object, envelope.patches as ImmerPatch[]);
    }

    return {
      schemaVersion,
      state: clone(state),
    };
  };

  private async commit(
    handlerName: string,
    payload: unknown[],
    returnVal: unknown,
    patches: Patch,
    nextState: TState,
  ) {
    if (!this.store) {
      this.kernel.applyCommittedState(nextState);
      return;
    }

    const newVersion = this.kernel.version + 1n;
    const envelope: EventEnvelope = {
      entityDefName: this.def[_name],
      schemaVersion: this.def[_upcasters].length + 1,
      handler: handlerName,
      payload,
      returnVal,
      patches,
    };

    try {
      await this.store.commitEvent(this.id, newVersion, serialize(envelope));
      this.kernel.applyCommittedState(nextState);
      this.metrics?.onAfterCommit?.(this.id, newVersion, patches);
      await this.maybeSnapshot();
    } catch (err) {
      this.status = "failed";
      this.error = new CommitError("Failed to commit event", { cause: err });
      throw this.error;
    }
  }

  private async ensureActive(): Promise<void> {
    this.lastTouch = this.clock.now();
    if (this.status === "active") return;
    if (this.status === "hydrating") return this.hydrationPromise;
    if (this.status === "failed" || this.status === "stopped")
      throw new StoppedEntityError(this.id);
    if (this.status === "pending") await this.hydrate();
  }

  private async hydrate(): Promise<void> {
    this.status = "hydrating";
    this.hydrationPromise = (async () => {
      try {
        if (!this.store) {
          this.kernel.initialiseInMemory();
        } else {
          const snapshotRec = await this.store.getLatestSnapshot(this.id);
          let baseState: TState;
          let baseVersion: bigint;
          let schemaVersion: number;

          if (snapshotRec) {
            const snapshot = deserialize<SnapshotEnvelope>(snapshotRec.data);
            if (snapshot.entityDefName !== this.def[_name])
              throw new DefinitionMismatchError(
                `Hydrating entity '${this.id}' with definition '${this.def[_name]}', but snapshot is from '${snapshot.entityDefName}'.`,
              );
            baseState = snapshot.state as TState;
            baseVersion = snapshotRec.version;
            schemaVersion = snapshot.schemaVersion;
          } else {
            baseState = this.def[_initialStateFn]() as TState;
            baseVersion = 0n;
            schemaVersion = 1;
          }

          const eventRecs = await this.store.getEvents(this.id, baseVersion);
          const events: Array<{ schemaVersion: number; patches: Patch }> = [];
          let expectedVersion = baseVersion + 1n;
          for (const rec of eventRecs) {
            if (rec.version !== expectedVersion)
              throw new OutOfOrderEventsError(
                `Hydrating entity '${this.id}': expected event version ${expectedVersion}, but got ${rec.version}.`,
              );
            const envelope = deserialize<EventEnvelope>(rec.data);
            events.push({
              schemaVersion: envelope.schemaVersion,
              patches: envelope.patches,
            });
            expectedVersion++;
          }
          this.kernel.hydrate({
            baseState,
            baseVersion,
            schemaVersion,
            events,
          });
        }
        this.status = "active";
        this.metrics?.onHydrate?.(this.id);
      } catch (err) {
        this.status = "failed";
        this.error = new HydrationError(
          `Failed to hydrate entity '${this.id}'`,
          { cause: err },
        );
        this.metrics?.onError?.(this.id, this.error);
        throw this.error;
      }
    })();
    await this.hydrationPromise;
  }

  public async maybeSnapshot(force = false) {
    const config = this.def[_persistence];
    if (!this.store || !config?.snapshotEvery) return;
    if (force || this.kernel.version % BigInt(config.snapshotEvery) === 0n) {
      try {
        this.metrics?.onBeforeSnapshot?.(this.id, this.kernel.version);
        const envelope: SnapshotEnvelope = {
          entityDefName: this.def[_name],
          schemaVersion: this.def[_upcasters].length + 1,
          state: this.kernel.state,
        };
        await this.store.commitSnapshot(
          this.id,
          this.kernel.version,
          serialize(envelope),
        );
        this.metrics?.onSnapshot?.(this.id, this.kernel.version);
      } catch (err) {
        this.metrics?.onError?.(
          this.id,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  private onReset = async (): Promise<void> => {
    try {
      await this.store?.clearEntity?.(this.id);
    } finally {
      this.kernel.initialiseInMemory();
      this.status = "active";
    }
  };

  private onStop = (): never => {
    this.status = "failed";
    this.error = new Error("Entity stopped by supervisor");
    throw new StoppedEntityError(this.id);
  };

  private buildContext() {
    return {
      self: { id: this.id, isFailed: this.isFailed },
      clock: this.clock,
      meta: { managerId: this.managerId, defName: this.def[_name] },
    };
  }
}
