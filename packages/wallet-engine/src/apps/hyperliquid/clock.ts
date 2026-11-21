import { HyperliquidError } from "./errors.ts";

/** |skew| beyond this refuses to sign: the 15 s expiresAfter window needs ≥ 10 s of slack. */
export const MAX_SKEW_MS = 5000;

/**
 * The device/server clock agreement: one estimate per response, computed from the HTTP `Date`
 * header (1 s resolution, so +500 centres it) against the midpoint of the request — the same
 * single-sample estimate Cristian's algorithm gives. Nonces are device milliseconds, strictly
 * increasing per signer; the estimate never adjusts them — it only gates.
 */
export type HyperliquidClock = {
  /** Feed one response's server time (ms) and the local request bounds (ms). */
  readonly record: (serverMs: number, requestStart: number, responseEnd: number) => void;
  /** The latest skew estimate in ms — positive when the server is ahead — or `undefined`. */
  readonly skew: () => number | undefined;
  /** Throws `clock-skew` once an estimate shows |skew| > {@link MAX_SKEW_MS}. */
  readonly assertSkew: () => void;
  /** The next nonce for `signer` (lowercased address): `max(now, last + 1)`. */
  readonly nextNonce: (signer: string) => number;
};

export function createHyperliquidClock(now: () => number): HyperliquidClock {
  let estimate: number | undefined;
  const lastNonce = new Map<string, number>();
  return {
    record: (serverMs, requestStart, responseEnd) => {
      estimate = serverMs + 500 - (requestStart + responseEnd) / 2;
    },
    skew: () => estimate,
    assertSkew: () => {
      if (estimate !== undefined && Math.abs(estimate) > MAX_SKEW_MS) {
        throw new HyperliquidError("clock-skew", `device clock off by ${estimate} ms`);
      }
    },
    nextNonce: (signer) => {
      const next = Math.max(now(), (lastNonce.get(signer) ?? 0) + 1);
      lastNonce.set(signer, next);
      return next;
    },
  };
}
