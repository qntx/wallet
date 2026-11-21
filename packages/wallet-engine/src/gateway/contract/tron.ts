import * as z from "zod/mini";

import { isTronAddress } from "@qntx/wallet-chains/tron";

import { endpoint } from "./endpoint.ts";

/**
 * The TRON surface: the node's `/wallet` and `/walletsolidity` HTTP API plus the TronGrid
 * `/v1/accounts` indexer paths (display-only history/discovery). Every path is a POST with a JSON
 * body — the gateway translates the indexer calls to TronGrid's GET form. Paths not listed are
 * rejected. Response schemas bound only what the engine reads; the node's `transaction` fields are
 * never declared.
 */

/** A base58 `T…` address (`visible: true` callers always send and receive it). */
const tronAddress = z.string().check(z.refine((value) => isTronAddress(value)));

/** Lowercase hex txid, no `0x`. */
const tronTxId = z.string().check(z.regex(/^[0-9a-f]{64}$/));

/** Contract calldata: even-length lowercase hex, 8 bytes to 10 kB. */
const callData = z.string().check(z.regex(/^([0-9a-f]{2}){4,10000}$/));

/** The node's hard cap on a relayed transaction is 500 KiB — 1,024,000 hex chars. */
const signedTransaction = z.string().check(z.regex(/^([0-9a-f]{2}){1,512000}$/));

const emptyRequest = z.strictObject({});
const accountRequest = z.strictObject({ address: tronAddress, visible: z.literal(true) });
const blockByNumRequest = z.strictObject({
  num: z.int().check(z.nonnegative()),
});
const transactionIdRequest = z.strictObject({ value: tronTxId });
const ownerRequest = z.strictObject({ owner_address: tronAddress, visible: z.literal(true) });
const canDelegateRequest = z.strictObject({
  owner_address: tronAddress,
  type: z.union([z.literal(0), z.literal(1)]),
  visible: z.literal(true),
});
const delegatedResourceRequest = z.strictObject({
  fromAddress: tronAddress,
  toAddress: tronAddress,
  visible: z.literal(true),
});

const triggerRequest = z.strictObject({
  owner_address: tronAddress,
  contract_address: tronAddress,
  data: callData,
  call_value: z.optional(z.int().check(z.nonnegative())),
  visible: z.literal(true),
});

const broadcastRequest = z.strictObject({ transaction: signedTransaction });

export const TRON_INDEXER_LIMIT_MAX = 50;

const indexerPageRequest = z.strictObject({
  address: tronAddress,
  fingerprint: z.optional(z.string().check(z.regex(/^[A-Za-z0-9]{0,1024}$/))),
  limit: z.optional(z.int().check(z.minimum(1), z.maximum(TRON_INDEXER_LIMIT_MAX))),
});
const indexerAccountRequest = z.strictObject({ address: tronAddress });

const tronEmpty = z.strictObject({});

/** A block header: `getblockbynum` of a height past the head answers `{}`, never an error. */
export const tronBlockResponse = z.looseObject({
  blockID: tronTxId,
  block_header: z.looseObject({
    raw_data: z.looseObject({
      number: z.int().check(z.nonnegative()),
      timestamp: z.int().check(z.nonnegative()),
    }),
  }),
});
export const tronMaybeBlockResponse = z.union([tronBlockResponse, tronEmpty]);
export type TronBlock = z.output<typeof tronBlockResponse>;
export type TronMaybeBlock = z.output<typeof tronMaybeBlockResponse>;

const intField = z.number().check(z.int(), z.nonnegative());
/**
 * Account-side int64 amounts (sun balances, TRC-10 totals) can exceed 2^53. `parseTronJson` emits a
 * `bigint` for out-of-range integer literals and a safe `number` otherwise — both are exact.
 */
const amountField = z.union([
  z.number().check(
    z.int(),
    z.nonnegative(),
    z.refine((v) => Number.isSafeInteger(v)),
  ),
  z.bigint().check(z.nonnegative()),
]);

