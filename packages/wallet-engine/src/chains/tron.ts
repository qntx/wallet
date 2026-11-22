import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
/**
 * TRON chain adapter — readers over the node's `/wallet` and `/walletsolidity` HTTP API plus the
 * pure fee model. Every answer is parsed through the gateway contract schemas: a body that does not
 * satisfy its schema is a malformed `Error`, never a silent default, and the node's `transaction`
 * field is never read — transactions are built locally from phase-1 primitives.
 */
import { createBase58check } from "@scure/base";
import type * as z from "zod/mini";

import { ChainError } from "@qntx/wallet-chains";
import { tronAddressFromHex } from "@qntx/wallet-chains/tron";

import {
  PROVIDERS_HEADER,
  PROVIDER_PIN_HEADER,
  parseTronJson,
  parseWith,
  tronAccountResponse,
  tronAccountResource,
  tronBlockResponse,
  tronBroadcastResponse,
  tronCanDelegateMaxSizeResponse,
  tronChainParameters,
  tronConstantCallResponse,
  tronDelegatedResourceResponse,
  tronRewardResponse,
  tronUnfreezeCountResponse,
  tronWitnessListResponse,
  tronMaybeBlockResponse,
  tronTransactionInfoResponse,
  tronTransactionResponse,
} from "../gateway/contract/index.ts";
import type {
  TronAccount,
  TronIndexerPath,
  TronLog,
  TronMaybeTransaction,
  TronNodePath,
} from "../gateway/contract/index.ts";

/** TRON HTTP client: POSTs an allow-listed path to each endpoint in order. */
export type TronApi = {
  readonly post: (path: TronNodePath | TronIndexerPath, body: unknown) => Promise<unknown>;
};

