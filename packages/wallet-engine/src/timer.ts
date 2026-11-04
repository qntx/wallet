export type SetTimer = (ms: number, fn: () => unknown) => () => void;

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
