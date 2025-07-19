import { expectTypeOf } from "expect-type";
import { describe, it } from "vitest";
import type {
  AskProxy,
  CreateMessageMap,
  PayloadOf,
  StreamProxy,
  TellProxy,
} from "../src/contracts";
import { defineActor } from "../src/index";

describe("Type Safety Contracts", () => {
  it("should correctly infer message and proxy types from a definition", () => {
    const myActor = defineActor("Test")
      .initialState(() => ({ count: 0 }))
      .commands({
        increment: (state, by: number) => {
          state.count += by;
        },
        stream: async function* (_, limit: number) {
          for (let i = 0; i < limit; i++) yield i;
          return "done";
        },
      })
      .queries({
        getCount: (state) => state.count,
      })
      .build();

    type Def = typeof myActor;
    type Msgs = CreateMessageMap<
      {
        increment: (s: unknown, by: number) => void;
        stream: (s: unknown, limit: number) => AsyncGenerator<number, string>;
      },
      { getCount: (s: unknown) => number }
    >;

    expectTypeOf<Def["_messages"]>().toExtend<Msgs>();

    type Tell = TellProxy<Def>;
    expectTypeOf<Tell["increment"]>().toEqualTypeOf<
      (by: number) => Promise<void>
    >();
    expectTypeOf<Tell["stream"]>().toEqualTypeOf<
      (limit: number) => Promise<string>
    >();

    type Ask = AskProxy<Def>;
    expectTypeOf<Ask["getCount"]>().toEqualTypeOf<() => Promise<number>>();

    type Stream = StreamProxy<Def>;
    expectTypeOf<Stream["stream"]>().toEqualTypeOf<
      (limit: number) => AsyncIterable<number>
    >();
  });

  it("should correctly infer payload types", () => {
    const handler1 = (_state: { a: 1 }, _arg1: string, _arg2: boolean) => {};
    type P1 = PayloadOf<typeof handler1>;
    expectTypeOf<P1>().toEqualTypeOf<[string, boolean]>();

    const handler2 = (_state: { a: 1 }) => {};
    type P2 = PayloadOf<typeof handler2>;
    expectTypeOf<P2>().toEqualTypeOf<[]>();
  });
});
