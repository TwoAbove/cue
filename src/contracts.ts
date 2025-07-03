import type { Operation } from "fast-json-patch";
import type { Objectish, createDraft } from "immer";

/**
 * PersistenceAdapter is an interface for actor state persistence.
 */
export type PersistedEvent =
  | {
      readonly type: "CREATE";
      readonly actorId: string;
      readonly actorDefName: string;
      readonly initialState: unknown;
    }
  | {
      readonly type: "UPDATE";
      readonly actorId: string;
      /** The version of the state *after* this patch is applied. */
      readonly version: bigint;
      readonly patch: Operation[];
    }
  | {
      readonly type: "SNAPSHOT";
      readonly actorId: string;
      readonly version: bigint;
      readonly state: unknown;
    };

/**
 * An interface for connecting an actor system to an external persistence store.
 * Implement this interface to save and load actor states.
 */
export interface PersistenceAdapter {
  /**
   * Persists an event to the store. This can be a creation, update, or snapshot event.
   * The implementation should handle storing the event atomically.
   * @param event The event to persist.
   */
  persist(event: PersistedEvent): Promise<void>;

  /**
   * Loads an actor's state from the persistence store.
   * It should return the most recent snapshot (baseState and baseVersion)
   * and all subsequent patches in order. If no snapshot exists, it should
   * return the initial state with a baseVersion of 0 and all patches since creation.
   * @param actorId The ID of the actor to load.
   * @returns The actor's data or null if not found.
   */
  load(actorId: string): Promise<{
    baseState: unknown;
    baseVersion: bigint;
    patches: Operation[][];
    actorDefName: string;
  } | null>;
}

/**
 * Configuration for creating an ActorManager.
 */
export interface ActorManagerConfig<TDef extends AnyActorDefinition> {
  definition: TDef;
  persistence?: PersistenceAdapter;
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

// biome-ignore lint/suspicious/noExplicitAny: internal escape hatch – safe at call-site
export type CreateCommandMessage<THandler extends (...args: any[]) => unknown> =
  ReturnType<THandler> extends AsyncGenerator<
    infer TProgress,
    infer TReturn,
    unknown
  >
    ? {
        type: "StreamingCommand";
        payload: PayloadOf<THandler>;
        progress: TProgress;
        return: Awaited<TReturn>;
      }
    : {
        type: "Command";
        payload: PayloadOf<THandler>;
        return: Awaited<ReturnType<THandler>>;
      };

// biome-ignore lint/suspicious/noExplicitAny: internal escape hatch – safe at call-site
export type CreateQueryMessage<THandler extends (...args: any[]) => unknown> = {
  type: "Query";
  payload: PayloadOf<THandler>;
  return: Awaited<ReturnType<THandler>>;
};

/** Extract the payload tuple from a handler: `(state, ...args) => R` becomes `...args` */
// biome-ignore lint/suspicious/noExplicitAny: Using any makes this utility maximally flexible. The type it produces (P) is inferred from the actual function we pass to it.
export type PayloadOf<F> = F extends (state: any, ...args: infer P) => unknown
  ? P
  : never;

// biome-ignore lint/suspicious/noExplicitAny: internal escape hatch – safe at call-site
export type AnyHandler = (state: any, ...args: any[]) => unknown;

export type CreateMessageMap<
  // biome-ignore lint/suspicious/noExplicitAny: internal escape hatch – safe at call-site
  TCommands extends Record<string, (...args: any[]) => unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: internal escape hatch – safe at call-site
  TQueries extends Record<string, (...args: any[]) => unknown>,
> = {
  [K in keyof TCommands]: CreateCommandMessage<TCommands[K]>;
} & {
  [K in keyof TQueries]: CreateQueryMessage<TQueries[K]>;
};

export type MessageMap = Record<string, MessageDefinition>;
type MessageDefinition =
  | { type: "Command"; payload: unknown[]; return: unknown }
  | {
      type: "StreamingCommand";
      payload: unknown[];
      progress: unknown;
      return: unknown;
    }
  | { type: "Query"; payload: unknown[]; return: unknown };

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

/** @internal Invisible fields used by the framework but not exposed to the user. */
export type InternalDefinitionFields<TState> = {
  readonly _initialState: () => TState;
  readonly _handlers: Record<
    string,
    { type: "command" | "query" | "stream"; fn: AnyHandler }
  >;
  readonly _persistence?: { snapshotEvery?: number };
};

// biome-ignore lint/suspicious/noExplicitAny: This is intentional
export type AnyActorDefinition = ActorDefinition<string, any, any> &
  // biome-ignore lint/suspicious/noExplicitAny: This is intentional
  InternalDefinitionFields<any>;

type MessagesOf<TDef extends AnyActorDefinition> = TDef["_messages"];

export type FilterMessages<TMap, TType> = {
  [K in keyof TMap as TMap[K] extends { type: TType } ? K : never]: TMap[K];
};

type TellProxy<TDef extends AnyActorDefinition> = {
  [K in keyof FilterMessages<
    MessagesOf<TDef>,
    "Command" | "StreamingCommand"
  >]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<MessagesOf<TDef>[K]["return"]>;
};

type AskProxy<TDef extends AnyActorDefinition> = {
  [K in keyof FilterMessages<MessagesOf<TDef>, "Query">]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<Extract<MessagesOf<TDef>[K], { type: "Query" }>["return"]>;
};

type StreamProxy<TDef extends AnyActorDefinition> = {
  [K in keyof FilterMessages<MessagesOf<TDef>, "StreamingCommand">]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => AsyncIterable<
    Extract<MessagesOf<TDef>[K], { type: "StreamingCommand" }>["progress"]
  >;
};

/** Extract the progress and return types for async generators */
export type StreamInfo<F> = F extends AsyncGenerator<infer Prog, infer Ret, F>
  ? { progress: Prog; return: Awaited<Ret> }
  : never;

/**
 * A utility type that marks a type as being mutable within a command handler,
 * compatible with Immer's Draft type.
 */
export type Draft<T> = T extends Objectish
  ? ReturnType<typeof createDraft<T>>
  : never;