/** `assetV2` rows carry the account's TRC-10 balances: `{key: "<asset id>", value: <amount>}`. */
const trc10Balance = z.looseObject({ key: z.string(), value: amountField });

/** An account row: an absent account answers `{}`. `type === "Contract"` names a contract. */
export const tronAccount = z.looseObject({
  /** Present on every existing account — proto3 omits `balance`/`type` when they are zero. */
  address: z.optional(z.string()),
  balance: z.optional(amountField),
  type: z.optional(z.string()),
  assetV2: z.optional(z.array(trc10Balance)),
  /** Stake V2 rows: `{type?: "ENERGY", amount}` — absent type means BANDWIDTH (proto3 enum 0). */
  frozenV2: z.optional(
    z.array(
      z.looseObject({
        type: z.optional(z.union([z.string(), z.number()])),
        amount: z.optional(amountField),
      }),
    ),
  ),
  /** Pending unfreeze rows: `{type?, unfreeze_amount, unfreeze_expire_time}`. */
  unfrozenV2: z.optional(
    z.array(
      z.looseObject({
        type: z.optional(z.union([z.string(), z.number()])),
        unfreeze_amount: z.optional(amountField),
        unfreeze_expire_time: z.optional(intField),
      }),
    ),
  ),
  /** `vote_address` is the witness's 21-byte hex form. */
  votes: z.optional(
    z.array(z.looseObject({ vote_address: z.optional(z.string()), vote_count: intField })),
  ),
  latest_withdraw_time: z.optional(intField),
  /** Nested resource row: both ENERGY delegation totals live here (bandwidth is top-level). */
  account_resource: z.optional(
    z.looseObject({
      delegated_frozenV2_balance_for_energy: z.optional(amountField),
      acquired_delegated_frozenV2_balance_for_energy: z.optional(amountField),
    }),
  ),
  delegated_frozenV2_balance_for_bandwidth: z.optional(amountField),
  acquired_delegated_frozenV2_balance_for_bandwidth: z.optional(amountField),
});
export const tronAccountResponse = z.union([tronAccount, tronEmpty]);
export type TronAccount = z.output<typeof tronAccount>;
export type TronMaybeAccount = z.output<typeof tronAccountResponse>;

/** Account resources: proto3 omits zero fields, so every counter is optional. */
export const tronAccountResource = z.looseObject({
  freeNetLimit: z.optional(amountField),
  freeNetUsed: z.optional(amountField),
  NetLimit: z.optional(amountField),
  NetUsed: z.optional(amountField),
  EnergyLimit: z.optional(amountField),
  EnergyUsed: z.optional(amountField),
  /** Staked-for-votes power = frozen BANDWIDTH + frozen ENERGY in TRX units. */
  tronPowerLimit: z.optional(amountField),
  tronPowerUsed: z.optional(amountField),
});
export type TronAccountResource = z.output<typeof tronAccountResource>;

export const tronChainParameters = z.looseObject({
  // Signed int64 — sentinel parameters carry -1 (e.g. getRemoveThePowerOfTheGr).
  chainParameter: z.array(
    z.looseObject({
      key: z.string(),
      value: z.optional(
        z.union([
          z.number().check(
            z.int(),
            z.refine((v) => Number.isSafeInteger(v)),
          ),
          z.bigint(),
        ]),
      ),
    }),
  ),
});
export type TronChainParameters = z.output<typeof tronChainParameters>;

/** An event log entry: hex contract address, hex topics, hex data (never `visible`-form). */
export const tronLog = z.looseObject({
  address: z.optional(z.string()),
  topics: z.optional(z.array(z.string())),
  data: z.optional(z.string()),
});
export type TronLog = z.output<typeof tronLog>;

