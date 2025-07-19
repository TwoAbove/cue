import type { AnyHandler, Draft } from "./util";

/**
 * The verbs representing the different ways to interact with an actor.
 */
export type ActorVerb = "tell" | "ask" | "stream";

/**
 * Infers the payload (arguments) of a handler function, excluding the initial state argument.
 */
export type PayloadOf<F> =
  /* stateful command / stream */
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

/**
 * Creates the message contract for a command or a streaming command.
 */
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

/**
 * Creates the message contract for a query.
 */
export type CreateQueryMessage<THandler extends AnyHandler> = {
  verb: "ask";
  payload: PayloadOf<THandler>;
  return: Awaited<ReturnType<THandler>>;
};

/**
 * Generates a complete map of all possible messages for an actor definition.
 */
export type CreateMessageMap<
  TCommands extends Record<string, AnyHandler>,
  TQueries extends Record<string, AnyHandler>,
> = {
  [K in keyof TCommands]: CreateCommandMessage<TCommands[K]>;
} & {
  [K in keyof TQueries]: CreateQueryMessage<TQueries[K]>;
};

/**
 * A generic map of message names to their definitions for an actor.
 */
export type MessageMap = Record<string, MessageDefinition<ActorVerb>>;

type MessageDefinition<V extends ActorVerb> = {
  verb: V;
  payload: unknown[];
  progress?: unknown; // only for "stream"
  return: unknown;
};

/**
 * A utility type to filter a `MessageMap` by a specific verb.
 */
export type FilterMessages<TMap, TVerb> = {
  [K in keyof TMap as TMap[K] extends { verb: TVerb } ? K : never]: TMap[K];
};
