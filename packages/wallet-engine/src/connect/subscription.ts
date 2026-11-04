import type { ConnectionController, ConnectionSession } from "./controller.ts";

type Sessions = Readonly<Record<string, ConnectionSession>>;

/**
 * Fans events derived from session changes out to listeners. The store subscription is created with
 * the first listener and dropped with the last; `derive` may be async (its events are then
 * delivered once it settles).
 */
export class SessionEvents<E> {
  private readonly listeners = new Set<(event: E) => void>();
  private unsubscribe: (() => void) | undefined;

  private readonly connections: Pick<ConnectionController, "getState" | "store">;
  private readonly derive: (
    before: Sessions,
    after: Sessions,
  ) => ReadonlyArray<E> | Promise<ReadonlyArray<E>>;

  constructor(
    connections: Pick<ConnectionController, "getState" | "store">,
    derive: (before: Sessions, after: Sessions) => ReadonlyArray<E> | Promise<ReadonlyArray<E>>,
  ) {
    this.connections = connections;
    this.derive = derive;
  }

  subscribe(listener: (event: E) => void): () => void {
    this.listeners.add(listener);
    if (this.unsubscribe === undefined) {
      let previous = this.connections.getState().sessions;
      this.unsubscribe = this.connections.store.subscribe((state) => {
        const events = this.derive(previous, state.sessions);
        previous = state.sessions;
        if (Array.isArray(events)) {
          this.emit(events);
        } else {
          void (async () => {
            this.emit(await events);
          })();
        }
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  }

  private emit(events: ReadonlyArray<E>): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}
