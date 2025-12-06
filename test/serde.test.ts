import { describe, expect, it } from "vitest";
import {
  clone,
  deepEqual,
  deserialize,
  escapeJsonPointerToken,
  serialize,
  serializeComparable,
} from "@/serde";

describe("serde", () => {
  it("round-trips rich types with superjson", () => {
    const original = {
      date: new Date("2024-01-02T03:04:05.000Z"),
      map: new Map([
        ["a", 1],
        ["b", 2],
      ]),
      set: new Set([1, 2, 3]),
      big: 1234567890123456789n,
      regex: /a+b?/gi,
    };

    const str = serialize(original);
    const back = deserialize<typeof original>(str);

    expect(back.date instanceof Date).toBe(true);
    expect(back.map instanceof Map).toBe(true);
    expect(back.set instanceof Set).toBe(true);
    expect(typeof back.big).toBe("bigint");
    expect(back.regex instanceof RegExp).toBe(true);
    expect(deepEqual(original, back)).toBe(true);
  });

  it("clone produces a structural clone", () => {
    const a = { x: 1, y: new Set([1, 2]) };
    const b = clone(a);
    expect(deepEqual(a, b)).toBe(true);
    b.y.add(3);
    expect(deepEqual(a, b)).toBe(false);
  });

  it("serializeComparable produces stable comparable output", () => {
    const m1 = new Map([
      ["k1", 1],
      ["k2", 2],
    ]);
    const m2 = new Map([
      ["k1", 1],
      ["k2", 2],
    ]);
    expect(serializeComparable(m1)).toEqual(serializeComparable(m2));
  });

  it("escapeJsonPointerToken escapes ~ and /", () => {
    expect(escapeJsonPointerToken("a/b")).toBe("a~1b");
    expect(escapeJsonPointerToken("a~b")).toBe("a~0b");
  });
});
