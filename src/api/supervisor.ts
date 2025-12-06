import type { Supervisor, SupervisorStrategy } from "../types/public";

type Guard = (state: unknown, error: Error) => boolean;

/**
 * Ergonomic builder for a Supervisor without stringly-typed returns.
 *
 * Usage:
 *   const sup = supervisor({
 *     // Choose a strategy when the guard returns true.
 *     resume: (state, err) => err.name === "ValidationError",
 *     stop:   (state, err) => err.name === "CatastrophicConfigError",
 *     // Fallback if no guard matches (defaults to "resume")
 *     default: "reset",
 *   });
 */
export function supervisor(spec: {
  resume?: boolean | Guard;
  reset?: boolean | Guard;
  stop?: boolean | Guard;
  default?: SupervisorStrategy;
}): Supervisor {
  const toGuard = (g?: boolean | Guard): Guard | undefined => {
    if (g === undefined) return undefined;
    if (typeof g === "function") return g;
    return () => g; // boolean -> constant guard
  };

  const guards = {
    // Strategy precedence: stop → reset → resume
    stop: toGuard(spec.stop),
    reset: toGuard(spec.reset),
    resume: toGuard(spec.resume),
  };
  const fallback: SupervisorStrategy = spec.default ?? "resume";

  return {
    strategy(state, error) {
      if (guards.stop?.(state, error)) return "stop";
      if (guards.reset?.(state, error)) return "reset";
      if (guards.resume?.(state, error)) return "resume";
      return fallback;
    },
  };
}
