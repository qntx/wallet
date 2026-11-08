import {
  ZEROX_API_BASE,
  parseWith,
  zeroExUpstreamResponse,
} from "@qntx/wallet-engine/gateway/contract";
import type { SwapQuoteResponse } from "@qntx/wallet-engine/gateway/contract";

import type { UpstreamProvider } from "../types.ts";
import type { Forwarder } from "./forward.ts";

export type ZeroExConfig = {
  readonly apiKey: string;
  readonly fee?: { readonly recipient: string; readonly bps: number };
};

const PROVIDER: UpstreamProvider = { id: "0x", url: ZEROX_API_BASE };

const upstreamFeeOf = (
  fee: { readonly amount: string; readonly token: string } | undefined,
): { readonly token: string; readonly amount: string } | undefined =>
  fee === undefined ? undefined : { token: fee.token, amount: fee.amount };

/**
 * Calls 0x's allowance-holder quote and normalizes it into the wire shape. The upstream error body
 * is never forwarded: a 4xx becomes a bare `invalid-request`, transport/5xx failures a `503`.
 */
export type ZeroExQuote = { readonly badRequest: true } | SwapQuoteResponse;

export async function zeroExQuote(
  forwarder: Forwarder,
  fetch: typeof globalThis.fetch,
  config: ZeroExConfig,
  query: {
    readonly chainId: number;
    readonly sellToken: string;
    readonly buyToken: string;
    readonly sellAmount: string;
    readonly taker: string;
    readonly slippageBps: number;
  },
): Promise<ZeroExQuote> {
  const url = new URL(`${ZEROX_API_BASE}/swap/allowance-holder/quote`);
  url.searchParams.set("chainId", String(query.chainId));
  url.searchParams.set("sellToken", query.sellToken);
  url.searchParams.set("buyToken", query.buyToken);
  url.searchParams.set("sellAmount", query.sellAmount);
  url.searchParams.set("taker", query.taker);
  url.searchParams.set("slippageBps", String(query.slippageBps));
  if (config.fee !== undefined) {
    url.searchParams.set("swapFeeRecipient", config.fee.recipient);
    url.searchParams.set("swapFeeBps", String(config.fee.bps));
  }
  const { value } = await forwarder.run([PROVIDER], async (_provider, signal) => {
    const http = await fetch(url, {
      headers: { "0x-api-key": config.apiKey, "0x-version": "v2" },
      signal,
    });
    const text = await http.text();
    if (!http.ok) {
      /* A 4xx with a parseable 0x error body is a bad request, not an outage. */
      let badRequest = false;
      if (http.status >= 400 && http.status < 500) {
        try {
          const parsed: unknown = JSON.parse(text);
          badRequest = typeof parsed === "object" && parsed !== null && "code" in parsed;
        } catch {
          badRequest = false;
        }
      }
      if (badRequest) {
        return { badRequest: true } as const;
      }
      throw new Error(`0x returned ${http.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("0x returned a non-JSON body");
    }
    const res = parseWith(zeroExUpstreamResponse, body);
    if (res === undefined) {
      throw new Error("0x returned an unexpected body");
    }
    if (!res.liquidityAvailable) {
      return { liquidity: false } satisfies SwapQuoteResponse;
    }
    const tx = res.transaction;
    if (
      tx === undefined ||
      res.sellToken === undefined ||
      res.buyToken === undefined ||
      res.sellAmount === undefined ||
      res.buyAmount === undefined ||
      res.minBuyAmount === undefined ||
      res.blockNumber === undefined
    ) {
      throw new Error("0x returned an incomplete quote");
    }

    return {
      liquidity: true,
      provider: "0x",
      sellToken: res.sellToken,
      buyToken: res.buyToken,
      sellAmount: res.sellAmount,
      buyAmount: res.buyAmount,
      minBuyAmount: res.minBuyAmount,
      allowanceTarget: res.allowanceTarget ?? null,
      transaction: { to: tx.to, data: tx.data, value: tx.value, gas: tx.gas },
      fees: {
        integrator: upstreamFeeOf(res.fees?.integratorFee ?? undefined) ?? null,
        zeroEx: upstreamFeeOf(res.fees?.zeroExFee ?? undefined) ?? null,
      },
      blockNumber: res.blockNumber,
    } satisfies SwapQuoteResponse;
  });
  return value;
}
