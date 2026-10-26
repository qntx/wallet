import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";

export type ControllerOptions<S> = {
  readonly name: string;
  readonly defaultState: () => S;
};

/**
 * Controller base: a zustand vanilla store plus lifecycle. `update` applies a recipe that must
 * return a NEW state object; returning the same reference is a no-op (no set, no notification).
 * Persistence and migrations layer on later — this package carries only what its first user needs.
 */
export abstract class Controller<S extends Record<string, unknown>> {
  readonly name: string;
  readonly store: StoreApi<S>;

  protected constructor(options: ControllerOptions<S>) {
    this.name = options.name;
    this.store = createStore<S>(options.defaultState);
  }

  getState(): S {
    return this.store.getState();
  }

  protected update(recipe: (state: S) => S): void {
    this.store.setState((state) => recipe(state));
  }

  abstract init(): Promise<void>;
  abstract destroy(): Promise<void>;
}
