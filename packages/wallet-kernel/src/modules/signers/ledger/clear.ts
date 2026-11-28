/**
 * Ledger clear-signing descriptor binding. Descriptors arrive from the host as public, hostile
 * bytes: this module only parses their form and decides whether one is exactly the token the
 * decoded request names. A malformed or non-binding descriptor is dropped — never an error — and
 * only the device verifies the vendor signature.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  checksumEvmAddress,
  evmTokenTable,
  lookupEvmToken,
  networkChainId,
} from "@qntx/wallet-chains/evm";
import type { EvmTokenTable } from "@qntx/wallet-chains/evm";
import type { ChainSignRequest, LedgerDescriptors } from "@qntx/wallet/protocol";

import type { ChainPlan } from "../../chains/run.ts";

/* app-ethereum's MAX_TICKER_LEN is 51 including the trailing NUL (tests/unit/src/
   test_cmd_provide_token_info.c), so the wire ticker is at most 50 bytes. */
const MAX_TICKER_BYTES = 50;

export type ParsedTokenDescriptor = {
  readonly ticker: string;
  /** Lowercase 40-hex-character address, without a `0x` prefix. */
  readonly address: string;
  readonly decimals: number;
  readonly chainId: number;
};

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Parses the legacy token payload (`E0 0A` data), strict on layout, ticker, decimals and DER. */
export const parseTokenDescriptor = (payload: Uint8Array): ParsedTokenDescriptor | undefined => {
  const [tickerLength] = payload;
  if (tickerLength === undefined || tickerLength < 1 || tickerLength > MAX_TICKER_BYTES) {
    return undefined;
  }
  const fixed = 1 + tickerLength + 20 + 4 + 4;
  if (payload.length <= fixed) {
    return undefined;
  }
  const tickerBytes = payload.subarray(1, 1 + tickerLength);
  if (!tickerBytes.every((b) => b >= 0x20 && b <= 0x7e)) {
    return undefined;
  }
  const ticker = new TextDecoder("ascii", { fatal: true }).decode(tickerBytes);
  const addressOffset = 1 + tickerLength;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const decimals = view.getUint32(addressOffset + 20);
  if (decimals > 0xff) {
    return undefined;
  }
  const chainId = view.getUint32(addressOffset + 24);
  const signature = payload.subarray(fixed);
  try {
    secp256k1.Signature.fromBytes(signature, "der");
  } catch {
    return undefined;
  }
  return {
    ticker,
    address: hex(payload.subarray(addressOffset, addressOffset + 20)),
    decimals,
    chainId,
  };
};

const evmHexBytes = (data: string): number | undefined =>
  /^0x(?:[0-9a-fA-F]{2})*$/.test(data) ? (data.length - 2) / 2 : undefined;

const zeroQuantity = (value: string): boolean => {
  try {
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
};

/** Binds exactly one payload to a zero-value ERC-20 transfer/approve; duplicates refuse to bind. */
export const bindLedger = (
  request: ChainSignRequest,
  plan: ChainPlan,
  descriptors: LedgerDescriptors | undefined,
  table: EvmTokenTable = evmTokenTable,
): { readonly tokens: ReadonlyArray<Uint8Array> } | undefined => {
  if (
    request.kind !== "evm.transaction" ||
    plan.kind !== "evm.transaction" ||
    descriptors?.tokens === undefined
  ) {
    return undefined;
  }
  const { tx } = request;
  if (tx.type === "eip7702" || tx.to === undefined || !zeroQuantity(tx.value)) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
    return undefined;
  }
  const dataLength = evmHexBytes(tx.data);
  if (dataLength !== 68) {
    return undefined;
  }
  const selector = tx.data.slice(2, 10).toLowerCase();
  if (selector !== "a9059cbb" && selector !== "095ea7b3") {
    return undefined;
  }
  let chainId: number;
  try {
    chainId = networkChainId(request.network);
  } catch {
    return undefined;
  }
  const target = tx.to.slice(2).toLowerCase();
  const matches: Uint8Array[] = [];
  for (const payload of descriptors.tokens) {
    const parsed = parseTokenDescriptor(payload);
    if (parsed === undefined || parsed.chainId !== chainId || parsed.address !== target) {
      continue;
    }
    const listed = lookupEvmToken(table, chainId, checksumEvmAddress(`0x${target}`));
    if (
      listed !== undefined &&
      (listed.decimals !== parsed.decimals || listed.symbol !== parsed.ticker)
    ) {
      continue;
    }
    matches.push(payload);
  }
  const [match] = matches;
  return matches.length === 1 && match !== undefined ? { tokens: [match] } : undefined;
};
