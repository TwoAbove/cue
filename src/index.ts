import type { Objectish } from "immer";
import { enableMapSet, enablePatches } from "immer";
import { Actor } from "./actor";
import type {
  ActorDefinition,
  ActorManager,
  ActorManagerConfig,
  ActorRef,
  AnyActorDefinition,
  AnyHandler,
  AskProxy,
  CreateMessageMap,
  Draft,
  InternalDefinitionFields,
  StateOf,
  StreamProxy,
  TellProxy,
} from "./contracts";

export { Actor } from "./actor";
export type {
  ActorDefinition,
  ActorManager,
  ActorManagerConfig,
  ActorMetrics,
  ActorRef,
  AnyActorDefinition,
  AnyHandler,
  AskProxy,
  CreateMessageMap,
  Draft,
  InternalDefinitionFields,
  MessagesOf,
  Patch,
  PayloadOf,
  PersistenceAdapter,
  StateOf,
  StateSnapshot,
  StreamProxy,
  Supervisor,
  SupervisorStrategy,
  TellProxy,
} from "./contracts";
export { ResetError } from "./contracts";

enableMapSet();
enablePatches();

const IsAsyncGen = (fn: AnyHandler): boolean =>
  Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]";

type HandlerFn = AnyHandler;

type HandlerEntry =
  | { type: "command"; fn: HandlerFn }
  | { type: "stream"; fn: HandlerFn }
  | { type: "query"; fn: HandlerFn };

type FullActorDefinition<
  TName extends string,
  TState extends Objectish,
  TCommands extends Record<string, AnyHandler>,
  TQueries extends Record<string, AnyHandler>,
> = ActorDefinition<TName, TState, CreateMessageMap<TCommands, TQueries>> &
  InternalDefinitionFields<TState>;

class ActorDefinitionBuilder<
  TName extends string,
  TState extends Objectish,
  TCommands extends object = Record<string, never>,
  TQueries extends object = Record<string, never>,
> {
  constructor(
    private readonly name: TName,
    private readonly initialStateFn: () => object,
    // biome-ignore lint/suspicious/noExplicitAny: Upcasters must handle any previous state shape
    private readonly upcasters: ReadonlyArray<(prevState: any) => any>,
    private readonly commandsConfig: TCommands,
    private readonly queriesConfig: TQueries,
    private _persistenceConfig?: {
      snapshotEvery?: number;
    },
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
      this._persistenceConfig,
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
      this._persistenceConfig,
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
      this._persistenceConfig,
    );
  }

  public persistence(config: {
    snapshotEvery?: number;
  }): ActorDefinitionBuilder<TName, TState, TCommands, TQueries> {
    return new ActorDefinitionBuilder(
      this.name,
      this.initialStateFn,
      this.upcasters,
      this.commandsConfig,
      this.queriesConfig,
      config,
    );
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
      _state: null as unknown as TState,
      _messages: null as unknown as CreateMessageMap<
        TCommands & Record<string, AnyHandler>,
        TQueries & Record<string, AnyHandler>
      >,
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

function buildTellProxy<TDef extends AnyActorDefinition>(
  actor: Actor<StateOf<TDef>>,
  definition: TDef,
  isShutdown: () => boolean,
): TellProxy<TDef> {
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

  return proxy as TellProxy<TDef>;
}

function buildAskProxy<TDef extends AnyActorDefinition>(
  actor: Actor<StateOf<TDef>>,
  definition: TDef,
  isShutdown: () => boolean,
): AskProxy<TDef> {
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

  return proxy as AskProxy<TDef>;
}

function buildStreamProxy<TDef extends AnyActorDefinition>(
  actor: Actor<StateOf<TDef>>,
  definition: TDef,
  isShutdown: () => boolean,
): StreamProxy<TDef> {
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

  return proxy as StreamProxy<TDef>;
}

export function createActorManager<
  const TName extends string,
  TState extends Objectish,
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

export function createActorManager<TDef extends AnyActorDefinition>(
  config: ActorManagerConfig<TDef>,
): ActorManager<TDef> {
  const { store, definition, passivation, supervisor, metrics } = config;
  const instanceUUID = crypto.randomUUID();

  type TState = StateOf<TDef>;

  const actors = new Map<string, Actor<TState>>();
  const actorRefs = new Map<string, ActorRef<TDef>>();
  let isShutdown = false;
  let sweeper: ReturnType<typeof setInterval> | undefined;

  if (passivation) {
    const evictIdle = async () => {
      if (isShutdown) return;

      for (const [id, actor] of actors) {
        if (Date.now() - actor.lastActivity > passivation.idleAfter) {
          await actor.maybeSnapshot(true);
          await actor.terminate();
          actors.delete(id);
          actorRefs.delete(id);
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
        config.lockTtlMs,
      );
      actors.set(id, actor);
    }
    return actor;
  };

  return {
    get(id: string): ActorRef<TDef> {
      const existingRef = actorRefs.get(id);
      if (existingRef) {
        // If a ref exists, ensure its underlying actor is not failed or shutdown.
        const actor = actors.get(id);
        if (actor && !actor.isFailed && !actor.isShutdown) {
          return existingRef;
        }
        // If actor is failed or gone, the ref is stale. Discard it and create a new one.
        actorRefs.delete(id);
      }

      const actor = getActor(id);

      const tellProxy = buildTellProxy(actor, definition, () => isShutdown);
      const askProxy = buildAskProxy(actor, definition, () => isShutdown);
      const streamProxy = buildStreamProxy(actor, definition, () => isShutdown);

      const actorRef: ActorRef<TDef> = {
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
        terminate: async () => {
          await actor.terminate();
          actors.delete(id);
          actorRefs.delete(id);
        },
      };

      actorRefs.set(id, actorRef);
      return actorRef;
    },
    terminate: async () => {
      if (isShutdown) return;
      isShutdown = true;

      if (sweeper) {
        clearInterval(sweeper);
        sweeper = undefined;
      }

      const shutdownPromises = [...actors.values()].map((actor) => {
        return actor.terminate();
      });
      await Promise.allSettled(shutdownPromises);
      actors.clear();
      actorRefs.clear();
    },
  };
}
