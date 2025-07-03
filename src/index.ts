import { type Operation, applyPatch, compare } from "fast-json-patch";
import { type Objectish, createDraft, finishDraft } from "immer";
import superjson from "superjson";
import type {
  ActorDefinition,
  ActorManager,
  ActorManagerConfig,
  ActorRef,
  AnyActorDefinition,
  AnyHandler,
  CreateMessageMap,
  Draft,
  InternalDefinitionFields,
  StateOf,
} from "./contracts.ts";

// --- Internal Types ---

type HandlerFn = (...args: unknown[]) => unknown;

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

type ActorContainer<TState> = {
  // biome-ignore lint/suspicious/noExplicitAny: We are using any as a placeholder for the parts of the FullActorDefinition that are not relevant to the ActorContainer itself.
  def: FullActorDefinition<any, TState, any, any>;
} & (
  | { status: "pending" }
  | { status: "hydrating"; hydrationPromise: Promise<void> }
  | { status: "active"; state: TState; version: bigint }
  | { status: "failed"; error: Error }
  | { status: "shutdown" }
);

// --- Actor Definition Builder ---

class ActorDefinitionBuilder<
  TName extends string,
  TState extends Objectish,
  TCommands extends Record<string, AnyHandler>,
  TQueries extends Record<string, AnyHandler>,
> {
  private _persistenceConfig?: { snapshotEvery?: number };

  constructor(
    private readonly name: TName,
    private readonly initialState: () => TState,
    private readonly commandsConfig: TCommands,
    private readonly queriesConfig: TQueries,
  ) {}

  public commands<
    const C extends Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: When a user defines a command, we have no idea what arguments that command will take.
      (state: Draft<TState>, ...args: any[]) => unknown
    >,
  >(commands: C): ActorDefinitionBuilder<TName, TState, C, TQueries> {
    return new ActorDefinitionBuilder(
      this.name,
      this.initialState,
      commands,
      this.queriesConfig,
    );
  }

  public queries<
    const Q extends Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: When a user defines a command, we have no idea what arguments that command will take.
      (state: Readonly<TState>, ...args: any[]) => unknown
    >,
  >(queries: Q): ActorDefinitionBuilder<TName, TState, TCommands, Q> {
    return new ActorDefinitionBuilder(
      this.name,
      this.initialState,
      this.commandsConfig,
      queries,
    );
  }

  public persistence(config: { snapshotEvery?: number }) {
    this._persistenceConfig = config;
    return this;
  }

  public build(): FullActorDefinition<TName, TState, TCommands, TQueries> {
    const handlers: Record<string, HandlerEntry> = {};
    for (const key in this.commandsConfig) {
      const fn = this.commandsConfig[key];
      handlers[key] = {
        type:
          fn.constructor.name === "AsyncGeneratorFunction"
            ? "stream"
            : "command",
        fn,
      };
    }
    for (const key in this.queriesConfig) {
      handlers[key] = { type: "query", fn: this.queriesConfig[key] };
    }

    return {
      _tag: "ActorDefinition",
      _name: this.name,
      _state: null as unknown as TState, // Type carrier
      _messages: null as never, // Type carrier
      _initialState: this.initialState,
      _handlers: handlers,
      _persistence: this._persistenceConfig,
    };
  }
}

export function defineActor<TName extends string>(name: TName) {
  return {
    withInitialState<TState extends Objectish>(initialState: () => TState) {
      return new ActorDefinitionBuilder<
        TName,
        TState,
        Record<string, never>,
        Record<string, never>
      >(name, initialState, {}, {});
    },
  };
}

// --- Actor Manager Implementation ---

const createComparableState = (state: unknown) => {
  return JSON.parse(superjson.stringify(state));
};

