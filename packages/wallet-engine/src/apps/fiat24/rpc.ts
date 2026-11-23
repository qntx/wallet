/**
 * The viem `Client` the Fiat24 SDK reads Arbitrum One (`eip155:42161`) through: the engine's
 * primary endpoint corroborated by the independent one, under the same rules the engine's own
 * transaction reads follow.
 *
 * A second upstream decides corroboration per call: `independentClient` `available` → every read
 * runs on both endpoints; `not-needed`/`unavailable` → the primary alone. Rules:
 *
 * - Method allow-list of exactly what the SDK 0.1.0 issues (its `viem/actions` imports); anything
 *   else refuses.
 * - `eth_chainId` must answer `0xa4b1` on every queried endpoint.
 * - `eth_blockNumber` returns the LOWER head, so the block the SDK then pins exists on both.
 * - `eth_call`/`eth_getStorageAt`/`eth_getTransactionCount`/`eth_getBlockByNumber` at an explicit hex
 *   block, and `eth_getLogs` over a numeric range: both endpoints must agree — normalised results
 *   are compared and any disagreement fails (a missing block on one side IS a disagreement). A
 *   block read at any other tag refuses (the SDK always pins an explicit block).
 * - `eth_getTransactionCount` at `"pending"`/`"latest"` returns the HIGHER answer — the engine's
 *   nonce rule (`transactions/evm.ts` `prepareSpec`).
 * - `eth_getTransactionReceipt`/`eth_getTransactionByHash`: a null on EITHER endpoint answers null —
 *   conservative, so the SDK's reconcile can never turn a one-sided gap into a false `not-sent`
 *   (`flows/tx.ts` `byNonce` in the SDK); two non-null answers are compared on the binding
 *   projection.
 * - An erroring independent endpoint fails the call (fail closed) — the same rule polymarket's
 *   `locate` follows. The primary's error propagates verbatim: it may carry revert data the SDK
 *   decodes into `contract-revert`.
 * - No batching and no retries: a corroboration failure must never re-fire the read pair.
 *
 * Every error thrown here is a plain `Error` with a fixed message — the SDK maps them to
 * `rpc-error`; params, results and endpoint details never enter a message.
 */
import { createClient, custom } from "viem";
import type { Client } from "viem";
import { arbitrum } from "viem/chains";

import type { AppNetworks } from "../spi.ts";

const NETWORK = "eip155:42161";
/** `numberToHex(42161)` — what every endpoint must answer for `eth_chainId`. */
const ARBITRUM_ONE = "0xa4b1";

type Call = { readonly method: string; readonly params?: unknown };

const MISMATCH = "the rpc endpoints disagree";
const MALFORMED = "the rpc endpoint returned a malformed result";
const UNPINNED = "fiat24 rpc reads must pin an explicit block";
const REFUSED = "fiat24 rpc method not allowed";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Params shaped as an array — `Array.isArray` on `unknown` would narrow to `any[]`. */
const isArgs = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

/** An explicit block quantity — never a named tag. */
const isBlock = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);

const hexBig = (value: unknown): bigint | undefined => (isBlock(value) ? BigInt(value) : undefined);

const quantity = (value: unknown): bigint => {
  const parsed = hexBig(value);
  if (parsed === undefined) {
    throw new Error(MALFORMED);
  }
  return parsed;
};

/** Hex-string fields compare case-insensitively; anything else by identity. */
const fieldEq = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

const sameLog = (a: unknown, b: unknown): boolean => {
  if (!isObject(a) || !isObject(b)) {
    return false;
  }
  const topicsA = a["topics"];
  const topicsB = b["topics"];
  return (
    fieldEq(a["address"], b["address"]) &&
    Array.isArray(topicsA) &&
    Array.isArray(topicsB) &&
    topicsA.length === topicsB.length &&
    topicsA.every((topic, i) => fieldEq(topic, topicsB[i])) &&
    fieldEq(a["data"], b["data"]) &&
    hexBig(a["blockNumber"]) === hexBig(b["blockNumber"]) &&
    fieldEq(a["blockHash"], b["blockHash"]) &&
    fieldEq(a["transactionHash"], b["transactionHash"]) &&
    hexBig(a["logIndex"]) === hexBig(b["logIndex"]) &&
    a["removed"] === b["removed"]
  );
};

const sameLogs = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((log, i) => sameLog(log, b[i]));

const RECEIPT_FIELDS = [
  "transactionHash",
  "blockHash",
  "blockNumber",
  "status",
  "from",
  "to",
] as const;

/** A receipt compares on the binding projection plus its normalised logs. */
const sameReceipt = (a: unknown, b: unknown): boolean =>
  isObject(a) &&
  isObject(b) &&
  RECEIPT_FIELDS.every((name) =>
    name === "blockNumber" ? hexBig(a[name]) === hexBig(b[name]) : fieldEq(a[name], b[name]),
  ) &&
  sameLogs(a["logs"], b["logs"]);

const TX_QUANTITY_FIELDS = ["nonce", "value", "blockNumber"] as const;
const TX_HEX_FIELDS = ["hash", "from", "to", "input", "blockHash"] as const;

const sameTransaction = (a: unknown, b: unknown): boolean =>
  isObject(a) &&
  isObject(b) &&
  TX_QUANTITY_FIELDS.every((name) => hexBig(a[name]) === hexBig(b[name])) &&
  TX_HEX_FIELDS.every((name) => fieldEq(a[name], b[name]));

const sameBlock = (a: unknown, b: unknown): boolean =>
  isObject(a) &&
  isObject(b) &&
  fieldEq(a["hash"], b["hash"]) &&
  hexBig(a["number"]) === hexBig(b["number"]) &&
  hexBig(a["timestamp"]) === hexBig(b["timestamp"]);

