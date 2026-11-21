import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

export type ControllerOptions<S> = {
  readonly name: string;
  readonly defaultState: () => S;
};

/**
 * Freezes plain objects (prototype `Object.prototype` or `null`) and arrays recursively so no
 * state the facade hands out can be edited back into the engine. An already-frozen value returns
 * as-is — unchanged subtrees cost nothing — and everything else passes through untouched: typed
 * arrays (`Object.freeze` throws on non-empty views), Map, Set, class instances and functions.
 */
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
    return value;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
};

/**
 * Controller base: a zustand vanilla store plus lifecycle. `update` applies a recipe that must
 * return a NEW state object — it replaces the store's state wholesale — and every stored state is
 * deeply frozen once, at this boundary: what `getState` hands a host can only be read. Returning
 * the same reference is a no-op (no set, no notification). Persistence and migrations layer on
 * later — this package carries only what its first user needs.
 */
export abstract class Controller<S extends Record<string, unknown>> {
  readonly name: string;
  readonly store: StoreApi<S>;

  protected constructor(options: ControllerOptions<S>) {
    this.name = options.name;
    this.store = createStore<S>(() => deepFreeze(options.defaultState()));
  }

  getState(): S {
    return this.store.getState();
  }

  protected update(recipe: (state: S) => S): void {
    this.store.setState((state) => deepFreeze(recipe(state)), true);
  }

  abstract init(): Promise<void>;
  abstract destroy(): Promise<void>;
}