/** A non-2xx answer from a TRON node API; `retryAfterMs` is the `retry-after` delta in ms. */
class TronHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, retryAfterMs: number | undefined, message: string) {
    super(message);
    this.name = "TronHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The TRON node API is throttling and the transaction's validity window does not leave time to wait
 * the requested backoff out — retry the request later.
 */
export class TronThrottledError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("the TRON node API is throttling — retry later");
    this.name = "TronThrottledError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Ordered failover like `solanaCaller`: a transport error, a non-2xx status, a non-JSON body, or a
 * body that is not a JSON object moves to the next URL; the last error thrown names the path, the
 * status, and the endpoint — never a raw SyntaxError. The loop keeps a failed tail from being
 * re-attempted by an enclosing frame.
 */
export const tronCaller = (
  urls: ReadonlyArray<string>,
  fetchFn: typeof globalThis.fetch,
): TronApi => ({
  post: async (path, body) => {
    let last: unknown;
    for (const url of urls) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- failover is ordered and sequential
        const answered = await postOnce(fetchFn, url, path, body, undefined);
        return answered.parsed;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(path);
  },
});

/**
 * One POST to `url`: the lossless parse shared by both callers — `res.json()` would lose int64
 * precision (java-tron prints int64 as bare numbers and POST requests have no string form,
 * JsonFormat INT64_AS_STRING is GET-only). A transport error, a non-2xx status, a non-JSON body, or
 * a body that is not a JSON object throws an `Error` naming the path, the status, and the endpoint
 * — never a raw SyntaxError. `provider` is the answering upstream's id when the response names one
 * (the gateway's `x-gateway-providers` header).
 */
const postOnce = async (
  fetchFn: typeof globalThis.fetch,
  url: string,
  path: string,
  body: unknown,
  pin: string | undefined,
): Promise<{ readonly parsed: unknown; readonly provider: string | undefined }> => {
  const res = await fetchFn(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(pin === undefined ? {} : { [PROVIDER_PIN_HEADER]: pin }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const ra = res.headers.get("retry-after");
    const retryAfterMs =
      ra !== null && ra !== "" && !Number.isNaN(Number(ra)) ? Number(ra) * 1000 : undefined;
    throw new TronHttpError(res.status, retryAfterMs, `${path}: HTTP ${res.status} from ${url}`);
  }
  let parsed: unknown;
  try {
    /* A parser failure reads as non-JSON: next endpoint on an unpinned call, a thrown error on a
       pinned one. */
    parsed = parseTronJson(await res.text());
  } catch {
    throw new Error(`${path}: non-JSON response from ${url}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path}: malformed response from ${url}`);
  }
  return { parsed, provider: res.headers.get(PROVIDERS_HEADER) ?? undefined };
};

/**
 * Ordered failover only until the first answer: whichever URL answers first is pinned and every
 * later call goes to it alone, so a sequence of reads comes from one upstream. When the answer
 * named a provider, later calls send `x-gateway-provider` so the gateway too serves them from that
 * one node. A pinned call that fails throws — no failover mid-sequence.
 */
/** A retry never re-sends a broadcast: the bytes may already be out from the first attempt. */
const NO_RETRY_PATHS: ReadonlySet<string> = new Set([
  "/wallet/broadcasthex",
  "/wallet/broadcasttransaction",
]);

export const pinnedTronCaller = (
  urls: ReadonlyArray<string>,
  fetchFn: typeof globalThis.fetch,
  retry?: {
    readonly until: () => number;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  },
): TronApi => {
  let pinned: { readonly url: string; readonly provider: string | undefined } | undefined;
  return {
    post: async (path, body) => {
      for (;;) {
        try {
          if (pinned !== undefined) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a throttled attempt retries after the backoff
            const answered = await postOnce(fetchFn, pinned.url, path, body, pinned.provider);
            return answered.parsed;
          }
          let last: unknown;
          for (const url of urls) {
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop -- failover is ordered and sequential
              const answered = await postOnce(fetchFn, url, path, body, undefined);
              pinned = { url, provider: answered.provider };
              return answered.parsed;
            } catch (error) {
              last = error;
            }
          }
          throw last instanceof Error ? last : new Error(path);
        } catch (error) {
          /* A 429/503 inside the transaction's validity window waits the server's backoff and
             re-runs the same attempt — the pin, and the provider pin header with it, is kept.
             Without a deadline the original error propagates as before. */
          if (
            retry === undefined ||
            !(error instanceof TronHttpError) ||
            (error.status !== 429 && error.status !== 503) ||
            NO_RETRY_PATHS.has(path)
          ) {
            throw error;
          }
          const wait = Math.max(250, error.retryAfterMs ?? 1000);
          if (retry.now() + wait > retry.until()) {
            throw new TronThrottledError(wait);
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- the retry waits the server's backoff
          await retry.sleep(wait);
        }
      }
    },
  };
};

/** `value` parsed by `schema`, else a malformed-response `Error` — readers never see raw JSON. */
const parsed = <S extends z.ZodMiniType>(schema: S, what: string, value: unknown): z.output<S> => {
  const out = parseWith(schema, value);
  if (out === undefined) {
    throw new Error(`malformed ${what} response`);
  }
  return out;
};

/** Even-length hex → bytes; anything else is a malformed field, not a thrown TypeError. */
const hexBytes = (value: string): Uint8Array => {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error("malformed hex field");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const printable = /^[\u0020-\u007E]*$/;

const base58check = createBase58check(sha256);

/**
 * The log `address` form depends on the call: `triggerconstantcontract` with `visible` base58checks
 * the bare 20-byte body, `gettransactioninfobyid` returns 40 hex characters — neither carries the
 * 0x41 version byte. Restores it so callers compare `T…` addresses; anything else is `undefined`.
 */
export const tronLogAddress = (address: string | undefined): string | undefined => {
  if (typeof address !== "string") {
    return undefined;
  }
  if (/^[0-9a-fA-F]{40}$/.test(address)) {
    return tronAddressFromHex(`41${address}`);
  }
  try {
    const decoded = base58check.decode(address);
    if (decoded.length === 20) {
      return tronAddressFromHex(`41${bytesToHex(decoded)}`);
    }
  } catch {
    /* not base58check */
  }
  return undefined;
};

/** A node's hex `message`/`resMessage` field as UTF-8 when it is printable text, else verbatim. */
const decodeMessage = (value: string): string => {
  if (!/^([0-9a-fA-F]{2})*$/.test(value)) {
    return value; // some nodes answer plain UTF-8, not hex
  }
  const bytes = hexBytes(value);
  try {
    const text = utf8.decode(bytes);
    return printable.test(text) ? text : value;
  } catch {
    return value;
  }
};

export type TronHead = {
  readonly number: number;
  readonly id: string;
  readonly timestamp: number;
};

/** The latest solidified block — the reference block every engine-built transaction binds to. */
export const solidHead = async (api: TronApi): Promise<TronHead> => {
  const block = parsed(
    tronBlockResponse,
    "/walletsolidity/getnowblock",
    await api.post("/walletsolidity/getnowblock", {}),
  );
  return {
    number: block.block_header.raw_data.number,
    id: block.blockID,
    timestamp: block.block_header.raw_data.timestamp,
  };
};

/** The full node's head height — for reorg proof it is read before the transaction infos. */
export const headNumber = async (api: TronApi): Promise<number> =>
  parsed(tronBlockResponse, "/wallet/getnowblock", await api.post("/wallet/getnowblock", {}))
    .block_header.raw_data.number;

/** The block id at `num`, or `undefined` when the node has no block at that height. */
export const blockId = async (
  api: TronApi,
  num: number,
  solidity: boolean,
): Promise<string | undefined> => {
  const path = solidity ? "/walletsolidity/getblockbynum" : "/wallet/getblockbynum";
  const block = parsed(tronMaybeBlockResponse, path, await api.post(path, { num }));
  return "blockID" in block ? block.blockID : undefined;
};

/** The account row, or `undefined` when the node has no account at `address` (not activated). */
export const account = async (api: TronApi, address: string): Promise<TronAccount | undefined> => {
  const row = parsed(
    tronAccountResponse,
    "/wallet/getaccount",
    await api.post("/wallet/getaccount", { address, visible: true }),
  );
  return row.address === undefined &&
    row.balance === undefined &&
    row.type === undefined &&
    row.assetV2 === undefined
    ? undefined
    : row;
};

export type TronResources = {
  readonly freeNetLimit: number | bigint;
  readonly freeNetUsed: number | bigint;
  readonly netLimit: number | bigint;
  readonly netUsed: number | bigint;
  readonly energyLimit: number | bigint;
  readonly energyUsed: number | bigint;
  /** TRX staked for either resource — the vote power bound and the used fraction. */
  readonly tronPowerLimit: number | bigint;
  readonly tronPowerUsed: number | bigint;
};

/** The account's resource counters; proto3 omits zero fields, so a missing counter is 0. */
export const resources = async (api: TronApi, address: string): Promise<TronResources> => {
  const row = parsed(
    tronAccountResource,
    "/wallet/getaccountresource",
    await api.post("/wallet/getaccountresource", { address, visible: true }),
  );
  return {
    freeNetLimit: row.freeNetLimit ?? 0,
    freeNetUsed: row.freeNetUsed ?? 0,
    netLimit: row.NetLimit ?? 0,
    netUsed: row.NetUsed ?? 0,
    energyLimit: row.EnergyLimit ?? 0,
    energyUsed: row.EnergyUsed ?? 0,
    tronPowerLimit: row.tronPowerLimit ?? 0,
    tronPowerUsed: row.tronPowerUsed ?? 0,
  };
};

/** The fee-model chain parameters, all in sun per unit — a missing one is a malformed answer. */
export type TronChainParams = {
  /** Sun per byte of transaction (burned when no resource covers it). */
  readonly transactionFee: bigint;
  /** Sun per energy unit. */
  readonly energyFee: bigint;
  /** Sun burned for the activation bandwidth when staked bandwidth does not cover it. */
  readonly createAccountFee: bigint;
  /** Sun charged by the system contract for activating an account. */
  readonly createNewAccountFeeInSystemContract: bigint;
  /** Sun cap on a TriggerSmartContract's `fee_limit`. */
  readonly maxFeeLimit: bigint;
  /** Staked-bandwidth multiplier for account-activation transactions. */
  readonly createNewAccountBandwidthRate: bigint;
  /** Max size of an activation transaction minus `ret` and signatures. */
  readonly maxCreateAccountTxSize: bigint;
  /** Flat sun a non-empty `raw_data.data` memo costs each contract owner. */
  readonly memoFee: bigint;
};

/** The chain's fee parameters; a missing or valueless parameter is a malformed answer. */
export const chainParams = async (api: TronApi): Promise<TronChainParams> => {
  const path = "/wallet/getchainparameters";
  const body = parsed(tronChainParameters, path, await api.post(path, {}));
  // proto3 emits a zero-valued parameter without `value`: key present = 0, key absent = missing.
  const values = new Map<string, number | bigint>();
  for (const entry of body.chainParameter) {
    values.set(entry.key, entry.value ?? 0);
  }
  const take = (key: string): bigint => {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(`${path}: missing ${key}`);
    }
    return BigInt(value);
  };
  return {
    transactionFee: take("getTransactionFee"),
    energyFee: take("getEnergyFee"),
    createAccountFee: take("getCreateAccountFee"),
    createNewAccountFeeInSystemContract: take("getCreateNewAccountFeeInSystemContract"),
    maxFeeLimit: take("getMaxFeeLimit"),
    createNewAccountBandwidthRate: take("getCreateNewAccountBandwidthRate"),
    maxCreateAccountTxSize: take("getMaxCreateAccountTxSize"),
    memoFee: take("getMemoFee"),
  };
};

/** The governance parameters the stake rules need; separate so the send path stays lean. */
export type TronStakeParams = {
  /** `getMaxDelegateLockPeriod` — the largest lock period `delegate` may ask for, in blocks. */
  readonly maxDelegateLockPeriod: bigint;
  /** `getWitnessAllowanceFrozenTime` — days between `claim-rewards` calls. */
  readonly witnessAllowanceFrozenTime: bigint;
};

/** The stake-rule chain parameters — a missing one is a malformed answer, never a default. */
export const stakeParams = async (api: TronApi): Promise<TronStakeParams> => {
  const path = "/wallet/getchainparameters";
  const body = parsed(tronChainParameters, path, await api.post(path, {}));
  // proto3 emits a zero-valued parameter without `value`: key present = 0, key absent = missing.
  const values = new Map<string, number | bigint>();
  for (const entry of body.chainParameter) {
    values.set(entry.key, entry.value ?? 0);
  }
  const take = (key: string): bigint => {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(`${path}: missing ${key}`);
    }
    return BigInt(value);
  };
  return {
    maxDelegateLockPeriod: take("getMaxDelegateLockPeriod"),
    witnessAllowanceFrozenTime: take("getWitnessAllowanceFrozenTime"),
  };
};

