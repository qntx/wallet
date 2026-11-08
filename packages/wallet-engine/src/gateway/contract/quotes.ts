import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";
import { caip2 } from "./primitives.ts";

/** The native-token sentinel 0x uses for sell and buy tokens. */
export const ZEROX_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** `0x` + 40 hex — an EVM address, the 0x native sentinel `0xEeee…` among them. */
const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));

/** A decimal string of a non-negative integer (`"0"` allowed for gas nulls). */
const decimal = z.string().check(z.regex(/^[0-9]+$/));

/** The `swapQuote` request: which exact-in sell on which chain, for which taker, at what slippage. */
export const swapQuoteRequest = z.object({
  /** `eip155:<n>` — the only namespace a 0x swap supports. */
  network: caip2.check(z.regex(/^eip155:[0-9]+$/)),
  /** The token sold — an ERC-20 address, or `0xEeeee…` for native. */
  sellToken: evmAddress,
  /** The token bought — an ERC-20 address, or `0xEeeee…` for native. */
  buyToken: evmAddress,
  /** Exact base-unit sell amount, a positive integer as decimal. */
  sellAmount: z.string().check(z.regex(/^[1-9][0-9]*$/)),
  /** The address the settlement contract pays out for. */
  taker: evmAddress,
  /** Worst-case slippage in basis points, 1–5000 (a query string, coerced). */
  slippageBps: z.coerce.number().check(z.int(), z.minimum(1), z.maximum(5000)),
});

const fee = z.object({
  /** The token the fee is charged in (sell or buy token). */
  token: evmAddress,
  /** The fee amount in base units. */
  amount: decimal,
});

/** A quote with liquidity: the AllowanceHolder `exec` calldata to sign and the terms it must keep. */
const quoteFilled = z.object({
  liquidity: z.literal(true),
  provider: z.literal("0x"),
  sellToken: evmAddress,
  buyToken: evmAddress,
  sellAmount: decimal,
  buyAmount: decimal,
  minBuyAmount: decimal,
  /** The spender `exec` approves — `null` for a native sell. */
  allowanceTarget: z.union([evmAddress, z.null()]),
  transaction: z.object({
    to: evmAddress,
    data: z.string().check(z.regex(/^0x[0-9a-fA-F]*$/)),
    value: decimal,
    gas: z.union([decimal, z.null()]),
  }),
  fees: z.object({
    integrator: z.union([fee, z.null()]),
    zeroEx: z.union([fee, z.null()]),
  }),
  /** The block the quote was priced at — staleness is measured against this. */
  blockNumber: decimal,
});

/** No route found: the response carries only the liquidity flag. */
const quoteEmpty = z.object({ liquidity: z.literal(false) });

export const swapQuoteResponse = z.union([quoteFilled, quoteEmpty]);

export const swapQuote = endpoint("GET", "/v1/quotes/swap", swapQuoteRequest, swapQuoteResponse);

export type SwapQuoteRequest = z.infer<typeof swapQuoteRequest>;
export type SwapQuoteResponse = z.infer<typeof swapQuoteResponse>;