const SECOND_FAILED: unique symbol = Symbol("independent-failed");

/** `other` is set exactly when a second upstream corroborated the read. */
type Answers = {
  readonly result: unknown;
  readonly other: { readonly value: unknown } | undefined;
};

/**
 * `createFiat24Client` — the cross-checked Arbitrum One client handed to every SDK read. The
 * primary is `networks.client(NETWORK)`; `networks.independentClient(NETWORK)` is resolved per
 * request so a mid-session endpoint change takes effect on the next read.
 */
export function createFiat24Client(networks: AppNetworks): Client {
  const primary = networks.client(NETWORK);

  /** Both endpoints, or the primary alone; an independent failure fails closed. */
  const both = async (call: Call): Promise<Answers> => {
    const independent = networks.independentClient(NETWORK);
    if (independent.kind !== "available") {
      return { result: await primary.transport.request(call), other: undefined };
    }
    /* Both fire together; the primary's failure propagates verbatim (its revert data reaches the
       SDK's decoder) while a corroborator failure fails the whole call closed. */
    const corroborate = async (): Promise<unknown> => {
      try {
        return await independent.client.transport.request(call);
      } catch {
        return SECOND_FAILED;
      }
    };
    const pending = corroborate();
    const result = await primary.transport.request(call);
    const other = await pending;
    if (other === SECOND_FAILED) {
      throw new Error("the second rpc endpoint failed");
    }
    return { result, other: { value: other } };
  };

  /** One answer corroborated byte-exact (hex compare is case-insensitive). */
  const equal = async (call: Call): Promise<unknown> => {
    const { result, other } = await both(call);
    if (other !== undefined && !fieldEq(result, other.value)) {
      throw new Error(MISMATCH);
    }
    return result;
  };

  const chainId = async (call: Call): Promise<unknown> => {
    const { result, other } = await both(call);
    if (
      !fieldEq(result, ARBITRUM_ONE) ||
      (other !== undefined && !fieldEq(other.value, ARBITRUM_ONE))
    ) {
      throw new Error("the rpc endpoint answered a different chain");
    }
    return result;
  };

  const blockNumber = async (call: Call): Promise<unknown> => {
    const { result, other } = await both(call);
    if (other === undefined) {
      return result;
    }
    return quantity(result) <= quantity(other.value) ? result : other.value;
  };

  const transactionCount = async (call: Call, tag: unknown): Promise<unknown> => {
    if (tag === "pending" || tag === "latest") {
      const { result, other } = await both(call);
      if (other === undefined) {
        return result;
      }
      return quantity(result) >= quantity(other.value) ? result : other.value;
    }
    if (!isBlock(tag)) {
      throw new Error(UNPINNED);
    }
    const { result, other } = await both(call);
    if (other !== undefined && hexBig(result) !== hexBig(other.value)) {
      throw new Error(MISMATCH);
    }
    return result;
  };

  const logs = async (call: Call): Promise<unknown> => {
    const { result, other } = await both(call);
    if (!Array.isArray(result)) {
      throw new TypeError(MALFORMED);
    }
    if (other !== undefined && !sameLogs(result, other.value)) {
      throw new Error(MISMATCH);
    }
    return result;
  };

  /** A block both endpoints must serve identically: one side missing it is a disagreement. */
  const block = async (call: Call): Promise<unknown> => {
    const { result, other } = await both(call);
    if (other === undefined) {
      return result;
    }
    if (result === null || other.value === null || !sameBlock(result, other.value)) {
      throw new Error(MISMATCH);
    }
    return result;
  };

  /** A null on either side answers null — never a false absence on the reconcile path. */
  const nullable = async (
    call: Call,
    same: (a: unknown, b: unknown) => boolean,
  ): Promise<unknown> => {
    const { result, other } = await both(call);
    if (other === undefined) {
      return result;
    }
    if (result === null || other.value === null) {
      return null;
    }
    if (!same(result, other.value)) {
      throw new Error(MISMATCH);
    }
    return result;
  };

  const request = async ({ method, params }: Call): Promise<unknown> => {
    const call = { method, params };
    const args = isArgs(params) ? params : [];
    switch (method) {
      case "eth_chainId":
        return chainId(call);
      case "eth_blockNumber":
        return blockNumber(call);
      case "eth_call":
        if (!isBlock(args[1])) {
          throw new Error(UNPINNED);
        }
        return equal(call);
      case "eth_getStorageAt":
        if (!isBlock(args[2])) {
          throw new Error(UNPINNED);
        }
        return equal(call);
      case "eth_getTransactionCount":
        return transactionCount(call, args[1]);
      case "eth_getBlockByNumber":
        if (!isBlock(args[0])) {
          throw new Error(UNPINNED);
        }
        return block(call);
      case "eth_getLogs": {
        const [filter] = args;
        if (!isObject(filter) || !isBlock(filter["fromBlock"]) || !isBlock(filter["toBlock"])) {
          throw new Error(UNPINNED);
        }
        return logs(call);
      }
      case "eth_getTransactionReceipt":
        return nullable(call, sameReceipt);
      case "eth_getTransactionByHash":
        return nullable(call, sameTransaction);
      default:
        throw new Error(REFUSED);
    }
  };

  /* `ccipRead: false`: a revert during an `eth_call` must reach the SDK's decoder, never
     dereference an OffchainLookup pointer through the ambient fetch. `retryCount: 0` keeps a
     failed corroboration from re-firing the read pair. */
  return createClient({
    chain: arbitrum,
    transport: custom({ request }, { retryCount: 0 }),
    ccipRead: false,
  });
}
