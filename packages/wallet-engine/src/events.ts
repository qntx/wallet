/** Log port: listener failures are reported here and never reach the emitter or peers. */
export type EngineLogger = {
  readonly warn: (message: string, error?: unknown) => void;
};

export type EventBus<E> = {
  /** Synchronous dispatch to every current listener in registration order. */
  emit: <K extends keyof E>(type: K, payload: E[K]) => void;
  on: <K extends keyof E>(type: K, listener: (payload: E[K]) => void) => () => void;
};

export function createEventBus<E>(logger: EngineLogger): EventBus<E> {
  const listeners = new Map<keyof E, Set<(payload: unknown) => void>>();
  return {
    emit<K extends keyof E>(type: K, payload: E[K]): void {
      const set = listeners.get(type);
      if (set === undefined) {
        return;
      }
      for (const listener of set) {
        try {
          listener(payload);
        } catch (error) {
          logger.warn("event listener threw", error);
        }
      }
    },
    on<K extends keyof E>(type: K, listener: (payload: E[K]) => void): () => void {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      // The set is keyed by event type, so each listener only ever receives its own payload.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const stored = listener as (payload: unknown) => void;
      set.add(stored);
      return () => {
        set.delete(stored);
      };
    },
  };
}
