import { describe, expect, it } from "vite-plus/test";

import { repeat, timeoutSignal } from "../src/timer.ts";
import { manualTimers } from "./support/timers.ts";

describe("timeoutSignal", () => {
  it("aborts when the injected timer fires and not before", () => {
    const fire: { run: () => unknown } = { run: () => undefined };
    const bound = timeoutSignal(5000, (ms, fn) => {
      expect(ms).toBe(5000);
      fire.run = fn;
      return () => undefined;
    });
    expect(bound.signal.aborted).toBe(false);
    fire.run();
    expect(bound.signal.aborted).toBe(true);
  });

  it("cancels the timer and can abort early", () => {
    let cancelled = false;
    const bound = timeoutSignal(1, () => () => {
      cancelled = true;
    });
    bound.cancel();
    expect(cancelled).toBe(true);
    bound.abort();
    expect(bound.signal.aborted).toBe(true);
  });
});

describe("repeat", () => {
  it("re-arms the one-shot timer after every run", async () => {
    const timers = manualTimers();
    let runs = 0;
    repeat(
      timers.setTimer,
      100,
      () => {
        runs += 1;
      },
      () => undefined,
    );
    for (let i = 1; i <= 5; i += 1) {
      expect(timers.armed(100)).toBe(1);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each run arms the next
      await timers.fire(100);
      expect(runs).toBe(i);
    }
  });

  it("arms the next run only once the previous one settles, so runs never overlap", async () => {
    const timers = manualTimers();
    let release = (): void => undefined;
    let active = 0;
    let peak = 0;
    repeat(
      timers.setTimer,
      100,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        active -= 1;
      },
      () => undefined,
    );
    const first = timers.fire(100);
    await Promise.resolve();
    expect(timers.armed()).toBe(0);
    await timers.fire(100);
    release();
    await first;
    expect(timers.armed(100)).toBe(1);
    expect(peak).toBe(1);
  });

  it("reports a failed run and keeps going", async () => {
    const timers = manualTimers();
    const errors: unknown[] = [];
    const steps = [
      async (): Promise<void> => Promise.reject(new Error("boom")),
      async (): Promise<void> => Promise.resolve(),
    ];
    let runs = 0;
    repeat(
      timers.setTimer,
      100,
      async () => {
        const step = steps.shift();
        runs += 1;
        await step?.();
      },
      (error) => errors.push(error),
    );
    await timers.fire(100);
    await timers.fire(100);
    expect(runs).toBe(2);
    expect(errors).toStrictEqual([new Error("boom")]);
  });

  it("stops: nothing armed runs, and a run in flight does not re-arm", async () => {
    const idle = manualTimers();
    let idleRuns = 0;
    repeat(
      idle.setTimer,
      100,
      () => {
        idleRuns += 1;
      },
      () => undefined,
    )();
    await idle.fire();
    expect(idleRuns).toBe(0);
    expect(idle.armed()).toBe(0);

    const busy = manualTimers();
    let release = (): void => undefined;
    const stop = repeat(
      busy.setTimer,
      100,
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      () => undefined,
    );
    const inFlight = busy.fire(100);
    await Promise.resolve();
    stop();
    release();
    await inFlight;
    expect(busy.armed()).toBe(0);
  });
});
