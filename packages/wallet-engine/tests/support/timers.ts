import type { SetTimer } from "../../src/timer.ts";

type Armed = { readonly ms: number; readonly fn: () => unknown; done: boolean };

export type ManualTimers = {
  readonly setTimer: SetTimer;
  /**
   * Runs every live callback armed before this call — only those of `ms` when given — and awaits
   * what they return. A callback armed while they run waits for the next `fire`.
   */
  readonly fire: (ms?: number) => Promise<void>;
  /** Live (armed, not yet run, not cancelled) callbacks — only those of `ms` when given. */
  readonly armed: (ms?: number) => number;
};

/**
 * A hand-driven timer faithful to `setTimeout`: each armed callback runs at most once and never
 * after it is cancelled, so a loop that forgets to re-arm stops — exactly as in production.
 */
export const manualTimers = (): ManualTimers => {
  let live: Armed[] = [];
  const due = (ms: number | undefined): Armed[] =>
    live.filter((t) => !t.done && (ms === undefined || t.ms === ms));
  return {
    setTimer: (ms, fn) => {
      const entry: Armed = { ms, fn, done: false };
      live.push(entry);
      return () => {
        entry.done = true;
      };
    },
    fire: async (ms) => {
      const batch = due(ms);
      for (const t of batch) {
        t.done = true;
      }
      live = live.filter((t) => !t.done);
      await Promise.all(
        batch.map(async (t) => {
          await t.fn();
        }),
      );
    },
    armed: (ms) => due(ms).length,
  };
};