/** `getavailableunfreezecount` — `{}` means zero concurrent unfreezes are available. */
export const unfreezeCount = async (api: TronApi, owner: string): Promise<number> => {
  const path = "/wallet/getavailableunfreezecount";
  const body = parsed(
    tronUnfreezeCountResponse,
    path,
    await api.post(path, { owner_address: owner, visible: true }),
  );
  return body.count ?? 0;
};

/** `getcandelegatedmaxsize` — the largest delegation the account may make, in sun. */
export const canDelegateMaxSize = async (
  api: TronApi,
  owner: string,
  resource: 0 | 1,
): Promise<bigint> => {
  const path = "/wallet/getcandelegatedmaxsize";
  const body = parsed(
    tronCanDelegateMaxSizeResponse,
    path,
    await api.post(path, { owner_address: owner, type: resource, visible: true }),
  );
  return BigInt(body.max_size ?? 0);
};

export type TronDelegatedRow = {
  /** Unlocked (or already-expired lock) amount delegated to `to` for `resource`. */
  readonly unlocked: bigint;
  /** Locked amount whose lock has not yet expired for `resource`. */
  readonly locked: bigint;
  /** Latest still-unexpired lock `expire_time` for `resource`, ms — 0 when no lock is live. */
  readonly lockedUntil: number;
};

