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
  TronNodePath,
} from "../gateway/contract/index.ts";

/** TRON HTTP client: POSTs an allow-listed path to each endpoint in order. */
export type TronApi = {
  readonly post: (path: TronNodePath | TronIndexerPath, body: unknown) => Promise<unknown>;
};

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
        const res = await fetchFn(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          last = new Error(`${path}: HTTP ${res.status} from ${url}`);
          continue;
        }
        let parsed: unknown;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- failover is ordered and sequential
          parsed = await res.json();
        } catch {
          last = new Error(`${path}: non-JSON response from ${url}`);
          continue;
        }
        if (parsed === null || typeof parsed !== "object") {
          last = new Error(`${path}: malformed response from ${url}`);
          continue;
        }
        return parsed;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(path);
  },
});

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

/** A node's hex `message`/`resMessage` field as UTF-8 when it is printable text, else hex. */
const decodeMessage = (hex: string): string => {
  const bytes = hexBytes(hex);
  try {
    const text = utf8.decode(bytes);
    return printable.test(text) ? text : hex;
  } catch {
    return hex;
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
  readonly freeNetLimit: number;
  readonly freeNetUsed: number;
  readonly netLimit: number;
  readonly netUsed: number;
  readonly energyLimit: number;
  readonly energyUsed: number;
  /** TRX staked for either resource — the vote power bound and the used fraction. */
  readonly tronPowerLimit: number;
  readonly tronPowerUsed: number;
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
};

/** The chain's fee parameters; a missing or valueless parameter is a malformed answer. */
export const chainParams = async (api: TronApi): Promise<TronChainParams> => {
  const path = "/wallet/getchainparameters";
  const body = parsed(tronChainParameters, path, await api.post(path, {}));
  const values = new Map<string, number>();
  for (const entry of body.chainParameter) {
    if (entry.value !== undefined) {
      values.set(entry.key, entry.value);
    }
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
  const values = new Map<string, number>();
  for (const entry of body.chainParameter) {
    if (entry.value !== undefined) {
      values.set(entry.key, entry.value);
    }
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
  return BigInt(Math.trunc(body.max_size ?? 0));
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
      Math.trunc(
        resource === 0
          ? (row.frozen_balance_for_bandwidth ?? 0)
          : (row.frozen_balance_for_energy ?? 0),
      ),
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
  return BigInt(Math.trunc(body.reward ?? 0));
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
  | { readonly ok: false; readonly message: string | undefined };

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

export type TronFeeQuote = {
  /** Sun the transaction is expected to burn: bandwidth + activation + expected energy. */
  readonly expected: string;
  /** Sun the transaction could burn at most: bandwidth max + activation + `fee_limit`. */
  readonly max: string;
  readonly bandwidth: {
    readonly bytes: number;
    readonly source: "staked" | "free" | "burn" | "activation-staked" | "activation-fee";
    readonly stakedAvailable: number;
    readonly freeAvailable: number;
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
    readonly available: number;
    /** Sun the caller is expected to burn — the deployer's share only lowers it. */
    readonly burn: string;
    /** Sun the transaction's `fee_limit` is set to. */
    readonly feeLimit: string;
  };
  readonly warnings: ReadonlyArray<"recipient-not-activated" | "token-recipient-empty">;
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
}): TronFeeQuote => {
  const bytes = tronBandwidthBytes(input.rawDataLength);
  const { params } = input;
  const stakedAvailable = Math.max(0, input.resources.netLimit - input.resources.netUsed);
  const freeAvailable = Math.max(0, input.resources.freeNetLimit - input.resources.freeNetUsed);

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
    if (BigInt(stakedAvailable) >= BigInt(bytes) * params.createNewAccountBandwidthRate) {
      source = "activation-staked";
    } else {
      source = "activation-fee";
      bandwidthBurn = params.createAccountFee;
    }
    bandwidthMax = params.createAccountFee;
    activation = params.createNewAccountFeeInSystemContract;
  } else if (stakedAvailable >= bytes) {
    source = "staked";
    bandwidthMax = BigInt(bytes) * params.transactionFee;
  } else if (freeAvailable >= bytes) {
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
    const feeLimit = tronFeeLimit(input.energy.used, params.energyFee, params.maxFeeLimit);
    const available = Math.max(0, input.resources.energyLimit - input.resources.energyUsed);
    energyExpected = BigInt(Math.max(0, input.energy.used - available)) * params.energyFee;
    energyMax = feeLimit;
    energy = {
      used: input.energy.used,
      penalty: input.energy.penalty,
      available,
      burn: energyExpected.toString(),
      feeLimit: feeLimit.toString(),
    };
  }

  return {
    expected: (bandwidthBurn + activation + energyExpected).toString(),
    max: (bandwidthMax + activation + energyMax).toString(),
    bandwidth: {
      bytes,
      source,
      stakedAvailable,
      freeAvailable,
      burn: bandwidthBurn.toString(),
    },
    ...(input.activates === true ? { activation: activation.toString() } : {}),
    ...(energy === undefined ? {} : { energy }),
    warnings: [
      ...(input.activates === true ? (["recipient-not-activated"] as const) : []),
      ...(input.tokenRecipientEmpty === true ? (["token-recipient-empty"] as const) : []),
    ],
  };
};
