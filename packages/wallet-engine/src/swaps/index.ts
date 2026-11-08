import { parseAbi } from "viem";

import { ChainError } from "@qntx/wallet-chains";
import type { DisplayIntent } from "@qntx/wallet-chains";
import { EVM_NATIVE_ASSET } from "@qntx/wallet-chains/evm";

import type { SimulationOutcome } from "../requests/simulation.ts";

export { ALLOWANCE_HOLDER, MAX_UINT256 } from "@qntx/wallet-chains/evm";

/** The AllowanceHolder runtime-code keccak, identical on every chain it deploys to. */
export const ALLOWANCE_HOLDER_CODE_HASH =
  "0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799";

/** The 0x deployer: `ownerOf(2)` is the current taker Settler, `prev(2)` the previous one. */
export const ZEROX_REGISTRY = "0x00000000000004533Fe15556B1E086BB1A72cEae";

/** The deployer registry: taker Settler is feature id 2 (meta-tx is 3, intent 4, bridge 5). */
export const SETTLER_REGISTRY_ABI = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function prev(uint128) view returns (address)",
]);
export const SETTLER_FEATURE = 2n;

/** A quote older than this may not be signed. */
export const QUOTE_MAX_AGE_MS = 60_000;

/**
 * The terms a gateway swap quote commits to — `sell`/`buy` use the engine's own asset ids
 * (`native`, `erc20:<addr>`) rather than the 0x sentinel.
 */
export type SwapQuote = ZeroExSwapQuote | JupiterSwapQuote;

export type ZeroExSwapQuote = {
  readonly provider: "0x";
  readonly network: string;
  readonly taker: string;
  readonly sell: string;
  readonly buy: string;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly allowanceTarget: string | undefined;
  readonly transaction: {
    readonly to: string;
    readonly data: string;
    readonly value: bigint;
    readonly gas: bigint | undefined;
  };
  readonly fees: {
    readonly integrator: { readonly token: string; readonly amount: bigint } | undefined;
    readonly zeroEx: { readonly token: string; readonly amount: bigint } | undefined;
  };
  readonly blockNumber: bigint;
  readonly fetchedAt: number;
};

/** One instruction of a Jupiter `/build` set — wire accounts, raw base64-decoded data. */
export type JupiterInstruction = {
  readonly programId: string;
  readonly accounts: ReadonlyArray<{
    readonly address: string;
    readonly signer: boolean;
    readonly writable: boolean;
  }>;
  readonly data: Uint8Array;
};

/**
 * A Jupiter build the engine verifies on-chain before signing — mints use the engine's asset ids
 * (`lamports` for native SOL), amounts are base-unit bigints.
 */
export type JupiterSwapQuote = {
  readonly provider: "jupiter";
  readonly network: string;
  readonly taker: string;
  readonly sell: string;
  readonly buy: string;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly setup: ReadonlyArray<JupiterInstruction>;
  readonly swap: JupiterInstruction;
  readonly cleanup: JupiterInstruction | undefined;
  /** Address lookup table addresses — contents are read from chain, never the gateway. */
  readonly lookupTables: ReadonlyArray<string>;
  readonly fetchedAt: number;
};

const sameAsset = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

/**
 * Verifies a decoded `exec` intent against the quote it claims to settle: `summary` is `swap`, the
 * sell outflow matches `sell`/`sellAmount`, exactly one `minimumReceived` pays `account` the
 * `buy`/`minBuyAmount` within `(0, buyAmount]`. Every violation throws — the quote is untrusted.
 */
export const assertSwapIntent = (
  quote: SwapQuote,
  intent: DisplayIntent,
  account: string,
): void => {
  if (intent.summary !== "swap") {
    throw new ChainError("invalid-request", "the quoted transaction is not a 0x swap");
  }
  const [outflow] = intent.outflows;
  if (outflow === undefined) {
    throw new ChainError("invalid-request", "the quoted swap has no sell leg");
  }
  const sellNative = quote.sell === EVM_NATIVE_ASSET;
  if (
    (sellNative && outflow.amount.asset !== EVM_NATIVE_ASSET) ||
    (!sellNative && outflow.amount.asset.toLowerCase() !== quote.sell.toLowerCase())
  ) {
    throw new ChainError("invalid-request", "the quoted sell token does not match the call");
  }
  if (BigInt(outflow.amount.amount) !== quote.sellAmount) {
    throw new ChainError("invalid-request", "the quoted sell amount does not match the call");
  }
  const minimums = intent.minimumReceived ?? [];
  const [minimum] = minimums;
  if (minimums.length !== 1 || minimum === undefined) {
    throw new ChainError("invalid-request", "the quoted swap does not state one minimum received");
  }
  if (minimum.to.toLowerCase() !== account.toLowerCase()) {
    throw new ChainError("invalid-request", "the quoted swap does not pay the account");
  }
  const buyNative = quote.buy === EVM_NATIVE_ASSET;
  if (
    (buyNative && minimum.amount.asset !== EVM_NATIVE_ASSET) ||
    (!buyNative && minimum.amount.asset.toLowerCase() !== quote.buy.toLowerCase())
  ) {
    throw new ChainError("invalid-request", "the quoted buy token does not match the call");
  }
  if (BigInt(minimum.amount.amount) !== quote.minBuyAmount) {
    throw new ChainError("invalid-request", "the quoted minimum does not match the call");
  }
  if (quote.minBuyAmount <= 0n || quote.minBuyAmount > quote.buyAmount) {
    throw new ChainError("invalid-request", "the quoted minimum is not within the quote's range");
  }
};

/**
 * Asserts the swap simulation keeps the quote's terms: the sell asset loses at most `sellAmount`
 * (plus the fee for a native sell, which pays gas in the same asset — the simulation's native diff
 * already includes it), the buy asset gains at least `minBuyAmount`, and no other asset decreases.
 */
export const assertSwapSimulation = (
  quote: SwapQuote,
  simulation: SimulationOutcome | undefined,
  gasCost: bigint,
): void => {
  if (simulation?.status !== "success") {
    throw new ChainError(
      "invalid-request",
      `the swap simulation ${simulation?.status === "reverted" ? "reverted" : "is unavailable"}`,
    );
  }
  const total = (asset: string): bigint =>
    simulation.changes
      .filter((c) => sameAsset(c.asset, asset))
      .reduce((sum, c) => sum + BigInt(c.amount), 0n);
  const sellIsNative = quote.sell === EVM_NATIVE_ASSET;
  /* Gas is paid in the native asset, so its diff includes the fee on top of a native sell. */
  const nativeFloor = sellIsNative ? -quote.sellAmount - gasCost : -gasCost;
  if (total(EVM_NATIVE_ASSET) < nativeFloor) {
    throw new ChainError("invalid-request", "the simulation loses more than the sell amount");
  }
  if (!sellIsNative && total(quote.sell) < -quote.sellAmount) {
    throw new ChainError("invalid-request", "the simulation loses more than the sell amount");
  }
  if (total(quote.buy) < quote.minBuyAmount) {
    throw new ChainError("invalid-request", "the simulation gains less than the minimum received");
  }
  for (const change of simulation.changes) {
    if (
      !sameAsset(change.asset, quote.sell) &&
      !sameAsset(change.asset, quote.buy) &&
      change.asset !== EVM_NATIVE_ASSET &&
      BigInt(change.amount) < 0n
    ) {
      throw new ChainError("invalid-request", "the simulation loses an unrelated asset");
    }
  }
};
