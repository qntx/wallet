/**
 * Pure rules of the request pipeline: merging the gateway's and the independent endpoint's
 * pre-signing reads, and the fee ceilings. Taking the lower fee means a lying gateway can at most
 * slow a transaction down, never make the user overpay.
 */
import type { EvmFeeQuote } from "../chains/evm.ts";
import type { SolanaFeeQuote } from "../chains/solana.ts";

export type RequestCheckCode =
  | "decode-partial"
  | "nonce-mismatch"
  | "fee-mismatch"
  | "reads-unverified"
  | "fee-above-network"
  | "fee-exceeds-amount";

/** Two reads of one fee differ by more than this share of the smaller one. */
export const FEE_MISMATCH_PERCENT = 25n;

/** A fee ceiling above this multiple of the independent estimate is flagged. */
export const FEE_CAP_MULTIPLIER = 2n;

/**
 * `|a − b| / min(a, b)` is strictly above {@link FEE_MISMATCH_PERCENT}; a zero against a non-zero
 * always is.
 */
export const feesDiffer = (a: bigint, b: bigint): boolean => {
  const low = a < b ? a : b;
  const high = a < b ? b : a;
  return (high - low) * 100n > low * FEE_MISMATCH_PERCENT;
};

/**
 * The final ceiling exceeds {@link FEE_CAP_MULTIPLIER} times the independent estimate of the same
 * tier.
 */
export const exceedsNetworkCap = (final: bigint, independent: bigint): boolean =>
  final > independent * FEE_CAP_MULTIPLIER;

/** The worst-case fee is not below the amount sent (native-asset sends only). */
export const feeReachesAmount = (maxFee: bigint, amount: bigint): boolean => maxFee >= amount;

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** EIP-1559 quotes are `maxFee = baseFee × 2 + priority`; this recovers the base fee. */
const baseFeeOf = (quote: EvmFeeQuote): bigint =>
  (quote.maxFeePerGas - (quote.maxPriorityFeePerGas ?? 0n)) / 2n;

/**
 * EIP-1559: priority fee is the lower of the two, `maxFeePerGas = max(baseFee) × 2 + priority` (a
 * high ceiling only prevents a stuck transaction, the base fee actually paid is the chain's).
 * Legacy: the lower gas price. Two different shapes cannot be merged — the independent quote wins.
 */
export const mergeEvmQuote = (
  primary: EvmFeeQuote,
  independent: EvmFeeQuote,
): { readonly quote: EvmFeeQuote; readonly mismatch: boolean } => {
  const a = primary.maxPriorityFeePerGas;
  const b = independent.maxPriorityFeePerGas;
  if (a !== undefined && b !== undefined) {
    const priority = min(a, b);
    const maxFeePerGas = max(baseFeeOf(primary), baseFeeOf(independent)) * 2n + priority;
    return {
      quote: {
        tier: primary.tier,
        wei: maxFeePerGas,
        maxFeePerGas,
        maxPriorityFeePerGas: priority,
      },
      mismatch: feesDiffer(a, b) || feesDiffer(baseFeeOf(primary), baseFeeOf(independent)),
    };
  }
  if (a === undefined && b === undefined) {
    const price = min(primary.maxFeePerGas, independent.maxFeePerGas);
    return {
      quote: {
        tier: primary.tier,
        wei: price,
        maxFeePerGas: price,
        maxPriorityFeePerGas: undefined,
      },
      mismatch: feesDiffer(primary.maxFeePerGas, independent.maxFeePerGas),
    };
  }
  return { quote: independent, mismatch: true };
};

export const mergeSolanaQuote = (
  primary: SolanaFeeQuote,
  independent: SolanaFeeQuote,
): { readonly quote: SolanaFeeQuote; readonly mismatch: boolean } => ({
  quote: {
    tier: primary.tier,
    microLamportsPerCu: min(primary.microLamportsPerCu, independent.microLamportsPerCu),
  },
  mismatch: feesDiffer(primary.microLamportsPerCu, independent.microLamportsPerCu),
});

/** Bitcoin fee rates (sat/vB) per confirmation target. */
export const mergeSatPerByte = (
  primary: number,
  independent: number,
): { readonly rate: number; readonly mismatch: boolean } => ({
  rate: Math.min(primary, independent),
  mismatch: feesDiffer(BigInt(Math.ceil(primary)), BigInt(Math.ceil(independent))),
});

/** The checks a prepared build carries, in a stable order and without duplicates. */
export const collectChecks = (
  flags: ReadonlyArray<RequestCheckCode | undefined>,
): ReadonlyArray<RequestCheckCode> => [
  ...new Set(flags.filter((f): f is RequestCheckCode => f !== undefined)),
];
