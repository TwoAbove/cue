import type { createDraft, Patch as ImmerPatch } from "immer";

/**
 * A read-only array of Immer-generated patches representing state changes.
 */
export type Patch = readonly ImmerPatch[];

/**
 * A generic type for any handler function (command, query, or stream).
 */
// biome-ignore lint/suspicious/noExplicitAny: This is intentional for a generic handler type
export type AnyHandler = (...args: any[]) => any;

/**
 * Represents the mutable 'draft' of a state object provided by Immer within a command.
 */
export type Draft<T> = T extends object
  ? ReturnType<typeof createDraft<T>>
  : never;

/**
 * An error thrown by the supervisor when it resets an actor's state.
 * The original error that caused the reset is available in the `cause` property.
 */
export class ResetError extends Error {
  constructor(original: Error) {
    super(`Actor reset after error: ${original.message}`);
    this.cause = original;
    this.name = "ResetError";
  }
}
