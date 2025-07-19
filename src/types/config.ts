import type { ActorRef, AnyActorDefinition } from "./actor";
import type { Patch } from "./util";

/**
 * The interface for a persistence adapter, which handles storing and retrieving
 * actor events and snapshots.
 */
export interface PersistenceAdapter {
  getEvents(
    actorId: string,
    fromVersion: bigint,
  ): Promise<{ version: bigint; data: string; meta: string }[]>;

  commitEvent(
    actorId: string,
    version: bigint,
    data: string,
    meta: string,
  ): Promise<void>;

  getLatestSnapshot(
    actorId: string,
  ): Promise<{ version: bigint; data: string } | null>;

  commitSnapshot(actorId: string, version: bigint, data: string): Promise<void>;

  acquire?(actorId: string, ownerId: string, ttlMs: number): Promise<boolean>;

  release?(actorId: string, ownerId: string): Promise<void>;

  clearActor?(actorId: string): Promise<void>;
}

/**
 * The strategies a supervisor can choose to handle an error.
 */
export type SupervisorStrategy = "resume" | "reset" | "stop";

/**
 * The interface for a supervisor, which defines the error handling strategy for actors.
 */
export interface Supervisor {
  strategy(state: unknown, error: Error): SupervisorStrategy;
}

/**
 * The interface for actor metrics callbacks, allowing integration with logging
 * and monitoring systems.
 */
export interface ActorMetrics {
  onHydrate?: (id: string) => void;
  onSnapshot?: (id: string, version: bigint) => void;
  onEvict?: (id: string) => void;
  onError?: (id: string, error: Error) => void;
  onBeforeSnapshot?: (id: string, version: bigint) => void;
  onAfterCommit?: (id: string, version: bigint, patch: Patch) => void;
}

/**
 * The configuration object for creating a new `ActorManager`.
 */
export interface ActorManagerConfig<TDef extends AnyActorDefinition> {
  definition: TDef;
  store?: PersistenceAdapter;
  passivation?: {
    idleAfter: number; // ms
    sweepInterval?: number; // ms, default 60_000
  };
  supervisor?: Supervisor;
  metrics?: ActorMetrics;
  lockTtlMs?: number;
}

/**
 * The central manager for all actor instances of a given definition.
 */
export interface ActorManager<TDef extends AnyActorDefinition> {
  get(id: string): ActorRef<TDef>;
  terminate(): Promise<void>;
}
