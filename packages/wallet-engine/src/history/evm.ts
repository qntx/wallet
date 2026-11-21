import { decodeEventLog, erc20Abi, erc721Abi, erc1155Abi } from "viem";
import type { Hex, PublicClient } from "viem";
import * as z from "zod/mini";

import { checksumEvmAddress, evmTokenTable, lookupEvmToken } from "@qntx/wallet-chains/evm";

import { historyPath, historyResponse, parseWith } from "../gateway/contract/index.ts";
import type { HistoryItem, HistoryTransfer } from "../gateway/contract/index.ts";
import type { NetworkController } from "../networks/controller.ts";
import { networkById } from "../networks/registry.ts";
import { timeoutSignal } from "../timer.ts";
import type { SetTimer } from "../timer.ts";
import { tokenFlags } from "./flags.ts";
import type { Stream } from "./merge.ts";
import type { HistoryChange, HistoryEntry, HistoryFlag } from "./types.ts";

const PAGE_LIMIT = 25;
const REQUEST_TIMEOUT_MS = 10_000;
const VERIFY_CONCURRENCY = 4;

type Networks = Pick<NetworkController, "client" | "independentClient">;

export type EvmHistoryDeps = {
  readonly gateway: { readonly url: string; readonly fetch: typeof globalThis.fetch };
  readonly networks: Networks;
  readonly setTimer: SetTimer;
};

const quantity = z.string().check(z.regex(/^0x[0-9a-fA-F]{1,64}$/));

const receiptSchema = z.looseObject({
  blockNumber: quantity,
  status: z.optional(z.union([quantity, z.null()])),
  from: z.string(),
  to: z.union([z.string(), z.null()]),
  gasUsed: quantity,
  effectiveGasPrice: quantity,
  l1Fee: z.optional(z.union([quantity, z.null()])),
  logs: z.array(
    z.looseObject({
      address: z.string(),
      topics: z.array(z.string()),
      data: z.string(),
      logIndex: z.optional(z.union([quantity, z.null()])),
    }),
  ),
});

const txSchema = z.looseObject({
  from: z.string(),
  to: z.union([z.string(), z.null()]),
  value: quantity,
});

type Receipt = z.output<typeof receiptSchema>;
type Log = Receipt["logs"][number];
type Tx = z.output<typeof txSchema>;

const sameAddress = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase());

const isHex = (v: string): v is Hex => /^0x[0-9a-fA-F]*$/.test(v);

const directionOf = (changes: ReadonlyArray<HistoryChange>): HistoryEntry["direction"] => {
  const ins = changes.some((c) => c.direction === "in");
  const outs = changes.some((c) => c.direction === "out");
  if (ins && outs) {
    return "mixed";
  }
  if (ins) {
    return "in";
  }
  return outs ? "out" : "self";
};

/**
 * The group's view of one provider item: changes for transfers touching the address (a
 * self-transfer nets to nothing), counterparties the other side, intrinsic flags. `verified` is
 * false until a chain read confirms it — the provider claim alone proves nothing.
 */
export const evmHistoryEntry = (
  chainId: number,
  networkSymbol: string,
  networkDecimals: number,
  address: string,
  network: string,
  item: HistoryItem,
): HistoryEntry => {
  const changes: HistoryChange[] = [];
  const counterparties = new Set<string>();
  const flags = new Set<HistoryFlag>();
  for (const t of item.transfers) {
    const fromOwn = sameAddress(t.from, address);
    const toOwn = sameAddress(t.to, address);
    if (!fromOwn && !toOwn) {
      continue;
    }
    if (fromOwn && !toOwn && t.to !== null) {
      counterparties.add(t.to);
    }
    if (toOwn && !fromOwn) {
      counterparties.add(t.from);
    }
    if (fromOwn === toOwn) {
      continue;
    }
    const native = t.kind === "native" || t.kind === "internal";
    if (!native && t.contract === null) {
      // A token-kind claim without its contract: nothing to show or check.
      continue;
    }
    const builtIn =
      native || t.contract === null
        ? undefined
        : lookupEvmToken(evmTokenTable, chainId, t.contract);
    const symbol = native ? networkSymbol : (builtIn?.symbol ?? t.symbol ?? undefined);
    const decimals = native ? networkDecimals : (builtIn?.decimals ?? t.decimals ?? undefined);
    const change: HistoryChange = {
      direction: toOwn ? "in" : "out",
      asset: native ? "native" : checksumEvmAddress(t.contract ?? ""),
      amount: t.amount,
      ...(decimals === undefined ? {} : { decimals }),
      ...(symbol === undefined ? {} : { symbol }),
      ...(t.tokenId === null ? {} : { tokenId: t.tokenId }),
      listed: native || builtIn !== undefined,
    };
    if (change.amount === "0") {
      flags.add("zero-value-transfer");
    }
    if (!native && t.contract !== null) {
      for (const flag of tokenFlags(chainId, t.contract, symbol)) {
        flags.add(flag);
      }
    }
    changes.push(change);
  }
  return {
    id: `${network}:${item.hash}`,
    family: "evm",
    network,
    hash: item.hash,
    direction: directionOf(changes),
    counterparties: [...counterparties].slice(0, 100),
    changes: changes.slice(0, 100),
    status: "confirmed",
    timestamp: item.timestamp,
    block: Number(item.block),
    verified: false,
    origin: "provider",
    flags: [...flags],
  };
};

