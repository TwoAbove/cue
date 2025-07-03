import type { Objectish } from "immer";
import { Actor } from "./actor/Actor.js";
import type {
  ActorDefinition,
  ActorManager,
  ActorManagerConfig,
  ActorRef,
  AnyActorDefinition,
  AnyHandler,
  AskProxyOf,
  CreateMessageMap,
  Draft,
  InternalDefinitionFields,
  StateOf,
  StreamProxyOf,
  TellProxyOf,
} from "./contracts.ts";

export type { Objectish } from "immer";
export { Actor } from "./actor/Actor.js";
export type {
  ActorDefinition,
  ActorManager,
  ActorManagerConfig,
  ActorMetrics,
  ActorRef,
  AskProxyOf,
  Draftable,
  DraftStateOf,
  StateOf,
  StreamProxyOf,
  Supervisor,
  SupervisorStrategy,
  TellProxyOf,
} from "./contracts.ts";

// --- Internal Types ---

const IsAsyncGen = (fn: AnyHandler): boolean =>
  Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]";

type HandlerFn = AnyHandler;

type HandlerEntry =
  | { type: "command"; fn: HandlerFn }
  | { type: "stream"; fn: HandlerFn }
  | { type: "query"; fn: HandlerFn };

type FullActorDefinition<
  TName extends string,
  TState,
  TCommands extends Record<string, AnyHandler>,
  TQueries extends Record<string, AnyHandler>,
> = ActorDefinition<TName, TState, CreateMessageMap<TCommands, TQueries>> &
  InternalDefinitionFields<TState>;

// --- Actor Definition Builder ---

class ActorDefinitionBuilder<
  TName extends string,
  TState extends Objectish,
  TCommands extends object = Record<string, never>,
  TQueries extends object = Record<string, never>,
> {
  private _persistenceConfig?: {
    snapshotEvery?: number;
  };

  constructor(
    private readonly name: TName,
    private readonly initialStateFn: () => object,
    // biome-ignore lint/suspicious/noExplicitAny: Upcasters must handle any previous state shape
    private readonly upcasters: ReadonlyArray<(prevState: any) => any>,
    private readonly commandsConfig: TCommands,
    private readonly queriesConfig: TQueries,
  ) {}

  public evolveTo<TNewState extends Objectish>(
    upcaster: (prevState: TState) => TNewState,
  ): ActorDefinitionBuilder<
    TName,
    TNewState,
    Record<string, never>,
    Record<string, never>
  > {
    return new ActorDefinitionBuilder(
      this.name,
      this.initialStateFn,
      [...this.upcasters, upcaster],
      {},
      {},
    );
  }

  public commands<
    const C extends Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
      (state: Draft<TState>, ...args: any[]) => unknown
    >,
  >(
    newCommands: C,
  ): ActorDefinitionBuilder<TName, TState, TCommands & C, TQueries> {
    return new ActorDefinitionBuilder(
      this.name,
      this.initialStateFn,
      this.upcasters,
      { ...this.commandsConfig, ...newCommands },
      this.queriesConfig,
    );
  }

  public queries<
    const Q extends Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
      (state: Readonly<TState>, ...args: any[]) => unknown
    >,
  >(
    newQueries: Q,
  ): ActorDefinitionBuilder<TName, TState, TCommands, TQueries & Q> {
    return new ActorDefinitionBuilder(
      this.name,
      this.initialStateFn,
      this.upcasters,
      this.commandsConfig,
      { ...this.queriesConfig, ...newQueries },
    );
  }

  public persistence(config: { snapshotEvery?: number }) {
    this._persistenceConfig = config;
    return this;
  }

  public build(): FullActorDefinition<
    TName,
    TState,
    TCommands & Record<string, AnyHandler>,
    TQueries & Record<string, AnyHandler>
  > {
    const handlers: Record<string, HandlerEntry> = {};
    for (const key in this.commandsConfig) {
      const fn = (this.commandsConfig as Record<string, HandlerFn>)[key];

      if (!fn) {
        continue;
      }

      if (fn) {
        handlers[key] = {
          type: IsAsyncGen(fn) ? "stream" : "command",
          fn,
        };
      }
    }
    for (const key in this.queriesConfig) {
      const fn = (this.queriesConfig as Record<string, HandlerFn>)[key];
      if (fn) {
        handlers[key] = { type: "query", fn };
      }
    }

    return {
      _tag: "ActorDefinition",
      _name: this.name,
      _state: null as unknown as TState, // Type carrier
      _messages: null as unknown as CreateMessageMap<
        TCommands & Record<string, AnyHandler>,
        TQueries & Record<string, AnyHandler>
      >, // Type carrier
      _initialStateFn: this.initialStateFn,
      _upcasters: this.upcasters,
      _handlers: handlers,
      ...(this._persistenceConfig && { _persistence: this._persistenceConfig }),
    };
  }
}

