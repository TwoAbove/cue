import { describe, expect, it } from "vitest";
import { deepEqual } from "../../src/utils/serde";

describe("deepEqual Utility", () => {
  it("should return true for identical primitive values", () => {
    expect(deepEqual(42, 42)).toBe(true);
    expect(deepEqual("hello", "hello")).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });

  it("should return false for different primitive values", () => {
    expect(deepEqual(42, 43)).toBe(false);
    expect(deepEqual("hello", "world")).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("should return true for identical Date objects", () => {
    const date1 = new Date("2024-01-01T00:00:00Z");
    const date2 = new Date("2024-01-01T00:00:00Z");
    expect(deepEqual(date1, date2)).toBe(true);
  });

  it("should return false for different Date objects", () => {
    const date1 = new Date("2024-01-01T00:00:00Z");
    const date2 = new Date("2024-01-02T00:00:00Z");
    expect(deepEqual(date1, date2)).toBe(false);
  });

  it("should return true for identical Map objects", () => {
    const map1 = new Map<string, unknown>([
      ["a", 1],
      ["b", { c: 3 }],
    ]);
    const map2 = new Map<string, unknown>([
      ["a", 1],
      ["b", { c: 3 }],
    ]);
    expect(deepEqual(map1, map2)).toBe(true);
  });

  it("should return false for different Map objects", () => {
    const map1 = new Map([["a", 1]]);
    const map2 = new Map([["a", 2]]);
    expect(deepEqual(map1, map2)).toBe(false);
  });

  it("should return true for identical Set objects", () => {
    const set1 = new Set([1, "a", { b: 2 }]);
    const set2 = new Set([1, "a", { b: 2 }]);
    expect(deepEqual(set1, set2)).toBe(true);
  });

  it("should return false for different Set objects", () => {
    const set1 = new Set([1, 2]);
    const set2 = new Set([1, 3]);
    expect(deepEqual(set1, set2)).toBe(false);
  });

  it("should return true for complex, deeply nested objects that are identical", () => {
    const obj1 = {
      a: 1,
      b: new Date("2024-01-01"),
      c: { d: new Map([["e", new Set([5])]]) },
    };
    const obj2 = {
      a: 1,
      b: new Date("2024-01-01"),
      c: { d: new Map([["e", new Set([5])]]) },
    };
    expect(deepEqual(obj1, obj2)).toBe(true);
  });

  it("should return false for complex objects that are different", () => {
    const obj1 = { a: 1, b: { c: 2 } };
    const obj2 = { a: 1, b: { c: 3 } };
    expect(deepEqual(obj1, obj2)).toBe(false);
  });
});