/** `getdelegatedresourcev2` — the from→to delegation split into unlocked vs still-locked parts. */
export const delegatedResource = async (
  api: TronApi,
  from: string,
  to: string,
  resource: 0 | 1,
  now: number,
): Promise<TronDelegatedRow> => {
  const path = "/wallet/getdelegatedresourcev2";
  const body = parsed(
    tronDelegatedResourceResponse,
    path,
    await api.post(path, { fromAddress: from, toAddress: to, visible: true }),
  );
  let unlocked = 0n;
  let locked = 0n;
  let lockedUntil = 0;
  for (const row of body.delegatedResource ?? []) {
    const amount = BigInt(
      resource === 0
        ? (row.frozen_balance_for_bandwidth ?? 0)
        : (row.frozen_balance_for_energy ?? 0),
    );
    const expires = Math.trunc(
      resource === 0 ? (row.expire_time_for_bandwidth ?? 0) : (row.expire_time_for_energy ?? 0),
    );
    if (expires <= now) {
      unlocked += amount;
    } else {
      locked += amount;
      lockedUntil = Math.max(lockedUntil, expires);
    }
  }
  return { unlocked, locked, lockedUntil };
};

/** `getReward` — sun withdrawable via WithdrawBalanceContract; `{}` means 0. */
export const reward = async (api: TronApi, address: string): Promise<bigint> => {
  const path = "/wallet/getReward";
  const body = parsed(tronRewardResponse, path, await api.post(path, { address, visible: true }));
  return BigInt(body.reward ?? 0);
};

