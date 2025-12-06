import {
  _handlers,
  _initialStateFn,
  _messages,
  _name,
  _persistence,
  _state,
  _tag,
  _upcasters,
  _versions,
} from "../types/internal";
import type {
  AnyHandler,
  BuiltEntityDefinition,
  CreateMessageMap,
  Draft,
  HandlerEntry,
} from "../types/public";

const IsAsyncGen = (fn: AnyHandler): boolean =>
  Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]";

class DefinitionBuilder<
  TName extends string,
  TState extends object,
  TCommands extends Record<string, AnyHandler> = Record<string, never>,
  TQueries extends Record<string, AnyHandler> = Record<string, never>,
  TVersions extends object[] = [TState],
> {
  constructor(
    private readonly name: TName,
    private readonly initialStateFn: () => TVersions[0],
    // biome-ignore lint/suspicious/noExplicitAny: Upcasters must handle any previous state shape
    private readonly upcasters: ReadonlyArray<(prevState: any) => any>,
    private readonly commandsConfig: TCommands,
    private readonly queriesConfig: TQueries,
    private persistenceConfig?: { snapshotEvery?: number },
  ) {}

  public evolve<TNewState extends object>(
    upcaster: (prevState: TState) => TNewState,
  ): DefinitionBuilder<
    TName,
    TNewState,
    Record<string, never>,
    Record<string, never>,
    [...TVersions, TNewState]
  > {
    return new DefinitionBuilder<
      TName,
      TNewState,
      Record<string, never>,
      Record<string, never>,
      [...TVersions, TNewState]
    >(
      this.name,
      this.initialStateFn,
      [...this.upcasters, upcaster],
      {} as Record<string, never>,
      {} as Record<string, never>,
      this.persistenceConfig,
    );
  }

  public commands<
    const C extends Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
      (state: Draft<TState>, ...args: any[]) => unknown
    >,
  >(newCommands: C) {
    return new DefinitionBuilder<
      TName,
      TState,
      TCommands & C,
      TQueries,
      TVersions
    >(
      this.name,
      this.initialStateFn,
      this.upcasters,
      { ...this.commandsConfig, ...newCommands },
      this.queriesConfig,
      this.persistenceConfig,
    );
  }

  public queries<
    const Q extends Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: This is intentional for the builder
      (state: Readonly<TState>, ...args: any[]) => unknown
    >,
  >(newQueries: Q) {
    return new DefinitionBuilder<
      TName,
      TState,
      TCommands,
      TQueries & Q,
      TVersions
    >(
      this.name,
      this.initialStateFn,
      this.upcasters,
      this.commandsConfig,
      { ...this.queriesConfig, ...newQueries },
      this.persistenceConfig,
    );
  }

  public persistence(config: { snapshotEvery?: number }) {
    this.persistenceConfig = config;
    return this;
  }

  public build(): BuiltEntityDefinition<
    TName,
    TState,
    CreateMessageMap<TCommands & {}, TQueries & {}>,
    TVersions
  > {
    const handlers: Record<string, HandlerEntry> = {};
    for (const [key, fn] of Object.entries(this.commandsConfig)) {
      handlers[key] = { type: IsAsyncGen(fn) ? "stream" : "command", fn };
    }
    for (const [key, fn] of Object.entries(this.queriesConfig)) {
      handlers[key] = { type: "query", fn };
    }

    const definition = {
      [_name]: this.name,
      [_state]: null as unknown as TState,
      [_messages]: null as unknown as CreateMessageMap<
        TCommands & {},
        TQueries & {}
      >,
      [_tag]: "EntityDefinition" as const,
      [_initialStateFn]: this.initialStateFn,
      [_upcasters]: this.upcasters,
      [_handlers]: handlers,
      [_versions]: null as unknown as TVersions,
      ...(this.persistenceConfig && { [_persistence]: this.persistenceConfig }),
    };
    return definition as BuiltEntityDefinition<
      TName,
      TState,
      CreateMessageMap<TCommands & {}, TQueries & {}>,
      TVersions
    >;
  }
}

export function define<TName extends string>(name: TName) {
  return {
    initialState<TState extends object>(initialStateFn: () => TState) {
      return new DefinitionBuilder<TName, TState>(
        name,
        initialStateFn,
        [],
        {},
        {},
      );
    },
  };
}
