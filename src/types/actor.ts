import type { Objectish } from "immer";
import type { MessageMap } from "./messages";
import type { AnyHandler } from "./util";

/**
 * The public-facing, branded type for a complete actor definition.
 * This is what `defineActor(...).build()` returns.
 */
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

/**
 * Internal fields attached to an actor definition object that are not part of the public API.
 * @internal
 */
export type InternalDefinitionFields<_TState extends Objectish = Objectish> = {
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

/**
 * A generic type representing any actor definition. Useful for functions
 * that operate on definitions without needing to know the specific state or messages.
 */
export type AnyActorDefinition = ActorDefinition<
  string,
  Objectish,
  Record<string, never>
> &
  InternalDefinitionFields;

/**
 * Infers the state type from an actor definition.
 */
export type StateOf<TDef extends AnyActorDefinition> = TDef["_state"];

/**
 * Infers the message map from an actor definition.
 */
export type MessagesOf<TDef extends AnyActorDefinition> = TDef["_messages"];

/**
 * The proxy for sending commands to an actor. Methods return a `Promise`
 * with the final return value of the command handler.
 */
export type TellProxy<TDef extends AnyActorDefinition> = {
  [K in keyof MessagesOf<TDef> as MessagesOf<TDef>[K] extends {
    verb: "tell" | "stream";
  }
    ? K
    : never]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<MessagesOf<TDef>[K]["return"]>;
};

/**
 * The proxy for sending queries to an actor. Methods return a `Promise`
 * with the return value of the read-only query handler.
 */
export type AskProxy<TDef extends AnyActorDefinition> = {
  [K in keyof MessagesOf<TDef> as MessagesOf<TDef>[K] extends { verb: "ask" }
    ? K
    : never]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => Promise<MessagesOf<TDef>[K]["return"]>;
};

/**
 * The proxy for interacting with streaming commands. Methods return an
 * `AsyncIterable` that yields progress updates.
 */
export type StreamProxy<TDef extends AnyActorDefinition> = {
  [K in keyof MessagesOf<TDef> as MessagesOf<TDef>[K] extends {
    verb: "stream";
  }
    ? K
    : never]: (
    ...args: MessagesOf<TDef>[K]["payload"]
  ) => AsyncIterable<MessagesOf<TDef>[K]["progress"]>;
};

/**
 * A reference to a specific actor instance, providing methods to interact with it.
 */
export type ActorRef<TDef extends AnyActorDefinition> = {
  readonly ask: AskProxy<TDef>;
  readonly tell: TellProxy<TDef>;
  readonly stream: StreamProxy<TDef>;
  inspect(): Promise<{ state: StateOf<TDef>; version: bigint }>;
  terminate(): Promise<void>;
};

/**
 * The structure of a serialized state snapshot.
 */
export interface StateSnapshot {
  schemaVersion: number;
  state: unknown;
}