/** `listwitnesses` — witness addresses normalized to the `T…` form. */
export const witnesses = async (api: TronApi): Promise<ReadonlyArray<string>> => {
  const path = "/wallet/listwitnesses";
  const body = parsed(tronWitnessListResponse, path, await api.post(path, {}));
  // `listwitnesses` has no visible flag: the node answers `41…` hex.
  return (body.witnesses ?? [])
    .map((w) =>
      /^41[0-9a-fA-F]{40}$/.test(w.address ?? "") ? w.address : tronLogAddress(w.address),
    )
    .map((a) => (a === undefined ? undefined : tronAddressFromHex(a)))
    .filter((a): a is string => a !== undefined);
};

export type TronCallOutcome =
  | {
      readonly ok: true;
      /** Total energy the call consumed — `energy_used`, already including the penalty. */
      readonly energyUsed: number;
      /** The dynamic-energy penalty inside `energyUsed`. */
      readonly energyPenalty: number;
      /** The first `constant_result` entry as bytes (empty when the call returned none). */
      readonly result: Uint8Array;
      readonly logs: ReadonlyArray<TronLog>;
    }
  | {
      readonly ok: false;
      readonly message: string | undefined;
      /** A reverted call still reports the energy it consumed. */
      readonly energyUsed: number;
      readonly energyPenalty: number;
    };

type ConstantCallBody = z.output<typeof tronConstantCallResponse>;

/** The success member of the `triggerconstantcontract` union — `result.result === true`. */
const isCallSuccess = (
  body: ConstantCallBody,
): body is Extract<ConstantCallBody, { result: { result: true } }> =>
  "result" in body.result && body.result.result === true;

/** `triggerconstantcontract` with locally built calldata — the node's `transaction` is ignored. */
export const constantCall = async (
  api: TronApi,
  call: {
    readonly owner: string;
    readonly contract: string;
    readonly data: Uint8Array;
    readonly callValue?: number;
  },
): Promise<TronCallOutcome> => {
  const path = "/wallet/triggerconstantcontract";
  const body = parsed(
    tronConstantCallResponse,
    path,
    await api.post(path, {
      owner_address: call.owner,
      contract_address: call.contract,
      data: [...call.data].map((b) => b.toString(16).padStart(2, "0")).join(""),
      ...(call.callValue === undefined ? {} : { call_value: call.callValue }),
      visible: true,
    }),
  );
  if (isCallSuccess(body)) {
    const first = body.constant_result?.[0];
    return {
      ok: true,
      energyUsed: body.energy_used ?? 0,
      energyPenalty: body.energy_penalty ?? 0,
      result: first === undefined ? new Uint8Array() : hexBytes(first),
      logs: body.logs ?? [],
    };
  }
  return {
    ok: false,
    message: body.result.message === undefined ? undefined : decodeMessage(body.result.message),
    energyUsed: body.energy_used ?? 0,
    energyPenalty: body.energy_penalty ?? 0,
  };
};

