import { describe, expect, it } from "vitest";
import { supervisor } from "@/api";

describe("supervisor() helper", () => {
  const dummyState = { n: 0 };
  const dummyError = new Error("test");

  it("returns resume by default when no guards match", () => {
    const sup = supervisor({});
    expect(sup.strategy(dummyState, dummyError)).toBe("resume");
  });

  it("respects custom default fallback", () => {
    const sup = supervisor({ default: "reset" });
    expect(sup.strategy(dummyState, dummyError)).toBe("reset");
  });

  it("supports boolean guards", () => {
    const sup = supervisor({ stop: true });
    expect(sup.strategy(dummyState, dummyError)).toBe("stop");
  });

  it("supports function guards", () => {
    const sup = supervisor({
      reset: (_state, err) => err.message === "test",
    });
    expect(sup.strategy(dummyState, dummyError)).toBe("reset");
    expect(sup.strategy(dummyState, new Error("other"))).toBe("resume");
  });

  it("follows precedence: stop > reset > resume", () => {
    const sup = supervisor({
      resume: true,
      reset: true,
      stop: true,
    });
    // All match, but stop has highest precedence
    expect(sup.strategy(dummyState, dummyError)).toBe("stop");
  });

  it("falls through when higher-precedence guards return false", () => {
    const sup = supervisor({
      stop: false,
      reset: true,
      resume: true,
    });
    expect(sup.strategy(dummyState, dummyError)).toBe("reset");
  });

  it("uses state in guard functions", () => {
    const sup = supervisor({
      stop: (state: { critical?: boolean }) => state.critical === true,
      default: "resume",
    });
    expect(sup.strategy({ critical: false }, dummyError)).toBe("resume");
    expect(sup.strategy({ critical: true }, dummyError)).toBe("stop");
  });
});
