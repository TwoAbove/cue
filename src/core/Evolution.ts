import { _initialStateFn, _upcasters } from "../types/internal";
import type { AnyEntityDefinition } from "../types/public";

// biome-ignore lint/suspicious/noExplicitAny: patches can apply to any state shape
function applyUpcasters<T = any>(
  state: T,
  fromSchemaVersion: number,
  def: AnyEntityDefinition,
): T {
  const upcastersToRun = def[_upcasters].slice(fromSchemaVersion - 1);
  let evolvedState = state;
  for (const upcaster of upcastersToRun) {
    evolvedState = upcaster(evolvedState);
  }
  return evolvedState;
}

// biome-ignore lint/suspicious/noExplicitAny: state shapes vary across versions
function applyUpcastersTo<T = any>(
  state: T,
  fromSchemaVersion: number,
  toSchemaVersion: number,
  def: AnyEntityDefinition,
): T {
  const upcastersToRun = def[_upcasters].slice(
    fromSchemaVersion - 1,
    toSchemaVersion - 1,
  );
  let evolvedState = state;
  for (const upcaster of upcastersToRun) {
    evolvedState = upcaster(evolvedState);
  }
  return evolvedState;
}

// biome-ignore lint/suspicious/noExplicitAny: initial state can be any shape
function getLatestInitialState(def: AnyEntityDefinition): any {
  const initialState = def[_initialStateFn]();
  return applyUpcasters(initialState, 1, def);
}

export const Evolution = {
  applyUpcasters,
  applyUpcastersTo,
  getLatestInitialState,
};