export type TronTransactionInfo = {
  readonly blockNumber: number;
  readonly blockTimestamp: number;
  /** Sun burned; absent on nodes that omit zero-value receipts. */
  readonly fee: number;
  /** The `receipt.result` name when present (`SUCCESS`, `OUT_OF_ENERGY`, …). */
  readonly receiptResult: string | undefined;
  /** Receipt failed (`result` present and not `SUCCESS`) or the top-level `result` is `FAILED`. */
  readonly failed: boolean;
  /** The `resMessage` field decoded — REVERT reasons are hex-encoded UTF-8. */
  readonly resMessage: string | undefined;
  readonly logs: ReadonlyArray<TronLog>;
};

/** The transaction's `info` row, or `undefined` while the node does not know it. */
export const transactionInfo = async (
  api: TronApi,
  id: string,
  solidity: boolean,
): Promise<TronTransactionInfo | undefined> => {
  const path = solidity
    ? "/walletsolidity/gettransactioninfobyid"
    : "/wallet/gettransactioninfobyid";
  const info = parsed(tronTransactionInfoResponse, path, await api.post(path, { value: id }));
  if (!("blockNumber" in info)) {
    return undefined;
  }
  const receiptResult = info.receipt?.result;
  return {
    blockNumber: info.blockNumber,
    blockTimestamp: info.blockTimeStamp,
    fee: info.fee ?? 0,
    receiptResult,
    failed:
      (receiptResult !== undefined && receiptResult !== "SUCCESS") || info.result === "FAILED",
    resMessage: info.resMessage === undefined ? undefined : decodeMessage(info.resMessage),
    logs: info.log ?? [],
  };
};

/** Whether the network knows `id` — in the pool or on chain. */
export const transactionKnown = async (api: TronApi, id: string): Promise<boolean> => {
  const path = "/wallet/gettransactionbyid";
  const tx = parsed(tronTransactionResponse, path, await api.post(path, { value: id }));
  return "txID" in tx && tx.txID === id;
};

/**
 * The `gettransactionbyid` body history cross-checks against indexer claims: the raw bytes (whose
 * sha256 is the txid) plus the node's JSON view of each contract's parameter value.
 */
export const transactionById = async (
  api: TronApi,
  id: string,
): Promise<TronMaybeTransaction | undefined> => {
  const path = "/wallet/gettransactionbyid";
  const tx = parsed(tronTransactionResponse, path, await api.post(path, { value: id }));
  return "txID" in tx && tx.txID === id ? tx : undefined;
};

/** A `broadcasthex` refusal: `code` is the node's `Return.response_code` name. */
export class TronBroadcastError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string | undefined) {
    super(message ?? code ?? "broadcast failed");
    this.name = "TronBroadcastError";
    this.code = code;
  }
}

/** Broadcasts signed transaction hex; resolves the node's txid on `result: true`. */
export const broadcastHex = async (api: TronApi, hex: string): Promise<string> => {
  const path = "/wallet/broadcasthex";
  const body = parsed(tronBroadcastResponse, path, await api.post(path, { transaction: hex }));
  if (!body.result) {
    throw new TronBroadcastError(body.code, body.message);
  }
  if (body.txid === undefined) {
    throw new Error(`malformed ${path} response`);
  }
  return body.txid;
};

/**
 * Codes where the node rejected these exact bytes for good. `DUP_TRANSACTION_ERROR` means the node
 * already holds the id; everything else — including `SERVER_BUSY`, `NO_CONNECTION`,
 * `BLOCK_UNSOLIDIFIED`, `NOT_ENOUGH_EFFECTIVE_CONNECTION`, `OTHER_ERROR`, and any unknown code —
 * says nothing definite, so the transaction stays submitted and tracked.
 */
const TRON_REFUSED_CODES: ReadonlySet<string> = new Set([
  "SIGERROR",
  "CONTRACT_VALIDATE_ERROR",
  "CONTRACT_EXE_ERROR",
  "BANDWITH_ERROR",
  "TAPOS_ERROR",
  "TOO_BIG_TRANSACTION_ERROR",
  "TRANSACTION_EXPIRATION_ERROR",
]);