/**
 * `triggerconstantcontract`: a successful constant call (`result.result === true`) or a failure —
 * REVERT and runtime errors answer `result: {code?, message?}` with `message` hex-encoded UTF-8.
 */
export const tronConstantCallResponse = z.union([
  z.looseObject({
    result: z.looseObject({ result: z.literal(true) }),
    energy_used: z.optional(intField),
    energy_penalty: z.optional(intField),
    constant_result: z.optional(z.array(z.string())),
    logs: z.optional(z.array(tronLog)),
  }),
  z.looseObject({
    result: z.looseObject({
      code: z.optional(z.string()),
      message: z.optional(z.string()),
    }),
    energy_used: z.optional(intField),
    energy_penalty: z.optional(intField),
  }),
]);
export type TronConstantCall = z.output<typeof tronConstantCallResponse>;

/** `broadcasthex`: `code` is the `Return.response_code` name; `message` is plain UTF-8 here. */
export const tronBroadcastResponse = z.looseObject({
  result: z.boolean(),
  code: z.optional(z.string()),
  message: z.optional(z.string()),
  txid: z.optional(z.string()),
});
export type TronBroadcast = z.output<typeof tronBroadcastResponse>;

/**
 * A transfer contract's `parameter.value` as the node renders it (`owner_address`/`to_address` are
 * 41-prefixed hex, `asset_name` the TRC-10 id). History cross-checks it against the indexer.
 */
const tronContractValue = z.looseObject({
  owner_address: z.optional(z.string()),
  to_address: z.optional(z.string()),
  amount: z.optional(amountField),
  asset_name: z.optional(z.string()),
});

/** `gettransactionbyid`: an unknown id answers `{}`. `raw_data_hex` lets history pin the body. */
export const tronTransactionResponse = z.union([
  z.looseObject({
    txID: tronTxId,
    block_timestamp: z.optional(intField),
    raw_data_hex: z.optional(z.string()),
    raw_data: z.optional(
      z.looseObject({
        contract: z.array(
          z.looseObject({
            type: z.string(),
            parameter: z.looseObject({ value: tronContractValue }),
          }),
        ),
      }),
    ),
  }),
  tronEmpty,
]);
export type TronMaybeTransaction = z.output<typeof tronTransactionResponse>;

/** `gettransactioninfobyid` (full or solidified): an unknown id answers `{}`. */
export const tronTransactionInfo = z.looseObject({
  id: z.optional(tronTxId),
  blockNumber: intField,
  blockTimeStamp: intField,
  fee: z.optional(intField),
  receipt: z.optional(
    z.looseObject({
      net_usage: z.optional(intField),
      net_fee: z.optional(intField),
      energy_usage_total: z.optional(intField),
      energy_fee: z.optional(intField),
      result: z.optional(z.string()),
    }),
  ),
  result: z.optional(z.string()),
  resMessage: z.optional(z.string()),
  log: z.optional(z.array(tronLog)),
});
export const tronTransactionInfoResponse = z.union([tronTransactionInfo, tronEmpty]);
export type TronMaybeTransactionInfo = z.output<typeof tronTransactionInfoResponse>;

export const tronIndexerPageResponse = z.looseObject({
  success: z.literal(true),
  data: z.array(z.unknown()).check(z.maxLength(TRON_INDEXER_LIMIT_MAX)),
  meta: z.looseObject({ fingerprint: z.optional(z.string()) }),
});
const indexerAccountResponse = z.looseObject({
  success: z.literal(true),
  data: z.array(z.unknown()).check(z.maxLength(1)),
  meta: z.looseObject({ fingerprint: z.optional(z.string()) }),
});
export type TronIndexerPage = z.output<typeof tronIndexerPageResponse>;
export type TronIndexerAccount = z.output<typeof indexerAccountResponse>;

/**
 * One `/v1/accounts/transactions` row — only the fields history reads. Rows that fail this schema
 * are skipped by the stream, never thrown: the indexer is display-only and untrusted.
 */
