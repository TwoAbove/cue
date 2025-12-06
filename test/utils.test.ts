import { describe, expect, it, vi } from "vitest";
import { WallClock } from "@/utils/clock";
import { newId } from "@/utils/id";
import { invariant } from "@/utils/invariants";

describe("utils", () => {
  it("invariant throws for falsy", () => {
    expect(() => invariant(false, "boom")).toThrowError("boom");
    expect(() => invariant(true, "ok")).not.toThrow();
  });

  it("WallClock.now aligns with Date.now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-05-01T12:00:00Z"));
    expect(WallClock.now()).toBe(Date.now());
    vi.useRealTimers();
  });

  it("newId returns a uuid-like value", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
