import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

/** Entries the client may ask for per direction and page. */
export const HISTORY_PAGE_MAX = 50;
/** Response cap: a drained block can legitimately exceed the requested limit. */
export const HISTORY_ITEMS_MAX = 500;
/** Transfers kept per transaction. */
export const HISTORY_TRANSFERS_MAX = 100;

const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
const hash32 = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/));
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** A non-negative integer in decimal — no leading zeros, floats, signs or hex. */
const decimal = z.string().check(z.regex(DECIMAL));
/**
 * The highest block bound the upstream verifiably accepts (int64 max): Alchemy rejects a `toBlock`
 * of 2^64 or more with a 400, so the contract refuses it before any upstream call.
 */
export const HISTORY_CURSOR_MAX: bigint = 2n ** 63n - 1n;
/** An inclusive upper block bound, decimal, at most {@link HISTORY_CURSOR_MAX}. */
const blockNumber = z
  .string()
  .check(z.refine((value) => DECIMAL.test(value) && BigInt(value) <= HISTORY_CURSOR_MAX));

export const historyRequest = z.strictObject({
  // The address is in the body, never the URL: address-bearing routes are POST.
  address: evmAddress,
  cursor: z.optional(blockNumber),
  limit: z.optional(z.int().check(z.minimum(1), z.maximum(HISTORY_PAGE_MAX))),
});

export const historyTransfer = z.strictObject({
  kind: z.enum(["native", "internal", "erc20", "erc721", "erc1155"]),
  from: evmAddress,
  to: z.union([evmAddress, z.null()]),
  /** Null for native/internal transfers. */
  contract: z.union([evmAddress, z.null()]),
  /** Erc721/erc1155 only. */
  tokenId: z.union([decimal, z.null()]),
  /** Base units; erc721 carries "1". */
  amount: decimal,
  decimals: z.union([z.int().check(z.minimum(0), z.maximum(255)), z.null()]),
  /** Display only, untrusted. */
  symbol: z.union([z.string().check(z.maxLength(32)), z.null()]),
  /** The receipt log that records the transfer; null for native/internal. */
  logIndex: z.union([z.int().check(z.minimum(0)), z.null()]),
});

export const historyItem = z.strictObject({
  hash: hash32,
  block: decimal,
  /** Milliseconds since the epoch. */
  timestamp: z.int().check(z.minimum(0)),
  transfers: z.array(historyTransfer).check(z.minLength(1), z.maxLength(HISTORY_TRANSFERS_MAX)),
});

export const historyResponse = z.strictObject({
  items: z.array(historyItem).check(z.maxLength(HISTORY_ITEMS_MAX)),
  /** Null: there is no older page. */
  cursor: z.union([decimal, z.null()]),
  /**
   * True when the gateway left out transfers in the range this page covers — a block or a
   * transaction with more transfers than one page can carry. The cursor still moves past them (they
   * cannot be paged), so the list has a gap there.
   */
  truncated: z.boolean(),
});

export const history = endpoint("POST", "/v1/history/:caip2", historyRequest, historyResponse);

/** The history path for one network. */
export const historyPath = (caip2: string): string => history.path.replace(":caip2", caip2);

export type HistoryRequest = z.infer<typeof historyRequest>;
export type HistoryResponse = z.infer<typeof historyResponse>;
export type HistoryItem = z.infer<typeof historyItem>;
export type HistoryTransfer = z.infer<typeof historyTransfer>;
