import type { createDraft, Patch as ImmerPatch } from "immer";
import type { PersistenceAdapter } from "../persistence/types";
import type {
  _handlers,
  _initialStateFn,
  _messages,
  _name,
  _persistence,
  _state,
  _tag,
  _upcasters,
  _versions,
} from "./internal";

// biome-ignore lint/suspicious/noExplicitAny: This is intentional for a generic handler type
export type AnyHandler = (...args: any[]) => any;
export type Patch = readonly ImmerPatch[];
export type Draft<T> = T extends object
  ? ReturnType<typeof createDraft<T>>
  : never;

export interface HandlerContext {
  self: { id: string; isFailed: boolean };
  clock: { now(): number };
  meta: { managerId: string; defName: string };
}

// MESSAGES
type MessageDefinition<V extends "tell" | "ask" | "stream"> = {
  verb: V;
  payload: unknown[];
  progress?: unknown;
  return: unknown;
};

export type MessageMap = Record<
  string,
  MessageDefinition<"tell" | "ask" | "stream">
>;

export type PayloadOf<F> = F extends (
  // biome-ignore lint/suspicious/noExplicitAny: for inference
  state: any,
  ...args: infer A
) => unknown
  ? A extends [...infer P, HandlerContext]
    ? P
    : A
  : never;

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

export type CreateMessageMap<
  TCommands extends Record<string, AnyHandler>,
  TQueries extends Record<string, AnyHandler>
> = {
  [K in keyof TCommands]: CreateCommandMessage<TCommands[K]>;
} & {
  [K in keyof TQueries]: CreateQueryMessage<TQueries[K]>;
};

// ENTITY DEFINITION & REF
export type EntityDefinition<
  TName extends string,
  TState,
  TMessages extends MessageMap
> = {
  readonly [_name]: TName;
  readonly [_state]: TState;
  readonly [_messages]: TMessages;
  readonly [_tag]: "EntityDefinition";
};

export type AnyEntityDefinition = EntityDefinition<
  string,
  object,
  Record<string, never>
> &
  InternalDefinitionFields;

export type HandlerEntry =
  | { type: "command"; fn: AnyHandler }
  | { type: "stream"; fn: AnyHandler }
  | { type: "query"; fn: AnyHandler };

export type InternalDefinitionFields<TState extends object = object> = {
  readonly [_name]: string;
  readonly [_state]: TState;
  readonly [_messages]: MessageMap;
  readonly [_tag]: "EntityDefinition";
  readonly [_initialStateFn]: () => TState;
  // biome-ignore lint/suspicious/noExplicitAny: upcasters handle any previous state
  readonly [_upcasters]: ReadonlyArray<(prevState: any) => any>;
  readonly [_handlers]: Record<string, HandlerEntry>;
  readonly [_persistence]?: { snapshotEvery?: number };
};

export type BuiltEntityDefinition<
  TName extends string = string,
  TState extends object = object,
  TMessages extends MessageMap = MessageMap,
  TVersions extends object[] = object[],
> = EntityDefinition<TName, TState, TMessages> & {
  readonly [_initialStateFn]: () => TVersions[0];
  // biome-ignore lint/suspicious/noExplicitAny: upcasters handle any previous state
  readonly [_upcasters]: ReadonlyArray<(prevState: any) => any>;
  readonly [_handlers]: Record<string, HandlerEntry>;
  readonly [_versions]: TVersions;
  readonly [_persistence]?: { snapshotEvery?: number };
};

export type StateOf<TDef extends AnyEntityDefinition> = TDef[typeof _state];
export type MessagesOf<TDef extends AnyEntityDefinition> =
  TDef[typeof _messages];

export type SendProxy<TDef extends AnyEntityDefinition> = {
  [K in keyof MessagesOf<TDef> as MessagesOf<TDef>[K] extends {
    verb: "tell" | "stream";
  }
    ? K
    : never]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<MessagesOf<TDef>[K]["return"]>;
};

export type ReadProxy<TDef extends AnyEntityDefinition> = {
  [K in keyof MessagesOf<TDef> as MessagesOf<TDef>[K] extends { verb: "ask" }
    ? K
    : never]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<MessagesOf<TDef>[K]["return"]>;
};

export type StreamProxy<TDef extends AnyEntityDefinition> = {
  [K in keyof MessagesOf<TDef> as MessagesOf<TDef>[K] extends {
    verb: "stream";
  }
    ? K
    : never]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => AsyncIterable<MessagesOf<TDef>[K]["progress"]>;
};

export type EntityRef<TDef extends AnyEntityDefinition> = {
  readonly read: ReadProxy<TDef>;
  readonly send: SendProxy<TDef>;
  readonly stream: StreamProxy<TDef>;
  snapshot(): Promise<{ state: StateOf<TDef>; version: bigint }>;
  stateAt(eventVersion: bigint): Promise<HistoryOf<TDef>>;
  stop(): Promise<void>;
};

// MANAGER & CONFIG
export type SupervisorStrategy = "resume" | "reset" | "stop";

export interface Supervisor {
  strategy(state: unknown, error: Error): SupervisorStrategy;
}

export interface EntityMetrics {
  onHydrate?: (id: string) => void;
  onHydrateFallback?: (id: string, reason: string) => void;
  onSnapshot?: (id: string, version: bigint) => void;
  onEvict?: (id: string) => void;
  onError?: (id: string, error: Error) => void;
  onBeforeSnapshot?: (id: string, version: bigint) => void;
  onAfterCommit?: (id: string, version: bigint, patch: Patch) => void;
}

export interface EntityManagerConfig<TDef extends AnyEntityDefinition> {
  definition: TDef;
  store?: PersistenceAdapter;
  passivation?: {
    idleAfter: number;
    sweepInterval?: number;
  };
  supervisor?: Supervisor;
  metrics?: EntityMetrics;
}

export interface EntityManager<TDef extends AnyEntityDefinition> {
  get(id: string): EntityRef<TDef>;
  stop(): Promise<void>;
}

// TEMPORAL SCRUBBING TYPES

/**
 * Converts a tuple of state types into a discriminated union for type narrowing.
 *
 * BuildHistoryUnion<[A, B, C]> produces:
 * | { schemaVersion: 1; state: A }
 * | { schemaVersion: 2; state: B }
 * | { schemaVersion: 3; state: C }
 */
type BuildHistoryUnion<
  Versions extends object[],
  Counter extends unknown[] = [unknown]
> = Versions extends [infer Head extends object, ...infer Tail extends object[]]
  ?
      | { schemaVersion: Counter["length"]; state: Head }
      | BuildHistoryUnion<Tail, [...Counter, unknown]>
  : never;

/**
 * Extract the full history union from a definition.
 * Enables type-safe temporal scrubbing with discriminated unions.
 */
export type HistoryOf<TDef extends AnyEntityDefinition> = TDef extends {
  readonly [_versions]: infer V extends object[];
}
  ? BuildHistoryUnion<V>
  : { schemaVersion: number; state: unknown };

/**
 * Extract a specific schema version's state type from a definition.
 *
 * Usage:
 *   type CharacterV1 = VersionState<typeof Character, 1>;
 */
export type VersionState<
  TDef extends AnyEntityDefinition,
  V extends number
> = Extract<HistoryOf<TDef>, { schemaVersion: V }>["state"];

/** The initial state shape (schema version 1). */
export type InitialState<TDef extends AnyEntityDefinition> = VersionState<
  TDef,
  1
>;

/** The current/latest state shape. Alias for StateOf. */
export type CurrentState<TDef extends AnyEntityDefinition> = StateOf<TDef>;
