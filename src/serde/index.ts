import superjson from "superjson";

export const clone = <T>(value: T): T =>
  superjson.parse(superjson.stringify(value)) as T;

export const serialize = (value: unknown): string => superjson.stringify(value);

export const deserialize = <T = unknown>(value: string): T =>
  superjson.parse(value);

export const serializeComparable = (value: unknown): unknown =>
  superjson.serialize(value).json;

export const deepEqual = (a: unknown, b: unknown): boolean => {
  try {
    const serializedA = superjson.stringify(a);
    const serializedB = superjson.stringify(b);
    return serializedA === serializedB;
  } catch {
    return a === b;
  }
};

export const escapeJsonPointerToken = (token: string | number): string => {
  const str = String(token);
  return str.replace(/~/g, "~0").replace(/\//g, "~1");
};
