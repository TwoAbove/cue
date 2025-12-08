import {
  applyPatches,
  createDraft,
  finishDraft,
  type Patch as ImmerPatch,
  isDraft,
} from "immer";
import { clone } from "../serde";
import { _handlers } from "../types/internal";
import type {
  AnyEntityDefinition,
  HandlerContext,
  Patch,
} from "../types/public";
import { invariant } from "../utils/invariants";
import { Evolution } from "./Evolution";

export class StateKernel<TState extends object> {
  #state: TState | null = null;
  #version = -1n;

  constructor(private readonly def: AnyEntityDefinition) {}

  get state(): TState {
    invariant(
      this.#state,
      "State not available. Ensure the entity is hydrated.",
    );
    return this.#state;
  }

  get version(): bigint {
    invariant(
      this.#version >= 0n,
      "Version not available. Ensure the entity is hydrated.",
    );
    return this.#version;
  }

  initialiseInMemory() {
    this.#state = Evolution.getLatestInitialState(this.def);
    this.#version = 0n;
  }

  hydrate(params: {
    baseState: TState;
    baseVersion: bigint;
    schemaVersion: number;
    events: Array<{ schemaVersion: number; patches: Patch }>;
  }) {
    let state = params.baseState;
    let currentSchema = params.schemaVersion;

    for (const event of params.events) {
      if (event.schemaVersion > currentSchema) {
        state = Evolution.applyUpcastersTo(
          state,
          currentSchema,
          event.schemaVersion,
          this.def,
        );
        currentSchema = event.schemaVersion;
      }
      state = applyPatches(state, event.patches as ImmerPatch[]);
    }

    this.#state = Evolution.applyUpcasters(state, currentSchema, this.def);
    this.#version = params.baseVersion + BigInt(params.events.length);
  }

  getLatestInitialState(): TState {
    return Evolution.getLatestInitialState(this.def);
  }

  applyCommittedState(nextState: TState) {
    this.#state = nextState;
    this.#version += 1n;
  }

  async applyCommand(
    handlerName: string,
    args: unknown[],
    ctx: HandlerContext,
  ): Promise<{ returnValue: unknown; patches: Patch; nextState: TState }> {
    const entry = this.def[_handlers][handlerName];
    invariant(
      entry && entry.type === "command",
      `Handler "${handlerName}" not found or not a command.`,
    );

    let patches: Patch = [] as unknown as Patch;
    const draft = createDraft(this.state);

    try {
      const returnValue = await Promise.resolve(entry.fn(draft, ...args, ctx));
      const nextState = finishDraft(draft, (p: ImmerPatch[]) => {
        patches = p as unknown as Patch;
      }) as TState;
      return { returnValue, patches, nextState };
    } catch (e) {
      finishDraft(draft);
      throw e;
    }
  }

  runQuery(handlerName: string, args: unknown[], ctx: HandlerContext): unknown {
    const entry = this.def[_handlers][handlerName];
    invariant(
      entry && entry.type === "query",
      `Handler "${handlerName}" not found or not a query.`,
    );

    const draft = createDraft(this.state);
    try {
      const result = entry.fn(draft, ...args, ctx);
      return clone(result);
    } finally {
      finishDraft(draft);
    }
  }

  startStream(
    handlerName: string,
    args: unknown[],
    ctx: HandlerContext,
  ): {
    generator: AsyncGenerator;
    finalize: () => { patches: Patch; nextState: TState };
    discard: () => void;
  } {
    const entry = this.def[_handlers][handlerName];
    invariant(
      entry && entry.type === "stream",
      `Handler "${handlerName}" not found or not a stream.`,
    );

    const draft = createDraft(this.state);
    const generatorImpl = entry.fn(draft, ...args, ctx) as AsyncGenerator;
    invariant(
      generatorImpl && typeof generatorImpl.next === "function",
      `Stream handler "${handlerName}" did not return an AsyncGenerator.`,
    );

    const generator: AsyncGenerator<unknown> = {
      async next(...a) {
        return await generatorImpl.next(...a);
      },
      async return(...a) {
        return generatorImpl.return(...a);
      },
      async throw(...a) {
        return generatorImpl.throw(...a);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      // TS 5.9 AsyncDisposable – no-op to satisfy the interface
      async [Symbol.asyncDispose]() {
        /* noop */
      },
    };

    return {
      generator,
      finalize: () => {
        let patches: Patch = [] as unknown as Patch;
        const nextState = finishDraft(draft, (p: ImmerPatch[]) => {
          patches = p as unknown as Patch;
        }) as TState;
        return { patches, nextState };
      },
      discard: () => {
        if (isDraft(draft)) {
          finishDraft(draft);
        }
      },
    };
  }
}
