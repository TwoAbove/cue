import superjson from "superjson";

export const clone = <T>(value: T): T =>
  superjson.parse(superjson.stringify(value)) as T;

export const serializeComparable = (value: unknown): unknown =>
  // Strip the wrapper so JSON-patch paths don't start with `/json/…`
  superjson.serialize(value).json;

/**
 * Deep equality check that properly handles Maps, Sets, Dates, and other complex objects
 * by using superjson serialization for comparison
 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  try {
    const serializedA = superjson.stringify(a);
    const serializedB = superjson.stringify(b);
    return serializedA === serializedB;
  } catch {
    // Fallback to reference equality if serialization fails
    return a === b;
  }
};
