import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import { deepEqual } from "./serde";

describe("deepEqual", () => {
  it("should return true for identical Maps", () => {
    const map1 = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const map2 = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(deepEqual(map1, map2)).toBe(true);
  });

  it("should return false for different Maps", () => {
    const map1 = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const map2 = new Map([
      ["a", 1],
      ["b", 3],
    ]);
    expect(deepEqual(map1, map2)).toBe(false);
  });

  it("should return true for identical Sets", () => {
    const set1 = new Set([1, 2, 3]);
    const set2 = new Set([1, 2, 3]);
    expect(deepEqual(set1, set2)).toBe(true);
  });

  it("should return false for different Sets", () => {
    const set1 = new Set([1, 2, 3]);
    const set2 = new Set([1, 2, 4]);
    expect(deepEqual(set1, set2)).toBe(false);
  });

  it("should return true for identical Dates", () => {
    const date1 = new Date("2024-01-01");
    const date2 = new Date("2024-01-01");
    expect(deepEqual(date1, date2)).toBe(true);
  });

  it("should return false for different Dates", () => {
    const date1 = new Date("2024-01-01");
    const date2 = new Date("2024-01-02");
    expect(deepEqual(date1, date2)).toBe(false);
  });

  it("should return true for identical complex objects", () => {
    const obj1 = {
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
      date: new Date("2024-01-01"),
      bigint: 123n,
      nested: { prop: "value" },
    };
    const obj2 = {
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
      date: new Date("2024-01-01"),
      bigint: 123n,
      nested: { prop: "value" },
    };
    expect(deepEqual(obj1, obj2)).toBe(true);
  });

  it("should return false for different complex objects", () => {
    const obj1 = {
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
      date: new Date("2024-01-01"),
      bigint: 123n,
      nested: { prop: "value" },
    };
    const obj2 = {
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
      date: new Date("2024-01-01"),
      bigint: 123n,
      nested: { prop: "different" },
    };
    expect(deepEqual(obj1, obj2)).toBe(false);
  });

  it("should return true for primitive values", () => {
    expect(deepEqual(42, 42)).toBe(true);
    expect(deepEqual("hello", "hello")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it("should return false for different primitive values", () => {
    expect(deepEqual(42, 43)).toBe(false);
    expect(deepEqual("hello", "world")).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("should fallback to reference equality on serialization error", () => {
    const obj1 = {};
    const obj2 = {};
    const error = new Error("Cannot stringify");
    const stringifySpy = vi
      .spyOn(superjson, "stringify")
      .mockImplementation(() => {
        throw error;
      });

    // When serialization fails, it should use reference equality
    expect(deepEqual(obj1, obj1)).toBe(true);
    expect(deepEqual(obj1, obj2)).toBe(false);

    stringifySpy.mockRestore();
  });
});
