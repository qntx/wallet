import type { IRequestTransport } from "@nktkas/hyperliquid";

import type { HyperliquidNetwork } from "@qntx/wallet/protocol";

import { timeoutSignal } from "../../timer.ts";
import type { SetTimer } from "../../timer.ts";
import type { HyperliquidClock } from "./clock.ts";
import { HyperliquidError } from "./errors.ts";

export const REQUEST_TIMEOUT_MS = 10_000;

const BASE_URL: Readonly<Record<HyperliquidNetwork, string>> = {
  Mainnet: "https://api.hyperliquid.xyz",
  Testnet: "https://api.hyperliquid-testnet.xyz",
};

export type HyperliquidTransportOptions = {
  readonly network: HyperliquidNetwork;
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly clock: HyperliquidClock;
  readonly timeoutMs?: number;
};

/**
 * The SDK `IRequestTransport` over the injected `fetch` — never the global one — with a timeout on
 * the injected timer. Every response's `Date` header feeds the clock. A deadline miss surfaces as
 * `HyperliquidError("timeout")`, never a generic network error: an /exchange post that timed out
 * may still have committed.
 */
export function createHyperliquidTransport(
  options: HyperliquidTransportOptions,
): IRequestTransport {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = BASE_URL[options.network];
  return {
    isTestnet: options.network === "Testnet",
    request: async <T>(endpoint: "info" | "exchange", payload: unknown, signal?: AbortSignal) => {
      const requestStart = options.now();
      const bound = timeoutSignal(timeoutMs, options.setTimer);
      let callerAborted = false;
      const onAbort = (): void => {
        callerAborted = true;
        bound.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await options.fetch(`${base}/${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: bound.signal,
        });
        const date = response.headers.get("date");
        if (date !== null) {
          const serverMs = Date.parse(date);
          if (!Number.isNaN(serverMs)) {
            options.clock.record(serverMs, requestStart, options.now());
          }
        }
        if (!response.ok) {
          throw new HyperliquidError(
            "unavailable",
            `POST /${endpoint} answered ${response.status}`,
          );
        }
        try {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IRequestTransport<T> delegates validation to the SDK caller's schema
          return (await response.json()) as T;
        } catch (error) {
          throw new HyperliquidError("network", `POST /${endpoint} answered non-JSON`, error);
        }
      } catch (error) {
        if (error instanceof HyperliquidError) {
          throw error;
        }
        if (bound.signal.aborted && !callerAborted) {
          throw new HyperliquidError("timeout", `POST /${endpoint} timed out`, error);
        }
        throw new HyperliquidError("network", `POST /${endpoint} failed`, error);
      } finally {
        bound.cancel();
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