/** A contradiction between the provider claim and the chain: `chain-mismatch`, unverified. */
const MISMATCH = { match: false, checkable: true } as const;
/** The ledger cannot answer for this transfer (internal, or no pinned log) — never a mismatch. */
const UNCHECKABLE = { match: true, checkable: false } as const;
const MATCH = { match: true, checkable: true } as const;

const nativeCheck = (tx: Tx | undefined, t: HistoryTransfer): boolean =>
  tx !== undefined &&
  sameAddress(tx.from, t.from) &&
  sameAddress(tx.to, t.to) &&
  BigInt(tx.value) === BigInt(t.amount);

const logAt = (receipt: Receipt, t: HistoryTransfer): Log | undefined =>
  t.logIndex === null
    ? undefined
    : receipt.logs.find(
        (log) =>
          log.logIndex !== undefined &&
          log.logIndex !== null &&
          BigInt(log.logIndex) === BigInt(t.logIndex ?? 0),
      );

const decode = (
  abi: typeof erc20Abi | typeof erc721Abi | typeof erc1155Abi,
  log: Log,
): { eventName: string; args: Record<string, unknown> } | undefined => {
  const topics = log.topics.filter(isHex);
  if (topics.length === 0 || !isHex(log.data)) {
    return undefined;
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the filter above guarantees 0x-hex topics; the tuple element type is opaque to `filter`
    return decodeEventLog({ abi, data: log.data, topics: topics as [Hex, ...Hex[]] });
  } catch {
    return undefined;
  }
};

const erc20Check = (log: Log | undefined, t: HistoryTransfer): boolean => {
  if (log === undefined || !sameAddress(log.address, t.contract)) {
    return false;
  }
  const event = decode(erc20Abi, log);
  return (
    event?.eventName === "Transfer" &&
    sameAddress(event.args["from"], t.from) &&
    sameAddress(event.args["to"], t.to) &&
    event.args["value"] === BigInt(t.amount)
  );
};

const erc721Check = (log: Log | undefined, t: HistoryTransfer): boolean => {
  if (log === undefined || !sameAddress(log.address, t.contract)) {
    return false;
  }
  const event = decode(erc721Abi, log);
  return (
    event?.eventName === "Transfer" &&
    sameAddress(event.args["from"], t.from) &&
    sameAddress(event.args["to"], t.to) &&
    t.tokenId !== null &&
    event.args["tokenId"] === BigInt(t.tokenId)
  );
};

const erc1155Check = (log: Log | undefined, t: HistoryTransfer): boolean => {
  if (log === undefined || !sameAddress(log.address, t.contract) || t.tokenId === null) {
    return false;
  }
  const event = decode(erc1155Abi, log);
  const tokenId = BigInt(t.tokenId);
  const amount = BigInt(t.amount);
  if (event?.eventName === "TransferSingle") {
    return (
      sameAddress(event.args["from"], t.from) &&
      sameAddress(event.args["to"], t.to) &&
      event.args["id"] === tokenId &&
      event.args["value"] === amount
    );
  }
  if (event?.eventName === "TransferBatch") {
    const { ids } = event.args;
    const { values } = event.args;
    const index = Array.isArray(ids) ? ids.indexOf(tokenId) : -1;
    return (
      index >= 0 &&
      sameAddress(event.args["from"], t.from) &&
      sameAddress(event.args["to"], t.to) &&
      Array.isArray(values) &&
      values[index] === amount
    );
  }
  return false;
};

type Check = { readonly match: boolean; readonly checkable: boolean };

const transferCheck = (receipt: Receipt, tx: Tx | undefined, t: HistoryTransfer): Check => {
  if (t.kind === "internal") {
    // Internal value moves leave no receipt log — the provider claim stands unproven.
    return UNCHECKABLE;
  }
  if (t.kind === "native") {
    // No tx object means the native leg cannot be proven either way — unverifiable, not a lie.
    if (tx === undefined) {
      return UNCHECKABLE;
    }
    return nativeCheck(tx, t) ? MATCH : MISMATCH;
  }
  if (t.contract === null || t.logIndex === null) {
    return UNCHECKABLE;
  }
  const log = logAt(receipt, t);
  const check = t.kind === "erc20" ? erc20Check : t.kind === "erc721" ? erc721Check : erc1155Check;
  return check(log, t) ? MATCH : MISMATCH;
};