export function defineActor<TName extends string>(name: TName) {
  return {
    initialState<TState extends Objectish>(initialStateFn: () => TState) {
      return new ActorDefinitionBuilder<TName, TState>(
        name,
        initialStateFn,
        [],
        {},
        {},
      );
    },
  };
}

// --- Typed Proxy Builders ---

/**
 * Builds a tell proxy for fire-and-forget actor commands and streams.
 *
 * **Important streaming behavior**: When calling `tell.SomeStream()`, the stream
 * is eagerly drained to completion before returning the final value. This means:
 * - All yielded values are consumed but not returned to the caller
 * - Only the final return value from the stream is returned
 * - The stream runs to completion synchronously within the actor's mailbox
 *
 * If you need to consume individual yielded values, use the `stream` verb instead
 * of `tell` to get access to the AsyncGenerator.
 *
 * @param actor - The actor instance to proxy commands to
 * @param definition - The actor definition containing handler metadata
 * @param isShutdown - Function to check if the actor manager is shut down
 * @returns A proxy object with methods for each command and stream handler
 */
function buildTellProxy<TDef extends AnyActorDefinition>(
  actor: Actor<StateOf<TDef>>,
  definition: TDef,
  isShutdown: () => boolean,
): TellProxyOf<TDef> {
  const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const name in definition._handlers) {
    const entry = definition._handlers[name];
    if (!entry) continue;

    if (entry.type === "command") {
      proxy[name] = async (...args: unknown[]) => {
        if (isShutdown()) {
          throw new Error(
            "ActorManager is shut down. Cannot interact with actors.",
          );
        }
        return actor.handleTell(name, args);
      };
    } else if (entry.type === "stream") {
      proxy[name] = async (...args: unknown[]) => {
        if (isShutdown()) {
          throw new Error(
            "ActorManager is shut down. Cannot interact with actors.",
          );
        }
        const iterator = actor.handleStream(name, args);
        let next = await iterator.next();
        while (!next.done) {
          next = await iterator.next();
        }
        return next.value;
      };
    }
  }

  return proxy as TellProxyOf<TDef>;
}

function buildAskProxy<TDef extends AnyActorDefinition>(
  actor: Actor<StateOf<TDef>>,
  definition: TDef,
  isShutdown: () => boolean,
): AskProxyOf<TDef> {
  const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const name in definition._handlers) {
    const entry = definition._handlers[name];
    if (!entry || entry.type !== "query") continue;

    proxy[name] = async (...args: unknown[]) => {
      if (isShutdown()) {
        throw new Error(
          "ActorManager is shut down. Cannot interact with actors.",
        );
      }
      return actor.handleAsk(name, args);
    };
  }

  return proxy as AskProxyOf<TDef>;
}