// The union spells out the transactions layer's BroadcastVerdict; chains cannot import it
// (transactions imports chains). It must stay 'held' | 'refused' | undefined.
export const tronBroadcastVerdict = (error: unknown): "held" | "refused" | undefined => {
  if (!(error instanceof TronBroadcastError)) {
    return undefined;
  }
  if (error.code === "DUP_TRANSACTION_ERROR") {
    return "held";
  }
  return error.code !== undefined && TRON_REFUSED_CODES.has(error.code) ? "refused" : undefined;
};

/** Bytes a single-signature, single-contract transaction occupies for bandwidth accounting. */
const varintLength = (value: number): number => {
  let v = BigInt(value);
  let length = 1;
  while (v >= 0x80n) {
    v /= 128n;
    length += 1;
  }
  return length;
};

export const tronBandwidthBytes = (rawDataLength: number): number =>
  1 + varintLength(rawDataLength) + rawDataLength + 67 + 64;

/**
 * A TriggerSmartContract's `fee_limit`: `min(ceil(E × energyFee × 3 / 2), maxFeeLimit)` — the 50%
 * headroom covers an estimate that lands low. `E × energyFee` over the chain cap can never be paid,
 * so the call is refused before signing.
 */
export const tronFeeLimit = (
  energyUsed: number,
  energyFee: bigint,
  maxFeeLimit: bigint,
): bigint => {
  const cost = BigInt(energyUsed) * energyFee;
  if (cost > maxFeeLimit) {
    throw new ChainError(
      "invalid-request",
      "the contract's energy estimate exceeds the chain's maximum fee limit",
    );
  }
  const headroom = (cost * 3n + 1n) / 2n;
  return headroom < maxFeeLimit ? headroom : maxFeeLimit;
};

/** `max(0, v)` for the bigint resource deltas — `Math.max` cannot mix `number` and `bigint`. */
const nonnegative = (v: bigint): bigint => (v > 0n ? v : 0n);

export type TronFeeQuote = {
  /** Sun the transaction is expected to burn: bandwidth + activation + expected energy. */
  readonly expected: string;
  /** Sun the transaction could burn at most: bandwidth max + activation + `fee_limit`. */
  readonly max: string;
  readonly bandwidth: {
    readonly bytes: number;
    readonly source: "staked" | "free" | "burn" | "activation-staked" | "activation-fee";
    readonly stakedAvailable: bigint;
    readonly freeAvailable: bigint;
    /** Sun the bandwidth is expected to burn. */
    readonly burn: string;
  };
  /** Sun the system contract charges for activating the recipient (absent when not activating). */
  readonly activation?: string;
  readonly energy?: {
    /** `energy_used` — the total estimate, penalty included. */
    readonly used: number;
    /** The dynamic-energy penalty inside `used`. */
    readonly penalty: number;
    /** Staked energy available to the caller. */
    readonly available: bigint;
    /** Sun the caller is expected to burn — the deployer's share only lowers it. */
    readonly burn: string;
    /** Sun the transaction's `fee_limit` is set to. */
    readonly feeLimit: string;
  };
  /** Sun the memo costs (`getMemoFee`); present when `memo` was set. */
  readonly memo?: string;
  readonly warnings: ReadonlyArray<
    "recipient-not-activated" | "token-recipient-empty" | "fee-limit-below-estimate"
  >;
};

/**
 * The fee model, per the java-tron rules: an activation transfer may only spend staked bandwidth at
 * `createNewAccountBandwidthRate` (no free bandwidth) or burn `createAccountFee`, plus the
 * `createNewAccountFeeInSystemContract` charge; an ordinary transaction spends staked bandwidth,
 * then free bandwidth, else burns `bytes × transactionFee`. All-or-nothing at each step — a
 * partially covered byte count burns in full.
 */
