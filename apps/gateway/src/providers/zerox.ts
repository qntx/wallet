import * as z from "zod/mini";

import { parseWith } from "@qntx/wallet-engine/gateway/contract";
import type { SwapQuoteResponse } from "@qntx/wallet-engine/gateway/contract";

import type { ResolvedProvider } from "../types.ts";
import type { Forwarder } from "./forward.ts";

export type ZeroExConfig = {
  readonly apiKey: string;
  readonly fee?: { readonly recipient: string; readonly bps: number };
};

/**
 * The 0x relay bindings — the API key alone enables the route; the fee pair is validated once, at
 * option build, so a misconfigured worker fails closed instead of forwarding junk to 0x.
 */
export const zeroExConfig = (env: {
  readonly ZEROX_API_KEY?: string;
  readonly ZEROX_FEE_RECIPIENT?: string;
  readonly ZEROX_FEE_BPS?: string;
}): ZeroExConfig | undefined => {
  if (env.ZEROX_API_KEY === undefined) {
    return undefined;
  }
  if (env.ZEROX_FEE_RECIPIENT === undefined && env.ZEROX_FEE_BPS === undefined) {
    return { apiKey: env.ZEROX_API_KEY };
  }
  const recipient = env.ZEROX_FEE_RECIPIENT ?? "";
  const bps = env.ZEROX_FEE_BPS ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || !/^[0-9]+$/.test(bps)) {
    throw new Error("invalid ZEROX_FEE_RECIPIENT or ZEROX_FEE_BPS");
  }
  const bpsN = Number(bps);
  if (!Number.isInteger(bpsN) || bpsN < 1 || bpsN > 1000) {
    throw new Error("invalid ZEROX_FEE_RECIPIENT or ZEROX_FEE_BPS");
  }
  return { apiKey: env.ZEROX_API_KEY, fee: { recipient, bps: bpsN } };
};

const ZEROX_API_BASE = "https://api.0x.org";

const PROVIDER: ResolvedProvider = { id: "0x", url: ZEROX_API_BASE };

/** `0x` + 40 hex — an EVM address, the 0x native sentinel `0xEeee…` among them. */
const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));

/** A decimal string of a non-negative integer (`"0"` allowed for gas nulls). */
const decimal = z.string().check(z.regex(/^[0-9]+$/));

const upstreamFee = z.object({
  amount: decimal,
  token: evmAddress,
  type: z.string(),
});

/**
 * The fields of the 0x allowance-holder quote response the gateway consumes — `route`,
 * `tokenMetadata`, `totalNetworkFee` and the rest are left on the wire on purpose.
 */
const zeroExUpstreamResponse = z.object({
  liquidityAvailable: z.boolean(),
  allowanceTarget: z.optional(z.union([evmAddress, z.null()])),
  blockNumber: z.optional(decimal),
  buyAmount: z.optional(decimal),
  buyToken: z.optional(evmAddress),
  sellAmount: z.optional(decimal),
  sellToken: z.optional(evmAddress),
  minBuyAmount: z.optional(decimal),
  fees: z.optional(
    z.object({
      integratorFee: z.optional(z.union([upstreamFee, z.null()])),
      zeroExFee: z.optional(z.union([upstreamFee, z.null()])),
    }),
  ),
  transaction: z.optional(
    z.object({
      to: evmAddress,
      data: z.string().check(z.regex(/^0x[0-9a-fA-F]*$/)),
      value: decimal,
      gas: z.union([decimal, z.null()]),
    }),
  ),
  zid: z.optional(z.string()),
});

const upstreamFeeOf = (
  fee: { readonly amount: string; readonly token: string } | undefined,
): { readonly token: string; readonly amount: string } | undefined =>
  fee === undefined ? undefined : { token: fee.token, amount: fee.amount };

/**
 * Calls 0x's allowance-holder quote and normalizes it into the wire shape. The upstream error body
 * is never forwarded: a client error (400, 403, 422) is a bare `invalid-request`; anything else —
 * auth, rate limit, 5xx, transport, malformed body — is an upstream `503`.
 */
export type ZeroExQuote = { readonly badRequest: true } | SwapQuoteResponse;

/** The upstream statuses that mean "the request is wrong", not "0x is down". */
const CLIENT_ERROR: ReadonlySet<number> = new Set([400, 403, 422]);

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
      if (CLIENT_ERROR.has(http.status)) {
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
