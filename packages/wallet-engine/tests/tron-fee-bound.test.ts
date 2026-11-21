import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { tronBandwidthBytes, tronFeeQuote } from "../src/chains/tron.ts";
import type { TronChainParams, TronResources } from "../src/chains/tron.ts";

/**
 * The fee-evidence oracle: 50 real mainnet transactions per kind with their receipts
 * (vectors/chains/tron-fees.json, produced by scripts/vectors/tron-fees.ts — both immutable). The
 * bandwidth size rule must reproduce every receipt's net_usage/net_fee, and the engine's
 * `tronFeeQuote` maximum must cover every fee the chain actually charged.
 */

type Receipt = {
  readonly netUsage: number;
  readonly netFee: number;
  readonly energyUsageTotal: number;
  readonly result: string;
};
type Sample = {
  readonly kind: string;
  readonly txid: string;
  readonly rawDataHex: string;
  readonly receipt: Receipt;
  readonly fee: number;
  readonly energyReplay?: { readonly energyUsed: number; readonly energyPenalty: number };
};
type Vector = {
  readonly chainParameters: Readonly<Record<string, number>>;
  readonly unmatchedEnergy: ReadonlyArray<{ txid: string; actual: number; holder: number }>;
  readonly samples: ReadonlyArray<Sample>;
};

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/tron-fees.json"), "utf8"),
) as Vector;

const cp = vector.chainParameters;
const PARAMS: TronChainParams = {
  transactionFee: BigInt(Math.trunc(cp["getTransactionFee"] ?? 0)),
  energyFee: BigInt(Math.trunc(cp["getEnergyFee"] ?? 0)),
  createAccountFee: BigInt(Math.trunc(cp["getCreateAccountFee"] ?? 0)),
  createNewAccountFeeInSystemContract: BigInt(
    Math.trunc(cp["getCreateNewAccountFeeInSystemContract"] ?? 0),
  ),
  maxFeeLimit: BigInt(Math.trunc(cp["getMaxFeeLimit"] ?? 0)),
  createNewAccountBandwidthRate: BigInt(Math.trunc(cp["getCreateNewAccountBandwidthRate"] ?? 0)),
  maxCreateAccountTxSize: BigInt(Math.trunc(cp["getMaxCreateAccountTxSize"] ?? 0)),
};
const ZERO: TronResources = {
  freeNetLimit: 0,
  freeNetUsed: 0,
  netLimit: 0,
  netUsed: 0,
  energyLimit: 0,
  energyUsed: 0,
  tronPowerLimit: 0,
  tronPowerUsed: 0,
};
const KINDS = [
  "trx-existing",
  "trx-new",
  "trc10",
  "usdt-holder",
  "usdt-non-holder",
  "freeze",
  "vote",
  "delegate",
];
const isUsdt = (kind: string): boolean => kind.startsWith("usdt");

const bytesOf = (s: Sample): number => tronBandwidthBytes(s.rawDataHex.length / 2);

/** The receipt must either consume staked/free bytes at net_usage, or burn them at net_fee. */
const bandwidthMatch = (s: Sample): boolean => {
  const bytes = bytesOf(s);
  if (s.kind === "trx-new") {
    // An activation pays the flat create-account fee instead of per-byte burn.
    return s.receipt.netUsage === bytes || s.receipt.netFee === Number(PARAMS.createAccountFee);
  }
  return s.receipt.netUsage === bytes || s.receipt.netFee === bytes * Number(PARAMS.transactionFee);
};

const quoteOf = (s: Sample) =>
  tronFeeQuote({
    rawDataLength: s.rawDataHex.length / 2,
    params: PARAMS,
    resources: ZERO,
    activates: s.kind === "trx-new",
    ...(isUsdt(s.kind) && s.energyReplay !== undefined
      ? { energy: { used: s.energyReplay.energyUsed, penalty: s.energyReplay.energyPenalty } }
      : {}),
  });

const covers = (s: Sample): boolean => BigInt(quoteOf(s).max) >= BigInt(s.fee);

const energyReplayMatch = (s: Sample): boolean =>
  s.energyReplay !== undefined && s.energyReplay.energyUsed === s.receipt.energyUsageTotal;

const ratio = (s: Sample): number =>
  s.fee === 0
    ? BigInt(quoteOf(s).max) === 0n
      ? 1
      : Number.POSITIVE_INFINITY
    : Number((BigInt(quoteOf(s).max) * 1000n) / BigInt(s.fee)) / 1000;

const median = (xs: ReadonlyArray<number>): number => {
  const sorted = [...xs].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid] ?? 0;
  const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid] ?? a;
  return (a + b) / 2;
};

describe("tron-fees oracle", () => {
  it.each(KINDS)("has at least 50 %s samples", (kind) => {
    expect(vector.samples.filter((s) => s.kind === kind).length).toBeGreaterThanOrEqual(50);
  });

  it.each(vector.samples)("the bandwidth rule matches the receipt for $kind $txid", (s) => {
    expect(bandwidthMatch(s)).toBe(true);
  });

  it.each(vector.samples)("the quote maximum covers the real fee for $kind $txid", (s) => {
    expect(covers(s)).toBe(true);
  });

  it.each(vector.samples.filter((s) => isUsdt(s.kind)))(
    "the energy replay equals energy_usage_total for $kind $txid",
    (s) => {
      expect(energyReplayMatch(s)).toBe(true);
    },
  );

  it.each(vector.unmatchedEnergy)("$txid holder replay bounds the actual energy", (u) => {
    expect(u.holder).toBeGreaterThanOrEqual(u.actual);
  });

  it("prints the per-kind summary", () => {
    const lines = KINDS.map((kind) => {
      const samples = vector.samples.filter((s) => s.kind === kind);
      const matches = samples.filter(bandwidthMatch).length;
      const ratios = samples.map(ratio);
      return (
        `${kind}: n=${samples.length} bandwidth-rule matches=${matches}` +
        ` max/actual min=${Math.min(...ratios).toFixed(3)} median=${median(ratios).toFixed(3)}`
      );
    });
    for (const line of lines) {
      console.log(line);
    }
    expect(lines).toHaveLength(8);
  });
});