export function createActorManager<TDef extends AnyActorDefinition>(
  config: ActorManagerConfig<TDef>,
): ActorManager<TDef> {
  const { persistence, definition } = config;
  type TState = StateOf<TDef>;

  // This map is now strongly typed with this manager's specific state type.
  const actors = new Map<string, ActorContainer<TState>>();
  const clone = <T>(obj: T): T => superjson.parse(superjson.stringify(obj));
  let isShutdown = false;

  const getActiveActor = async (
    id: string,
  ): Promise<Extract<ActorContainer<TState>, { status: "active" }>> => {
    if (isShutdown) {
      throw new Error(
        "ActorManager is shut down. Cannot interact with actors.",
      );
    }
    const container = actors.get(id);
    if (!container) {
      throw new Error(`Internal error: actor with id "${id}" not found.`);
    }

    switch (container.status) {
      case "active":
        return container;
      case "hydrating":
        await container.hydrationPromise;
        // The container might have changed status, so we recurse.
        return getActiveActor(id);
      case "failed":
        throw container.error;
      case "shutdown":
        throw new Error(
          `Actor with id "${id}" has been shut down. A new reference must be created via get().`,
        );
      case "pending": {
        if (!persistence) {
          const newContainer: ActorContainer<TState> = {
            ...container,
            status: "active",
            state: container.def._initialState(),
            version: 0n,
          };
          actors.set(id, newContainer);
          return newContainer;
        }

        const hydrationPromise = (async () => {
          try {
            const loaded = await persistence.load(id);
            if (loaded) {
              if (loaded.actorDefName !== container.def._name) {
                throw new Error(
                  `Definition mismatch for actor "${id}". Stored: "${loaded.actorDefName}", Provided: "${container.def._name}".`,
                );
              }
              let stateAsJson = createComparableState(loaded.baseState);
              for (const patch of loaded.patches) {
                stateAsJson = applyPatch(stateAsJson, patch).newDocument;
              }
              actors.set(id, {
                ...container,
                status: "active",
                state: superjson.parse(JSON.stringify(stateAsJson)),
                version: loaded.baseVersion + BigInt(loaded.patches.length),
              });
            } else {
              const initialState = container.def._initialState();
              await persistence.persist({
                type: "CREATE",
                actorId: id,
                actorDefName: container.def._name,
                initialState: clone(initialState),
              });
              actors.set(id, {
                ...container,
                status: "active",
                state: initialState,
                version: 0n,
              });
            }
          } catch (error) {
            actors.set(id, {
              ...container,
              status: "failed",
              error: error as Error,
            });
            // Re-throw so the initial caller knows about the failure.
            throw error;
          }
        })();
        actors.set(id, { ...container, status: "hydrating", hydrationPromise });
        await hydrationPromise;
        return getActiveActor(id);
      }
    }
  };

  return {
    get(id: string): ActorRef<TDef> {
      if (isShutdown) {
        throw new Error("ActorManager is shut down. Cannot create new actors.");
      }

      let container = actors.get(id);
      if (
        !container ||
        container.status === "failed" ||
        container.status === "shutdown"
      ) {
        container = { def: definition, status: "pending" };
        actors.set(id, container);
      }

      // biome-ignore lint/suspicious/noExplicitAny: This is fine because we then cast these to ActorRef<TDef>
      const tellProxy: any = {};
      // biome-ignore lint/suspicious/noExplicitAny: same
      const askProxy: any = {};
      // biome-ignore lint/suspicious/noExplicitAny: same
      const streamProxy: any = {};

      for (const name in definition._handlers) {
        const entry = definition._handlers[name];
        switch (entry.type) {
          case "query":
            askProxy[name] = async (...args: unknown[]) => {
              const activeContainer = await getActiveActor(id);
              // State is now correctly typed as TState
              return entry.fn(activeContainer.state, ...args);
            };
            break;

          case "command":
            tellProxy[name] = async (...args: unknown[]) => {
              const activeContainer = await getActiveActor(id);
              const { state: currentState, version: currentVersion } =
                activeContainer;

              const draftState = createDraft(currentState);
              const returnValue = await Promise.resolve(
                entry.fn(draftState, ...args),
              );
              const nextState = finishDraft(draftState);

              if (nextState !== currentState) {
                const patch = compare(
                  createComparableState(currentState),
                  createComparableState(nextState),
                );
                if (patch.length > 0) {
                  const newVersion = currentVersion + 1n;
                  if (persistence) {
                    await persistence.persist({
                      type: "UPDATE",
                      actorId: id,
                      version: newVersion,
                      patch,
                    });
                  }
                  actors.set(id, {
                    ...activeContainer,
                    state: nextState,
                    version: newVersion,
                  });

                  if (
                    definition._persistence?.snapshotEvery &&
                    newVersion %
                      BigInt(definition._persistence.snapshotEvery) ===
                      0n
                  ) {
                    persistence
                      ?.persist({
                        type: "SNAPSHOT",
                        actorId: id,
                        version: newVersion,
                        state: clone(nextState),
                      })
                      .catch(() => {
                        /* Non-critical, fire-and-forget */
                      });
                  }
                }
              }
              return returnValue;
            };
            break;

          case "stream": {
            const streamHandler = async function* (...payload: unknown[]) {
              const activeContainer = await getActiveActor(id);
              const { state: currentState, version: currentVersion } =
                activeContainer;

              const draftState = createDraft(currentState);
              const generator = entry.fn(
                draftState,
                ...payload,
              ) as AsyncGenerator;
              const finalUpdate = yield* generator;

              if (typeof finalUpdate === "object" && finalUpdate !== null) {
                Object.assign(draftState, finalUpdate);
              }
              const nextState = finishDraft(draftState);

              const patch = compare(
                createComparableState(currentState),
                createComparableState(nextState),
              );
              if (patch.length > 0) {
                const newVersion = currentVersion + 1n;
                if (persistence) {
                  await persistence.persist({
                    type: "UPDATE",
                    actorId: id,
                    version: newVersion,
                    patch,
                  });
                }
                actors.set(id, {
                  ...activeContainer,
                  state: nextState,
                  version: newVersion,
                });

                if (
                  definition._persistence?.snapshotEvery &&
                  newVersion % BigInt(definition._persistence.snapshotEvery) ===
                    0n
                ) {
                  persistence
                    ?.persist({
                      type: "SNAPSHOT",
                      actorId: id,
                      version: newVersion,
                      state: clone(nextState),
                    })
                    .catch(() => {
                      /* Non-critical, fire-and-forget */
                    });
                }
              }
              return finalUpdate;
            };

            streamProxy[name] = (...args: unknown[]) => streamHandler(...args);
            tellProxy[name] = async (...args: unknown[]) => {
              const iterator = streamHandler(...args);
              let next = await iterator.next();
              while (!next.done) {
                next = await iterator.next();
              }
              return next.value;
            };
            break;
          }
        }
      }

      return {
        ask: askProxy,
        tell: tellProxy,
        stream: streamProxy,
        inspect: async () => {
          const activeContainer = await getActiveActor(id);
          return {
            state: clone(activeContainer.state),
            version: activeContainer.version,
          };
        },
        shutdown: async () => {
          const container = actors.get(id);
          if (!container) return;

          if (container.status === "hydrating") {
            try {
              await container.hydrationPromise;
            } catch {
              // Ignore hydration error on shutdown, the actor will be marked as 'shutdown' anyway.
            }
          }
          actors.set(id, { def: container.def, status: "shutdown" });
        },
      } as ActorRef<TDef>;
    },
    shutdown: async () => {
      if (isShutdown) return;
      isShutdown = true;
      const hydrationPromises = [...actors.values()]
        .map((c) => (c.status === "hydrating" ? c.hydrationPromise : null))
        .filter(Boolean);
      await Promise.allSettled(hydrationPromises);
      actors.clear();
    },
  };
}
