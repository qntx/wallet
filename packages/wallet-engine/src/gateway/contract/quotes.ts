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

/** Base58 public key — Solana mints, program ids, takers and accounts are all 32-byte keys. */
const base58 = z.string().check(z.regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/));

/** Jupiter is mainnet-only — every other Solana CAIP-2 id is a client error. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** The `swapQuoteSolana` request: an exact-in mint pair for a taker on Solana mainnet. */
export const swapQuoteSolanaRequest = z.object({
  network: z.literal(SOLANA_MAINNET),
  /** The mint sold — `So111…112` for wrapped SOL. */
  inputMint: base58,
  /** The mint bought — `So111…112` for wrapped SOL. */
  outputMint: base58,
  /** Exact base-unit sell amount, a positive integer as decimal. */
  amount: z.string().check(z.regex(/^[1-9][0-9]*$/)),
  /** The account the swap settles for. */
  taker: base58,
  /** Worst-case slippage in basis points, 1–5000 (a query string, coerced). */
  slippageBps: z.coerce.number().check(z.int(), z.minimum(1), z.maximum(5000)),
});

/** One Solana instruction as the wire carries it — base64 data, plain account flags. */
export const solanaInstruction = z.object({
  programId: base58,
  accounts: z.array(
    z.object({
      address: base58,
      signer: z.boolean(),
      writable: z.boolean(),
    }),
  ),
  data: z.string().check(z.regex(/^[A-Za-z0-9+/]*={0,2}$/)),
});

/**
 * A Jupiter `/build` relay: the instructions that assemble the versioned transaction — the engine
 * replaces the compute budget with its own and reads the named lookup tables from chain.
 */
const solanaQuoteFilled = z.object({
  liquidity: z.literal(true),
  provider: z.literal("jupiter"),
  inputMint: base58,
  outputMint: base58,
  inAmount: decimal,
  outAmount: decimal,
  otherAmountThreshold: decimal,
  slippageBps: z.coerce.number().check(z.int(), z.minimum(0), z.maximum(10_000)),
  setup: z.array(solanaInstruction),
  swap: solanaInstruction,
  cleanup: z.union([solanaInstruction, z.null()]),
  /** The address lookup tables the message compresses against — contents never come over the wire. */
  lookupTables: z.array(base58),
});

export const swapQuoteSolanaResponse = z.union([solanaQuoteFilled, quoteEmpty]);

export const swapQuoteSolana = endpoint(
  "GET",
  "/v1/quotes/swap/solana",
  swapQuoteSolanaRequest,
  swapQuoteSolanaResponse,
);

export type SwapQuoteSolanaRequest = z.infer<typeof swapQuoteSolanaRequest>;
export type SwapQuoteSolanaResponse = z.infer<typeof swapQuoteSolanaResponse>;

/** The `bridgeQuote` request: an exact-in token transfer from an origin chain to a destination. */
export const bridgeQuoteRequest = z.object({
  /** `eip155:<n>` — the origin chain. */
  network: caip2.check(z.regex(/^eip155:[0-9]+$/)),
  /** `eip155:<n>` — the destination chain. */
  destinationNetwork: caip2.check(z.regex(/^eip155:[0-9]+$/)),
  /** The token deposited on the origin chain — the chain's wrapped native for a native send. */
  inputToken: evmAddress,
  /** The token received on the destination chain. */
  outputToken: evmAddress,
  /** Exact base-unit input amount, a positive integer as decimal. */
  amount: z.string().check(z.regex(/^[1-9][0-9]*$/)),
  /** The account the deposit settles for. */
  taker: evmAddress,
});

/**
 * An Across `/suggested-fees` relay: the deposit terms the engine must verify on-chain — output and
 * deadline verbatim, the spoke pool address so a stale or spoofed build is refused.
 */
const bridgeQuoteFilled = z.object({
  liquidity: z.literal(true),
  provider: z.literal("across"),
  inputToken: evmAddress,
  outputToken: evmAddress,
  inputAmount: decimal,
  outputAmount: decimal,
  destinationNetwork: caip2.check(z.regex(/^eip155:[0-9]+$/)),
  quoteTimestamp: z.coerce.number().check(z.int()),
  fillDeadline: z.coerce.number().check(z.int()),
  exclusiveRelayer: evmAddress,
  exclusivityParameter: z.coerce.number().check(z.int()),
  spokePool: evmAddress,
  limits: z.object({ minDeposit: decimal, maxDeposit: decimal }),
});

export const bridgeQuoteResponse = z.union([bridgeQuoteFilled, quoteEmpty]);

export const bridgeQuote = endpoint(
  "GET",
  "/v1/quotes/bridge",
  bridgeQuoteRequest,
  bridgeQuoteResponse,
);

export type BridgeQuoteRequest = z.infer<typeof bridgeQuoteRequest>;
export type BridgeQuoteResponse = z.infer<typeof bridgeQuoteResponse>;