export const tronIndexerTransaction = z.looseObject({
  txID: tronTxId,
  block_timestamp: intField,
  blockNumber: z.optional(intField),
  raw_data: z.looseObject({
    contract: z.array(
      z.looseObject({
        type: z.string(),
        parameter: z.looseObject({ value: tronContractValue }),
      }),
    ),
  }),
});
export type TronIndexerTransactionRow = z.output<typeof tronIndexerTransaction>;

/** One `/v1/accounts/transactions/trc20` row — same skipped-not-thrown rule as the tx feed. */
export const tronIndexerTrc20 = z.looseObject({
  transaction_id: tronTxId,
  block_timestamp: intField,
  from: z.string(),
  to: z.string(),
  type: z.string(),
  value: z.string(),
  token_info: z.looseObject({
    address: z.optional(z.string()),
    symbol: z.optional(z.string()),
    name: z.optional(z.string()),
    decimals: z.optional(intField),
  }),
});
export type TronIndexerTrc20Row = z.output<typeof tronIndexerTrc20>;

/** `getavailableunfreezecount` — `{count: n}`, or `{}` when none is available. */
export const tronUnfreezeCountResponse = z.looseObject({ count: z.optional(intField) });
export type TronUnfreezeCount = z.output<typeof tronUnfreezeCountResponse>;

/** `getcandelegatedmaxsize` — `{max_size: n}` in sun; `{}` means the account can delegate 0. */
export const tronCanDelegateMaxSizeResponse = z.looseObject({
  max_size: z.optional(amountField),
});
export type TronCanDelegateMaxSize = z.output<typeof tronCanDelegateMaxSizeResponse>;

/** `getdelegatedresourcev2`: the row's lock expiry is per-resource, in ms. */
export const tronDelegatedResourceResponse = z.looseObject({
  delegatedResource: z.optional(
    z.array(
      z.looseObject({
        from: z.optional(z.string()),
        to: z.optional(z.string()),
        frozen_balance_for_bandwidth: z.optional(amountField),
        frozen_balance_for_energy: z.optional(amountField),
        expire_time_for_bandwidth: z.optional(intField),
        expire_time_for_energy: z.optional(intField),
      }),
    ),
  ),
});
export type TronDelegatedResource = z.output<typeof tronDelegatedResourceResponse>;

/** `getReward` — `{reward: sun}`, or `{}` when nothing is withdrawable. */
export const tronRewardResponse = z.looseObject({ reward: z.optional(amountField) });
export type TronReward = z.output<typeof tronRewardResponse>;

/** `listwitnesses`: `address` is the witness's base58 or `41…` hex form. */
/**
 * `getassetissuebyid` — TRC-10 metadata. `name`/`abbr` are hex-encoded strings per the node;
 * `precision` is the TRC-10 decimals.
 */
export const tronAssetIssueResponse = z.looseObject({
  id: z.optional(z.string()),
  name: z.optional(z.string()),
  abbr: z.optional(z.string()),
  precision: z.optional(intField),
});
export type TronAssetIssue = z.output<typeof tronAssetIssueResponse>;

export const tronWitnessListResponse = z.looseObject({
  witnesses: z.optional(z.array(z.looseObject({ address: z.optional(z.string()) }))),
});
export type TronWitnessList = z.output<typeof tronWitnessListResponse>;

type TronPath = {
  readonly request: z.ZodMiniType;
  readonly response: z.ZodMiniType;
};