/** A raw JSON-RPC call on the client transport; the result is schema-checked by the caller. */
const requestJson = async (
  client: PublicClient,
  method: string,
  params: ReadonlyArray<string>,
): Promise<unknown> => client.transport.request({ method, params: [...params] });

/** `run` over `items`, at most `n` in flight, order preserved. */
const mapPool = async <T, R>(items: ReadonlyArray<T>, n: number, run: (t: T) => Promise<R>) => {
  const out: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cursor bounds it: current < items.length
        const item = items[current] as T;
        // oxlint-disable-next-line eslint/no-await-in-loop -- the shared cursor serializes each worker's steps.
        out[current] = await run(item);
      }
    }),
  );
  return out;
};

/**
 * One wallet-touching movement the chain proves: a token leg pinned to its log index (plus the
 * token id inside an ERC-1155 batch), or the tx's native value leg.
 */
type OwnMove =
  | { readonly kind: "erc20" | "erc721"; readonly logIndex: bigint }
  | { readonly kind: "erc1155"; readonly logIndex: bigint; readonly tokenId: bigint }
  | { readonly kind: "native" };

/**
 * Every movement that touched the wallet in this transaction, decoded from the receipt's logs and
 * the tx's native value — the completeness oracle the provider's transfer list is checked against.
 * `provable` is false when the tx object did not arrive or a log carries no pinned index, in which
 * case a movement could be hiding and the entry must not be called verified.
 */
const ownMovements = (
  receipt: Receipt,
  tx: Tx | undefined,
  address: string,
): { readonly moves: ReadonlyArray<OwnMove>; readonly provable: boolean } => {
  const moves: OwnMove[] = [];
  let provable = tx !== undefined;
  const touches = (from: unknown, to: unknown): boolean =>
    sameAddress(from, address) !== sameAddress(to, address);
  for (const log of receipt.logs) {
    if (log.logIndex === undefined || log.logIndex === null) {
      provable = false;
      continue;
    }
    const logIndex = BigInt(log.logIndex);
    if (log.topics.length === 3) {
      const event = decode(erc20Abi, log);
      if (event?.eventName === "Transfer" && touches(event.args["from"], event.args["to"])) {
        moves.push({ kind: "erc20", logIndex });
      }
      continue;
    }
    if (log.topics.length !== 4) {
      continue;
    }
    const multi = decode(erc1155Abi, log);
    if (multi?.eventName === "TransferSingle" && touches(multi.args["from"], multi.args["to"])) {
      const tokenId = multi.args["id"];
      if (typeof tokenId === "bigint") {
        moves.push({ kind: "erc1155", logIndex, tokenId });
      } else {
        provable = false;
      }
      continue;
    }
    if (multi?.eventName === "TransferBatch" && touches(multi.args["from"], multi.args["to"])) {
      const tokenIds = multi.args["ids"];
      if (Array.isArray(tokenIds) && tokenIds.every((id): id is bigint => typeof id === "bigint")) {
        for (const tokenId of tokenIds) {
          moves.push({ kind: "erc1155", logIndex, tokenId });
        }
      } else {
        provable = false;
      }
      continue;
    }
    const event = decode(erc721Abi, log);
    if (event?.eventName === "Transfer" && touches(event.args["from"], event.args["to"])) {
      moves.push({ kind: "erc721", logIndex });
    }
  }
  if (
    tx !== undefined &&
    receipt.status !== "0x0" &&
    BigInt(tx.value) > 0n &&
    touches(tx.from, tx.to)
  ) {
    moves.push({ kind: "native" });
  }
  return { moves, provable };
};

/**
 * Whether the provider's transfer list accounts for `move`: same kind pinned at the same log index
 * (plus the same token id inside an ERC-1155 batch), or a native claim matching the tx's legs.
 */
const claimedMove = (
  move: OwnMove,
  transfers: ReadonlyArray<HistoryTransfer>,
  tx: Tx | undefined,
): boolean =>
  transfers.some((t) => {
    if (move.kind === "native") {
      return (
        t.kind === "native" &&
        tx !== undefined &&
        sameAddress(t.from, tx.from) &&
        sameAddress(t.to, tx.to)
      );
    }
    if (t.kind !== move.kind || t.logIndex === null || BigInt(t.logIndex) !== move.logIndex) {
      return false;
    }
    return move.kind !== "erc1155" || (t.tokenId !== null && BigInt(t.tokenId) === move.tokenId);
  });

