/**
 * A one-shot timer, `setTimeout` semantics: `fn` runs at most once, `ms` after the call, unless the
 * returned function cancels it first. Every host passes exactly this; loops re-arm through
 * {@link repeat}.
 */
export type SetTimer = (ms: number, fn: () => unknown) => () => void;

/**
 * Runs `task` every `ms` on the one-shot `setTimer`. The next run is armed only once the previous
 * one settles, so runs never overlap; a failed run goes to `onError` and the loop goes on. The
 * returned function stops the loop: a run already in flight finishes, but nothing runs after it.
 */
export function repeat(
  setTimer: SetTimer,
  ms: number,
  task: () => unknown,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  const arm = (): (() => void) =>
    setTimer(ms, async () => {
      try {
        await task();
      } catch (error) {
        onError(error);
      }
      if (!stopped) {
        cancel = arm();
      }
    });
  let cancel = arm();
  return () => {
    stopped = true;
    cancel();
  };
}

/**
 * An `AbortSignal` that fires after `ms` on the injected timer — the platform timeout signal is not
 * available in every runtime this package runs in. Call `cancel` once the work is done, or `abort`
 * to stop it early.
 */
export function timeoutSignal(
  ms: number,
  setTimer: SetTimer,
): { readonly signal: AbortSignal; readonly cancel: () => void; readonly abort: () => void } {
  const controller = new AbortController();
  const cancel = setTimer(ms, () => {
    controller.abort();
  });
  return {
    signal: controller.signal,
    cancel,
    abort: () => {
      controller.abort();
    },
  };
}