/** Node API paths forwarded to every provider: path → request schema, response schema. */
export const TRON_NODE_PATHS = {
  "/wallet/getnowblock": { request: emptyRequest, response: tronBlockResponse },
  "/walletsolidity/getnowblock": {
    request: emptyRequest,
    response: tronBlockResponse,
  },
  "/wallet/getblockbynum": {
    request: blockByNumRequest,
    response: tronMaybeBlockResponse,
  },
  "/walletsolidity/getblockbynum": {
    request: blockByNumRequest,
    response: tronMaybeBlockResponse,
  },
  "/wallet/getaccount": { request: accountRequest, response: tronAccountResponse },
  "/wallet/getavailableunfreezecount": {
    request: ownerRequest,
    response: tronUnfreezeCountResponse,
  },
  "/wallet/getcandelegatedmaxsize": {
    request: canDelegateRequest,
    response: tronCanDelegateMaxSizeResponse,
  },
  "/wallet/getdelegatedresourcev2": {
    request: delegatedResourceRequest,
    response: tronDelegatedResourceResponse,
  },
  "/wallet/getReward": { request: accountRequest, response: tronRewardResponse },
  "/wallet/getassetissuebyid": {
    request: z.strictObject({ value: z.int().check(z.nonnegative()) }),
    response: tronAssetIssueResponse,
  },
  "/wallet/listwitnesses": {
    request: emptyRequest,
    response: tronWitnessListResponse,
  },
  "/wallet/getaccountresource": {
    request: accountRequest,
    response: tronAccountResource,
  },
  "/wallet/getchainparameters": {
    request: emptyRequest,
    response: tronChainParameters,
  },
  "/wallet/triggerconstantcontract": {
    request: triggerRequest,
    response: tronConstantCallResponse,
  },
  "/wallet/broadcasthex": {
    request: broadcastRequest,
    response: tronBroadcastResponse,
  },
  "/wallet/gettransactionbyid": {
    request: transactionIdRequest,
    response: tronTransactionResponse,
  },
  "/wallet/gettransactioninfobyid": {
    request: transactionIdRequest,
    response: tronTransactionInfoResponse,
  },
  "/walletsolidity/gettransactioninfobyid": {
    request: transactionIdRequest,
    response: tronTransactionInfoResponse,
  },
} as const satisfies Readonly<Record<string, TronPath>>;

/**
 * Display-only indexer paths — the engine's own names; the gateway translates them to TronGrid GETs
 * and only indexer providers serve them.
 */
export const TRON_INDEXER_PATHS = {
  "/v1/accounts/transactions": {
    request: indexerPageRequest,
    response: tronIndexerPageResponse,
  },
  "/v1/accounts/transactions/trc20": {
    request: indexerPageRequest,
    response: tronIndexerPageResponse,
  },
  "/v1/accounts/account": {
    request: indexerAccountRequest,
    response: indexerAccountResponse,
  },
} as const satisfies Readonly<Record<string, TronPath>>;

export type TronNodePath = keyof typeof TRON_NODE_PATHS;
export type TronIndexerPath = keyof typeof TRON_INDEXER_PATHS;

/** The path that relays a signed transaction — failover could double-broadcast it. */
export const TRON_BROADCAST_PATH: TronNodePath = "/wallet/broadcasthex";

/** The path entry, or `undefined` when `path` is not allow-listed. */
export const tronPathEntry = (path: string): TronPath | undefined =>
  (TRON_NODE_PATHS as Readonly<Record<string, TronPath>>)[path] ??
  (TRON_INDEXER_PATHS as Readonly<Record<string, TronPath>>)[path];

export const tronPathAllowed = (path: string): boolean => tronPathEntry(path) !== undefined;

/** Whether `path` is an indexer path — routed only to the network's indexer providers. */
export const isTronIndexerPath = (path: string): path is TronIndexerPath =>
  (TRON_INDEXER_PATHS as Readonly<Record<string, TronPath>>)[path] !== undefined;

export const tron = endpoint("POST", "/v1/tron/:caip2/*", z.unknown(), z.unknown());

/** The TRON base path for one network; allow-listed node and indexer paths are appended to it. */
export const tronBasePath = (caip2: string): string =>
  tron.path.replace(":caip2", caip2).replace(/\/\*$/, "");