/**
 * Verifies the provider's claims against the chain: each claimed transfer is matched to its pinned
 * receipt log or to the tx's native movement, and every wallet-touching movement the chain proves
 * must in turn be claimed — an omitted leg is `chain-mismatch`. A failed tx fetch, an unpinned log,
 * or an uncheckable claim (internal legs or missing data) leaves the entry unverified; `trusted` is
 * the caller's evidence that the reads went to a host endpoint.
 */
const verifyEntry = async (
  client: PublicClient,
  address: string,
  entry: HistoryEntry,
  item: HistoryItem,
  trusted: boolean,
): Promise<HistoryEntry> => {
  let parsed: unknown;
  try {
    parsed = await requestJson(client, "eth_getTransactionReceipt", [item.hash]);
  } catch {
    return entry;
  }
  const receipt = parseWith(receiptSchema, parsed);
  if (receipt === undefined) {
    // No receipt yet (or a malformed answer): the provider claim stands, unconfirmed by the chain.
    return entry;
  }
  const flags = new Set(entry.flags);
  const mismatch = (): HistoryEntry => ({
    ...entry,
    verified: false,
    flags: [...flags.add("chain-mismatch")],
  });
  if (BigInt(receipt.blockNumber) !== BigInt(item.block)) {
    return mismatch();
  }
  let uncheckable = false;
  let tx: Tx | undefined;
  try {
    // The tx object is the completeness oracle for native value, so it is fetched whenever the
    // transaction could have touched the wallet — not only when the provider claims a native leg.
    tx = parseWith(txSchema, await requestJson(client, "eth_getTransactionByHash", [item.hash]));
  } catch {
    tx = undefined;
  }
  for (const t of item.transfers) {
    const check = transferCheck(receipt, tx, t);
    if (!check.match) {
      return mismatch();
    }
    uncheckable ||= !check.checkable;
  }
  const { moves, provable } = ownMovements(receipt, tx, address);
  for (const move of moves) {
    if (!claimedMove(move, item.transfers, tx)) {
      return mismatch();
    }
  }
  const fee = sameAddress(receipt.from, address)
    ? (
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
        (receipt.l1Fee === undefined || receipt.l1Fee === null ? 0n : BigInt(receipt.l1Fee))
      ).toString(10)
    : undefined;
  return {
    ...entry,
    status: receipt.status === "0x0" ? "failed" : "confirmed",
    verified: trusted && !uncheckable && provable,
    ...(fee === undefined ? {} : { fee }),
    flags: [...flags],
  };
};

/** Confirmed entries the group already verified — a mined transaction does not change. */
export type EvmHistoryCache = ReadonlyMap<string, HistoryEntry>;

/**
 * One history stream for a gateway-first EVM network. Each page is checked against the chain itself
 * — the host endpoint when the network has one (independent), the ordered endpoint list otherwise —
 * and `verified` additionally requires the reads to have gone to that host endpoint; when the only
 * reachable client is the gateway itself, entries stay unverified.
 */
export const evmHistoryStream = (
  options: EvmHistoryDeps,
  network: string,
  address: string,
  cached: EvmHistoryCache,
  onTruncated: () => void,
): Stream<HistoryEntry> => {
  const info = networkById(network);
  if (info === undefined) {
    throw new Error(`unknown network ${network}`);
  }
  const independent = options.networks.independentClient(network);
  const client =
    independent.kind === "available" ? independent.client : options.networks.client(network);
  const trusted = independent.kind !== "unavailable";
  const gatewayBase = options.gateway.url.replace(/\/+$/, "");
  let cursor: string | undefined;
  let done = false;
  return {
    id: network,
    next: async () => {
      if (done) {
        return { items: [], done: true };
      }
      const bound = timeoutSignal(REQUEST_TIMEOUT_MS, options.setTimer);
      try {
        const res = await options.gateway.fetch(`${gatewayBase}${historyPath(network)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address,
            ...(cursor === undefined ? {} : { cursor }),
            limit: PAGE_LIMIT,
          }),
          signal: bound.signal,
        });
        if (!res.ok) {
          throw new Error(`history ${network}: status ${res.status}`);
        }
        const page = parseWith(historyResponse, await res.json());
        if (page === undefined) {
          throw new Error(`history ${network}: malformed response`);
        }
        if (page.truncated) {
          onTruncated();
        }
        const { cursor: nextCursor } = page;
        cursor = nextCursor ?? undefined;
        done = nextCursor === null;
        const items = await mapPool(page.items, VERIFY_CONCURRENCY, async (item) => {
          const entry = evmHistoryEntry(
            info.chainId,
            info.symbol,
            info.decimals,
            address,
            network,
            item,
          );
          const hit = cached.get(entry.id);
          if (hit !== undefined && hit.verified && hit.block === entry.block) {
            return hit;
          }
          return verifyEntry(client, address, entry, item, trusted);
        });
        return { items, done };
      } finally {
        bound.cancel();
      }
    },
  };
};
