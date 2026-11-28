/**
 * Ledger clear-signing descriptor binding. Descriptors are hostile public bytes: parse their form,
 * bind only what matches the decoded request exactly, drop anything else. The device re-verifies
 * every claim inside the vendor signatures.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  checksumEvmAddress,
  domainChainId,
  evmTokenTable,
  lookupEvmToken,
  networkChainId,
  parseTypedData,
  typedDataLeaf,
  typedDataSchemaHash,
} from "@qntx/wallet-chains/evm";
import type { EvmTokenTable } from "@qntx/wallet-chains/evm";
import type {
  ChainSignRequest,
  LedgerDescriptors,
  LedgerTypedDataFilters,
} from "@qntx/wallet/protocol";

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
  if (!payload.subarray(1, 1 + tickerLength).every((b) => b >= 0x20 && b <= 0x7e)) {
    return undefined;
  }
  const ticker = new TextDecoder().decode(payload.subarray(1, 1 + tickerLength));
  const addressOffset = 1 + tickerLength;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const decimals = view.getUint32(addressOffset + 20);
  if (decimals > 0xff) {
    return undefined;
  }
  try {
    secp256k1.Signature.fromBytes(payload.subarray(fixed), "der");
  } catch {
    return undefined;
  }
  return {
    ticker,
    address: bytesToHex(payload.subarray(addressOffset, addressOffset + 20)),
    decimals,
    chainId: view.getUint32(addressOffset + 24),
  };
};

export type LedgerBinding = {
  readonly tokens: ReadonlyArray<Uint8Array>;
  readonly typedData?: LedgerTypedDataFilters;
  /**
   * Token payload serving each amount join id (0xff = the verifying contract), when typed data
   * binds.
   */
  readonly joinTokens?: ReadonlyArray<{ readonly join: number; readonly payload: Uint8Array }>;
};

/**
 * Exactly one token payload binding chain/address (and the kernel table when listed), else
 * undefined.
 */
const bindToken = (
  descriptors: LedgerDescriptors,
  table: EvmTokenTable,
  chainId: number,
  target: string,
): Uint8Array | undefined => {
  const matches: Uint8Array[] = [];
  for (const payload of descriptors.tokens ?? []) {
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
  return matches.length === 1 ? match : undefined;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/* Binding checks only — the device re-verifies chain, contract, schema hash, paths and payload
   forms inside every filter signature it checks (eip712_v1_filtering.c). */
const bindTypedData = (
  request: ChainSignRequest & { readonly kind: "evm.typed-data" },
  descriptors: LedgerDescriptors,
  table: EvmTokenTable,
): LedgerBinding | undefined => {
  const td = descriptors.typedData;
  if (td === undefined) {
    return undefined;
  }
  let json;
  let chainId: number;
  try {
    ({ json } = parseTypedData(request.typedData));
    chainId = networkChainId(request.network);
  } catch {
    return undefined;
  }
  const { verifyingContract } = json.domain;
  const [infoNameLength] = td.info;
  if (
    td.chainId !== chainId ||
    domainChainId(json.domain) !== chainId ||
    typeof verifyingContract !== "string" ||
    verifyingContract.toLowerCase() !== td.verifyingContract.toLowerCase() ||
    typedDataSchemaHash(json.types) !== td.schemaHash ||
    td.info[1 + (infoNameLength ?? 0)] !== td.filters.length
  ) {
    return undefined;
  }
  const paths = new Set<string>();
  const joins = new Map<number, string>();
  const amounts: number[] = [];
  for (const filter of td.filters) {
    const resolved = typedDataLeaf(json, filter.path);
    if (paths.has(filter.path) || resolved === undefined) {
      return undefined;
    }
    paths.add(filter.path);
    if (filter.kind === 0xfd) {
      const [join] = filter.data;
      if (
        join === undefined ||
        typeof resolved.value !== "string" ||
        !ADDRESS.test(resolved.value)
      ) {
        return undefined;
      }
      joins.set(join, resolved.value.toLowerCase());
    }
    if (filter.kind === 0xfe) {
      const [valueNameLength] = filter.data;
      const join = filter.data[1 + (valueNameLength ?? 0)];
      if (join === undefined) {
        return undefined;
      }
      amounts.push(join);
    }
  }
  const byAddress = new Map<string, Uint8Array>();
  const joinTokens: Array<{ readonly join: number; readonly payload: Uint8Array }> = [];
  const seenJoins = new Set<number>();
  for (const join of amounts) {
    const address = join === 0xff ? td.verifyingContract.toLowerCase() : joins.get(join);
    if (address === undefined) {
      return undefined;
    }
    let payload = byAddress.get(address);
    if (payload === undefined) {
      payload = bindToken(descriptors, table, chainId, address.slice(2));
      if (payload === undefined) {
        return undefined;
      }
      byAddress.set(address, payload);
    }
    if (!seenJoins.has(join)) {
      seenJoins.add(join);
      joinTokens.push({ join, payload });
    }
  }
  return { tokens: [...byAddress.values()], typedData: td, joinTokens };
};

/** Binds host descriptors to the decoded request; duplicate or partial matches never bind. */
export const bindLedger = (
  request: ChainSignRequest,
  plan: ChainPlan,
  descriptors: LedgerDescriptors | undefined,
  table: EvmTokenTable = evmTokenTable,
): LedgerBinding | undefined => {
  if (descriptors === undefined) {
    return undefined;
  }
  if (request.kind === "evm.typed-data" && plan.kind === "evm.typed-data") {
    return bindTypedData(request, descriptors, table);
  }
  if (
    request.kind !== "evm.transaction" ||
    plan.kind !== "evm.transaction" ||
    descriptors.tokens === undefined
  ) {
    return undefined;
  }
  const { tx } = request;
  if (
    tx.type === "eip7702" ||
    tx.to === undefined ||
    tx.value !== "0x0" ||
    tx.data.length !== 138
  ) {
    return undefined;
  }
  const selector = tx.data.slice(2, 10);
  if (selector !== "a9059cbb" && selector !== "095ea7b3") {
    return undefined;
  }
  let chainId: number;
  try {
    chainId = networkChainId(request.network);
  } catch {
    return undefined;
  }
  const match = bindToken(descriptors, table, chainId, tx.to.slice(2).toLowerCase());
  return match === undefined ? undefined : { tokens: [match] };
};
