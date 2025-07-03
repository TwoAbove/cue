import type { Operation } from "fast-json-patch";
import type { createDraft, Objectish } from "immer";

export type Patch = readonly Operation[];

export interface StateSnapshot {
  schemaVersion: number;
  state: unknown;
}

export interface PatchStore {
  commit(
    actorId: string,
    expectedVersion: bigint,
    patch: Patch,
    meta?: { handler: string; payload: unknown; returnVal?: unknown },
  ): Promise<bigint>;

  load(
    actorId: string,
    fromVersion: bigint,
  ): Promise<{
    snapshot: { state: StateSnapshot; version: bigint } | null;
    patches: { version: bigint; patch: Patch }[];
  }>;

  commitSnapshot(
    actorId: string,
    version: bigint,
    snapshot: StateSnapshot,
  ): Promise<void>;

  acquire?(actorId: string, owner: string, ttlMs?: number): Promise<boolean>;
  release?(actorId: string, owner: string): Promise<void>;
}

export class RestartedError extends Error {
  constructor(original: Error) {
    super(`Actor restarted after error: ${original.message}`);
    this.cause = original;
    this.name = "RestartedError";
  }
}

export type SupervisorStrategy = "resume" | "restart" | "stop";

export interface Supervisor {
  strategy(state: unknown, error: Error): SupervisorStrategy;
}

export interface ActorMetrics {
  onHydrate?: (id: string) => void;
  onSnapshot?: (id: string, version: bigint) => void;
  onEvict?: (id: string) => void;
  onError?: (id: string, error: Error) => void;
  onBeforeSnapshot?: (id: string, version: bigint) => void;
  onAfterCommit?: (id: string, version: bigint, patch: Patch) => void;
}

/**
 * Configuration for creating an ActorManager.
 */
export interface ActorManagerConfig<TDef extends AnyActorDefinition> {
  definition: TDef;
  store?: PatchStore;
  passivation?: {
    idleAfter: number; // ms
    sweepInterval?: number; // ms, default 60_000
  };
  supervisor?: Supervisor;
  metrics?: ActorMetrics;
}

/**
 * Manages the lifecycle of all actors of a specific definition.
 */
export interface ActorManager<TDef extends AnyActorDefinition> {
  /**
   * Retrieves a reference to an actor by its ID.
   * If the actor is not in memory, it will be rehydrated from the persistence layer.
   * If the actor does not exist, it will be created.
   * @param id The unique ID of the actor.
   */
  get(id: string): ActorRef<TDef>;
  /**
   * Shuts down all actors managed by this manager and cleans up resources.
   */
  shutdown(): Promise<void>;
}

export type ActorRef<TDef extends AnyActorDefinition> = {
  readonly ask: AskProxy<TDef>;
  readonly tell: TellProxy<TDef>;
  readonly stream: StreamProxy<TDef>;
  inspect(): Promise<{ state: StateOf<TDef>; version: bigint }>;
  shutdown(): Promise<void>;
};

/**
 * Utility type to extract the state type from an ActorDefinition.
 */
export type StateOf<TDef extends AnyActorDefinition> = TDef["_state"];

export type ActorVerb = "tell" | "ask" | "stream";

export type CreateCommandMessage<THandler extends AnyHandler> =
  ReturnType<THandler> extends AsyncGenerator<
    infer TProgress,
    infer TReturn,
    unknown
  >
    ? {
        verb: "stream";
        payload: PayloadOf<THandler>;
        progress: TProgress;
        return: Awaited<TReturn>;
      }
    : {
        verb: "tell";
        payload: PayloadOf<THandler>;
        return: Awaited<ReturnType<THandler>>;
      };

export type CreateQueryMessage<THandler extends AnyHandler> = {
  verb: "ask";
  payload: PayloadOf<THandler>;
  return: Awaited<ReturnType<THandler>>;
};

// biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
export type AnyHandler = (...args: any[]) => unknown;