export const tronFeeQuote = (input: {
  /** Byte length of the locally built `raw_data`. */
  readonly rawDataLength: number;
  readonly params: TronChainParams;
  readonly resources: TronResources;
  /** A Transfer/TransferAsset whose `to` account does not exist. */
  readonly activates?: boolean;
  /** `energy_used`/`energy_penalty` for a TriggerSmartContract. */
  readonly energy?: { readonly used: number; readonly penalty: number } | undefined;
  /** A TRC-20 recipient whose token balance is zero. */
  readonly tokenRecipientEmpty?: boolean;
  /** The transaction's own `fee_limit` — it replaces the estimate-derived one, whatever it is. */
  readonly feeLimit?: bigint;
  /** The transaction carries a non-empty memo (`raw_data.data`). */
  readonly memo?: boolean;
}): TronFeeQuote => {
  const bytes = tronBandwidthBytes(input.rawDataLength);
  const { params } = input;
  const stakedAvailable = nonnegative(
    BigInt(input.resources.netLimit) - BigInt(input.resources.netUsed),
  );
  const freeAvailable = nonnegative(
    BigInt(input.resources.freeNetLimit) - BigInt(input.resources.freeNetUsed),
  );

  let source: TronFeeQuote["bandwidth"]["source"];
  let bandwidthBurn = 0n;
  let bandwidthMax: bigint;
  let activation = 0n;
  if (input.activates === true) {
    // The node rejects an activation transaction larger than the cap (signature excluded).
    if (BigInt(bytes - 64 - 65) > params.maxCreateAccountTxSize) {
      throw new ChainError(
        "invalid-request",
        "the transaction is too large to activate the recipient",
      );
    }
    if (stakedAvailable >= BigInt(bytes) * params.createNewAccountBandwidthRate) {
      source = "activation-staked";
    } else {
      source = "activation-fee";
      bandwidthBurn = params.createAccountFee;
    }
    bandwidthMax = params.createAccountFee;
    activation = params.createNewAccountFeeInSystemContract;
  } else if (stakedAvailable >= BigInt(bytes)) {
    source = "staked";
    bandwidthMax = BigInt(bytes) * params.transactionFee;
  } else if (freeAvailable >= BigInt(bytes)) {
    source = "free";
    bandwidthMax = BigInt(bytes) * params.transactionFee;
  } else {
    source = "burn";
    bandwidthBurn = BigInt(bytes) * params.transactionFee;
    bandwidthMax = bandwidthBurn;
  }

  let energy: TronFeeQuote["energy"];
  let energyExpected = 0n;
  let energyMax = 0n;
  if (input.energy !== undefined) {
    /* A caller-fixed fee_limit is used as given — the dApp chose it — instead of the
       estimate-derived ceiling (which may also refuse when the estimate beats the chain cap). */
    const feeLimit =
      input.feeLimit ?? tronFeeLimit(input.energy.used, params.energyFee, params.maxFeeLimit);
    const available = nonnegative(
      BigInt(input.resources.energyLimit) - BigInt(input.resources.energyUsed),
    );
    energyExpected = nonnegative(BigInt(input.energy.used) - available) * params.energyFee;
    energyMax = feeLimit;
    energy = {
      used: input.energy.used,
      penalty: input.energy.penalty,
      available,
      burn: energyExpected.toString(),
      feeLimit: feeLimit.toString(),
    };
  }
  const memoFee = input.memo === true ? params.memoFee : 0n;

  return {
    expected: (bandwidthBurn + activation + energyExpected + memoFee).toString(),
    max: (bandwidthMax + activation + energyMax + memoFee).toString(),
    bandwidth: {
      bytes,
      source,
      stakedAvailable,
      freeAvailable,
      burn: bandwidthBurn.toString(),
    },
    ...(input.activates === true ? { activation: activation.toString() } : {}),
    ...(energy === undefined ? {} : { energy }),
    ...(input.memo === true ? { memo: params.memoFee.toString() } : {}),
    warnings: [
      ...(input.activates === true ? (["recipient-not-activated"] as const) : []),
      ...(input.tokenRecipientEmpty === true ? (["token-recipient-empty"] as const) : []),
      ...(input.energy !== undefined &&
      input.feeLimit !== undefined &&
      BigInt(Math.trunc(input.energy.used)) * params.energyFee > input.feeLimit
        ? (["fee-limit-below-estimate"] as const)
        : []),
    ],
  };
};