function buildStreamProxy<TDef extends AnyActorDefinition>(
  actor: Actor<StateOf<TDef>>,
  definition: TDef,
  isShutdown: () => boolean,
): StreamProxyOf<TDef> {
  const proxy: Record<string, (...args: unknown[]) => AsyncIterable<unknown>> =
    {};

  for (const name in definition._handlers) {
    const entry = definition._handlers[name];
    if (!entry || entry.type !== "stream") continue;

    proxy[name] = async function* (...args: unknown[]) {
      if (isShutdown()) {
        throw new Error(
          "ActorManager is shut down. Cannot interact with actors.",
        );
      }
      yield* actor.handleStream(name, args);
    };
  }

  return proxy as StreamProxyOf<TDef>;
}

// --- Actor Manager Implementation ---

// Overload for inline actor definitions with better type inference
export function createActorManager<
  const TName extends string,
  TState,
  TCmds extends Record<string, HandlerFn>,
  TQs extends Record<string, HandlerFn>,
>(
  config: ActorManagerConfig<
    ActorDefinition<TName, TState, CreateMessageMap<TCmds, TQs>> &
      InternalDefinitionFields<TState>
  >,
): ActorManager<
  ActorDefinition<TName, TState, CreateMessageMap<TCmds, TQs>> &
    InternalDefinitionFields<TState>
>;

// Main implementation
export function createActorManager<TDef extends AnyActorDefinition>(
  config: ActorManagerConfig<TDef>,
): ActorManager<TDef>;

export function createActorManager<TDef extends AnyActorDefinition>(
  config: ActorManagerConfig<TDef>,
): ActorManager<TDef> {
  const { store, definition, passivation, supervisor, metrics } = config;
  const instanceUUID = crypto.randomUUID();

  type TState = StateOf<TDef>;

  // This map is now strongly typed with this manager's specific state type.
  const actors = new Map<string, Actor<TState>>();
  let isShutdown = false;
  let sweeper: NodeJS.Timeout | undefined;

  // Set up passivation if configured
  if (passivation) {
    const evictIdle = async () => {
      if (isShutdown) return;

      for (const [id, actor] of actors) {
        if (Date.now() - actor.lastActivity > passivation.idleAfter) {
          await actor.maybeSnapshot();
          await actor.shutdown();
          actors.delete(id);
          metrics?.onEvict?.(id);
        }
      }
    };

    sweeper = setInterval(evictIdle, passivation.sweepInterval ?? 60_000);
    sweeper.unref();
  }

  const getActor = (id: string): Actor<TState> => {
    if (isShutdown) {
      throw new Error("ActorManager is shut down. Cannot create new actors.");
    }

    let actor = actors.get(id);
    if (!actor || actor.isFailed) {
      if (actor?.isFailed) {
        actors.delete(id);
      }
      actor = new Actor(
        id,
        definition,
        store,
        instanceUUID,
        supervisor,
        metrics,
      );
      actors.set(id, actor);
    }
    return actor;
  };

  return {
    get(id: string): ActorRef<TDef> {
      const actor = getActor(id);

      const tellProxy = buildTellProxy(actor, definition, () => isShutdown);
      const askProxy = buildAskProxy(actor, definition, () => isShutdown);
      const streamProxy = buildStreamProxy(actor, definition, () => isShutdown);

      return {
        ask: askProxy,
        tell: tellProxy,
        stream: streamProxy,
        inspect: async () => {
          if (isShutdown) {
            throw new Error(
              "ActorManager is shut down. Cannot interact with actors.",
            );
          }
          return actor.inspect();
        },
        shutdown: async () => {
          await actor.shutdown();
          actors.delete(id);
        },
      };
    },
    shutdown: async () => {
      if (isShutdown) return;
      isShutdown = true;

      if (sweeper) {
        clearInterval(sweeper);
        sweeper = undefined;
      }

      const shutdownPromises = [...actors.values()].map((actor) => {
        return actor.shutdown();
      });
      await Promise.allSettled(shutdownPromises);
      actors.clear();
    },
  };
}
