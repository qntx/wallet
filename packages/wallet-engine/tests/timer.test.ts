import { describe, expect, it } from "vite-plus/test";

import { timeoutSignal } from "../src/timer.ts";

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