export type PayloadOf<F> =
  /* state-ful command / stream */
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
  F extends (state: Draft<any>, ...args: infer P) => unknown
    ? P
    : /* read-only query */
      // biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
      F extends (state: Readonly<any>, ...args: infer P) => unknown
      ? P
      : /* helper with no state arg (tests, utilities, etc.) */
        F extends (...args: infer P) => unknown
        ? P
        : never;

export type CreateMessageMap<
  TCommands extends Record<string, AnyHandler>,
  TQueries extends Record<string, AnyHandler>,
> = {
  [K in keyof TCommands]: CreateCommandMessage<TCommands[K]>;
} & {
  [K in keyof TQueries]: CreateQueryMessage<TQueries[K]>;
};

export type MessageMap = Record<string, MessageDefinition<ActorVerb>>;

type MessageDefinition<V extends ActorVerb> = {
  verb: V;
  payload: unknown[];
  progress?: unknown; // only for "stream"
  return: unknown;
};

export type ActorDefinition<
  TName extends string,
  TState,
  TMessages extends MessageMap,
> = {
  readonly _name: TName;
  readonly _state: TState;
  readonly _messages: TMessages;
  readonly _tag: "ActorDefinition";
};

export type VersionEntry<TPrevState, TNewState> =
  | {
      schemaVersion: 1;
      initialState: () => TNewState;
      upcaster?: never;
    }
  | {
      schemaVersion: number;
      initialState: () => TNewState;
      upcaster: (prevState: TPrevState) => TNewState;
    };

/** @internal Invisible fields used by the framework but not exposed to the user. */
export type InternalDefinitionFields<_TState = unknown> = {
  readonly _initialStateFn: () => object;
  // biome-ignore lint/suspicious/noExplicitAny: Upcasters must handle any previous state shape
  readonly _upcasters: ReadonlyArray<(prevState: any) => any>;
  readonly _handlers: Record<
    string,
    | { type: "command"; fn: AnyHandler }
    | { type: "stream"; fn: AnyHandler }
    | { type: "query"; fn: AnyHandler }
  >;
  readonly _persistence?: {
    snapshotEvery?: number;
  };
};

// biome-ignore lint/suspicious/noExplicitAny: This is intentional
export type AnyActorDefinition = ActorDefinition<string, any, any> &
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  InternalDefinitionFields<any>;

export type MessagesOf<TDef extends AnyActorDefinition> = TDef["_messages"];

export type FilterMessages<TMap, TVerb> = {
  [K in keyof TMap as TMap[K] extends { verb: TVerb } ? K : never]: TMap[K];
};

export type TellProxyOf<TDef extends AnyActorDefinition> = {
  [K in keyof FilterMessages<MessagesOf<TDef>, "tell" | "stream">]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<MessagesOf<TDef>[K]["return"]>;
};

export type AskProxyOf<TDef extends AnyActorDefinition> = {
  [K in keyof FilterMessages<MessagesOf<TDef>, "ask">]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<Extract<MessagesOf<TDef>[K], { verb: "ask" }>["return"]>;
};

export type StreamProxyOf<TDef extends AnyActorDefinition> = {
  [K in keyof FilterMessages<MessagesOf<TDef>, "stream">]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => AsyncIterable<
    Extract<MessagesOf<TDef>[K], { verb: "stream" }>["progress"]
  >;
};

type TellProxy<TDef extends AnyActorDefinition> = TellProxyOf<TDef>;
type AskProxy<TDef extends AnyActorDefinition> = AskProxyOf<TDef>;
type StreamProxy<TDef extends AnyActorDefinition> = StreamProxyOf<TDef>;

/**
 * A safer alternative to Objectish that works with exactOptionalPropertyTypes
 */
export type Draftable<T> = T extends object ? Draft<T> : never;

/**
 * A utility type that marks a type as being mutable within a command handler,
 * compatible with Immer's Draft type.
 */
export type Draft<T> = T extends Objectish
  ? ReturnType<typeof createDraft<T>>
  : never;

/**
 * Branded type to ensure handler-state cohesion at compile time.
 * This prevents commands from mutating properties that don't exist in the initial state.
 */
export type DraftStateOf<TDef extends AnyActorDefinition> = Draft<
  TDef["_state"]
> & { __brand?: never };
