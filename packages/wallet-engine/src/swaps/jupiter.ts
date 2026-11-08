import { base64 } from "@scure/base";
import {
  getAddressLookupTableDecoder,
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
} from "@solana-program/address-lookup-table";
import { AccountRole, address } from "@solana/kit";
import type { Instruction } from "@solana/kit";

import { ChainError } from "@qntx/wallet-chains";
import type { DisplayIntent } from "@qntx/wallet-chains";
import {
  PROGRAM_IDS,
  SOLANA_NATIVE_ASSET,
  JUPITER_PROGRAM,
  WSOL_MINT,
} from "@qntx/wallet-chains/solana";

import type { SimulationOutcome } from "../requests/simulation.ts";
import type { JupiterInstruction, JupiterSwapQuote } from "./index.ts";

/** Programs a Jupiter `/build` set may touch — anything else is untrusted input. */
const ALLOWED_PROGRAMS = new Set([
  PROGRAM_IDS.system,
  PROGRAM_IDS.associatedToken,
  PROGRAM_IDS.token,
  PROGRAM_IDS.token2022,
  JUPITER_PROGRAM,
]);

export const toAsset = (mint: string): string => (mint === WSOL_MINT ? SOLANA_NATIVE_ASSET : mint);
export const fromAsset = (asset: string): string =>
  asset === SOLANA_NATIVE_ASSET ? WSOL_MINT : asset;

/** Wire instruction → kit instruction (`signer`/`writable` flags become the account role). */
export const jupiterIx = (ix: JupiterInstruction): Instruction => ({
  programAddress: address(ix.programId),
  accounts: ix.accounts.map((a) => ({
    address: address(a.address),
    role: a.signer
      ? a.writable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : a.writable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY,
  })),
  data: ix.data,
});

/**
 * Verifies a decoded intent against a Jupiter quote: `summary` is `swap`, one outflow of the input
 * asset worth `inAmount` to the Jupiter program, exactly one `minimumReceived` of the output asset
 * worth `otherAmountThreshold` paid to the account.
 */
export const assertJupiterIntent = (
  quote: JupiterSwapQuote,
  intent: DisplayIntent,
  account: string,
): void => {
  if (intent.summary !== "swap") {
    throw new ChainError("invalid-request", "the built transaction is not a Jupiter swap");
  }
  const [outflow] = intent.outflows;
  if (outflow === undefined) {
    throw new ChainError("invalid-request", "the quoted swap has no sell leg");
  }
  if (
    outflow.to !== JUPITER_PROGRAM ||
    outflow.amount.asset !== quote.sell ||
    BigInt(outflow.amount.amount) !== quote.sellAmount
  ) {
    throw new ChainError("invalid-request", "the quoted sell leg does not match the call");
  }
  const minimums = intent.minimumReceived ?? [];
  const [minimum] = minimums;
  if (minimums.length !== 1 || minimum === undefined) {
    throw new ChainError("invalid-request", "the quoted swap does not state one minimum received");
  }
  if (
    minimum.to !== account ||
    minimum.amount.asset !== quote.buy ||
    BigInt(minimum.amount.amount) !== quote.minBuyAmount
  ) {
    throw new ChainError("invalid-request", "the quoted minimum does not match the call");
  }
};

/**
 * The simulation must keep the quote's terms: the sell asset loses at most `sellAmount` (plus the
 * fee when it is SOL — lamports pays gas in the same asset), the buy asset gains at least
 * `minBuyAmount`, and no other asset decreases.
 */
export const assertJupiterSimulation = (
  quote: JupiterSwapQuote,
  simulation: SimulationOutcome | undefined,
  maxFee: bigint,
): void => {
  if (simulation?.status !== "success") {
    throw new ChainError(
      "invalid-request",
      `the swap simulation ${simulation?.status === "reverted" ? "reverted" : "is unavailable"}`,
    );
  }
  const total = (asset: string): bigint =>
    simulation.changes
      .filter((c: { readonly asset: string; readonly amount: string }) => c.asset === asset)
      .reduce((sum: bigint, c: { readonly amount: string }) => sum + BigInt(c.amount), 0n);
  const sellIsSol = quote.sell === SOLANA_NATIVE_ASSET;
  const lamportsFloor = sellIsSol ? -quote.sellAmount - maxFee : -maxFee;
  if (total(SOLANA_NATIVE_ASSET) < lamportsFloor) {
    throw new ChainError("invalid-request", "the simulation loses more than the sell amount");
  }
  if (!sellIsSol && total(quote.sell) < -quote.sellAmount) {
    throw new ChainError("invalid-request", "the simulation loses more than the sell amount");
  }
  if (total(quote.buy) < quote.minBuyAmount) {
    throw new ChainError("invalid-request", "the simulation gains less than the minimum received");
  }
  for (const change of simulation.changes) {
    if (
      change.asset !== quote.sell &&
      change.asset !== quote.buy &&
      change.asset !== SOLANA_NATIVE_ASSET &&
      BigInt(change.amount) < 0n
    ) {
      throw new ChainError("invalid-request", "the simulation loses an unrelated asset");
    }
  }
};

/** Raw table account data → the declared address list; wrong owner/layout is a decode error. */
export const readLookupTable = (owner: string, data: Uint8Array): ReadonlyArray<string> => {
  if (owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS) {
    throw new ChainError(
      "invalid-request",
      "a swap lookup table is not owned by the address lookup program",
    );
  }
  try {
    return [...getAddressLookupTableDecoder().decode(data).addresses];
  } catch (error) {
    throw new ChainError(
      "invalid-request",
      `a swap lookup table failed to decode${error instanceof Error ? `: ${error.message}` : ""}`,
    );
  }
};

/** The checks on a quote's instruction set that need no chain reads. */
export const assertJupiterPrograms = (quote: JupiterSwapQuote): void => {
  const all = [...quote.setup, quote.swap, ...(quote.cleanup === undefined ? [] : [quote.cleanup])];
  for (const ix of all) {
    if (!ALLOWED_PROGRAMS.has(ix.programId)) {
      throw new ChainError(
        "invalid-request",
        `the quote touches a foreign program ${ix.programId}`,
      );
    }
  }
  if (quote.swap.programId !== JUPITER_PROGRAM) {
    throw new ChainError("invalid-request", "the swap instruction is not Jupiter's");
  }
};

export const decodeIxData = (data: string): Uint8Array => {
  try {
    return base64.decode(data);
  } catch {
    throw new ChainError("invalid-request", "an instruction's data is not base64");
  }
};
