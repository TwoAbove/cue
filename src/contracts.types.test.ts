import { expectTypeOf } from "expect-type";
import { describe, it } from "vitest";
import type {
  ActorDefinition,
  AnyHandler,
  AskProxyOf,
  CreateMessageMap,
  InternalDefinitionFields,
  StreamProxyOf,
  TellProxyOf,
} from "./contracts";

describe("contracts type tests", () => {
  it("should create correct message map types", () => {
    // Test with handlers that match the actual constraint
    type Cmds = { foo: (...args: unknown[]) => string };
    type Qrys = { bar: (...args: unknown[]) => boolean };

    type Msgs = CreateMessageMap<Cmds, Qrys>;

    // tell case
    expectTypeOf<Msgs["foo"]>().toEqualTypeOf<{
      verb: "tell";
      payload: unknown[];
      return: string;
    }>();

    // ask case
    expectTypeOf<Msgs["bar"]>().toEqualTypeOf<{
      verb: "ask";
      payload: unknown[];
      return: boolean;
    }>();
  });

  it("should create properly typed proxies", () => {
    type TestDef = ActorDefinition<
      "Test",
      { count: number },
      {
        increment: { verb: "tell"; payload: [number]; return: undefined };
        getCount: { verb: "ask"; payload: []; return: number };
        stream: {
          verb: "stream";
          payload: [];
          progress: number;
          return: string;
        };
      }
    > &
      InternalDefinitionFields<{ count: number }>;

    type TellProxy = TellProxyOf<TestDef>;
    type AskProxy = AskProxyOf<TestDef>;
    type StreamProxy = StreamProxyOf<TestDef>;

    expectTypeOf<TellProxy["increment"]>().toEqualTypeOf<
      (count: number) => Promise<undefined>
    >();
    expectTypeOf<AskProxy["getCount"]>().toEqualTypeOf<() => Promise<number>>();
    expectTypeOf<StreamProxy["stream"]>().toEqualTypeOf<
      () => AsyncIterable<number>
    >();
  });

  it("should enforce proper AnyHandler signature", () => {
    // This should match the AnyHandler constraint
    const testHandler: AnyHandler = (..._args: unknown[]) => "test";
    expectTypeOf(testHandler).toEqualTypeOf<AnyHandler>();
  });
});
