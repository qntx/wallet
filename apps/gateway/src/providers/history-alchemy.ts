import * as z from "zod/mini";

import {
  HISTORY_ITEMS_MAX,
  HISTORY_TRANSFERS_MAX,
  historyResponse,
  accepts,
} from "@qntx/wallet-engine/gateway/contract";
import type { HistoryResponse, HistoryTransfer } from "@qntx/wallet-engine/gateway/contract";

import { GatewayHttpError } from "../middleware/errors.ts";
import type { ResolvedNetwork } from "../middleware/network.ts";
import type { ResolvedProvider } from "../types.ts";
import type { Forwarded, Forwarder, Send } from "./forward.ts";
import { ProviderFailure, REFUSED_STATUSES, REQUEST_ERROR_STATUSES } from "./forward.ts";

/**
 * EVM transfer history over Alchemy's `alchemy_getAssetTransfers` on the same endpoint and auth the
 * network's RPC already uses — no new secret. This adapter has not been exercised live with the
 * production key.
 */

/** A drained block re-queries both directions at max page size. */
const DRAIN_MAX_COUNT = "0x3e8";
/**
 * Paged bodies stay well under 1 MiB; 4 MiB leaves headroom for a drained page. A larger answer is
 * the address's own (a client can bloat one cheaply), so it is the request's 400, never an outage.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Chains where Alchemy accepts the `internal` transfer category. */
const INTERNAL_CATEGORY_CHAINS: ReadonlySet<number> = new Set([1, 137, 8453]);

const CATEGORIES_ALL = ["external", "internal", "erc20", "erc721", "erc1155"] as const;
const CATEGORIES_NO_INTERNAL = ["external", "erc20", "erc721", "erc1155"] as const;

const KIND: Readonly<Record<string, HistoryTransfer["kind"]>> = {
  external: "native",
  internal: "internal",
  erc20: "erc20",
  erc721: "erc721",
  erc1155: "erc1155",
};

const upstreamTransfer = z.looseObject({
  blockNum: z.string(),
  uniqueId: z.string(),
  hash: z.string(),
  from: z.string(),
  to: z.union([z.string(), z.null()]),
  asset: z.union([z.string(), z.null()]),
  category: z.string(),
  tokenId: z.union([z.string(), z.null()]),
  erc721TokenId: z.union([z.string(), z.null()]),
  erc1155Metadata: z.union([
    z.array(z.looseObject({ tokenId: z.string(), value: z.string() })),
    z.null(),
  ]),
  rawContract: z.looseObject({
    value: z.union([z.string(), z.null()]),
    address: z.union([z.string(), z.null()]),
    decimal: z.union([z.string(), z.null()]),
  }),
  metadata: z.union([z.looseObject({ blockTimestamp: z.string() }), z.null()]),
});

const upstreamPage = z.looseObject({
  transfers: z.array(upstreamTransfer),
  pageKey: z.optional(z.string()),
});

const upstreamResponse = z.looseObject({
  result: z.optional(z.union([upstreamPage, z.null()])),
  error: z.optional(z.unknown()),
});

type UpstreamTransfer = z.output<typeof upstreamTransfer>;
type UpstreamPage = z.output<typeof upstreamPage>;

/** The network's Alchemy providers re-labelled so history failures never open the RPC breaker. */
export const historyProviders = (network: ResolvedNetwork): ReadonlyArray<ResolvedProvider> => {
  const out: ResolvedProvider[] = [];
  for (const provider of network.providers) {
    if (provider.id === "alchemy") {
      out.push({ ...provider, id: "alchemy-transfers" });
    }
  }
  return out;
};

const HEX = /^0x[0-9a-fA-F]+$/;
const hexToBigInt = (value: unknown): bigint | undefined =>
  typeof value === "string" && HEX.test(value) ? BigInt(value) : undefined;
const toHex = (decimal: string): string => `0x${BigInt(decimal).toString(16)}`;

const LOG_INDEX = /:log:(\d+)/;
/** Display-only symbols: ASCII printable only — anything fancier is dropped, not trusted. */
const PRINTABLE = /^[\u0020-\u007E]{1,32}$/;

/** One upstream call: `params` is the single `alchemy_getAssetTransfers` argument. */
const call = async (
  send: Send,
  provider: ResolvedProvider,
  params: Record<string, unknown>,
): Promise<UpstreamPage> => {
  const response = await send({
    url: provider.url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [params],
    }),
  });
  if (!response.ok) {
    if (REQUEST_ERROR_STATUSES.has(response.status)) {
      throw new GatewayHttpError(400, "invalid-request");
    }
    throw new ProviderFailure(`status-${response.status}`, REFUSED_STATUSES.has(response.status));
  }
  const text = await response.text(MAX_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderFailure("malformed", false);
  }
  const body = z.safeParse(upstreamResponse, parsed);
  if (!body.success) {
    throw new ProviderFailure("malformed", false);
  }
  if (body.data.error !== undefined) {
    throw new ProviderFailure("rpc-error", false);
  }
  const { result } = body.data;
  if (result === undefined || result === null) {
    throw new ProviderFailure("malformed", false);
  }
  return result;
};

/** A kept upstream transfer plus the fields an item needs; dedupe and grouping key off it. */
type Kept = {
  readonly uniqueId: string;
  readonly hash: string;
  readonly block: bigint;
  readonly timestamp: number;
  readonly transfer: HistoryTransfer;
};

const decimalString = (value: bigint): string => value.toString(10);

/** The display timestamp of a transfer, or 0 when the upstream carries none. */
const timestampOf = (t: UpstreamTransfer): number => {
  const parsed = Date.parse(t.metadata?.blockTimestamp ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The mapped contract transfer(s) of one upstream record — empty when it is uninterpretable. */
const mapTransfer = (t: UpstreamTransfer): ReadonlyArray<HistoryTransfer> => {
  const kind = KIND[t.category];
  if (kind === undefined) {
    return [];
  }
  const logIndex = LOG_INDEX.exec(t.uniqueId);
  const shared = {
    kind,
    from: t.from,
    to: t.to,
    symbol: t.asset !== null && PRINTABLE.test(t.asset) ? t.asset : null,
    logIndex: logIndex === null ? null : Number(logIndex[1]),
  };
  const decimalsHex = hexToBigInt(t.rawContract.decimal);
  const decimals =
    decimalsHex === undefined || decimalsHex < 0n || decimalsHex > 255n
      ? null
      : Number(decimalsHex);
  if (kind === "native" || kind === "internal") {
    const amount = hexToBigInt(t.rawContract.value);
    if (amount === undefined) {
      return [];
    }
    return [
      {
        ...shared,
        contract: null,
        tokenId: null,
        amount: decimalString(amount),
        decimals,
      },
    ];
  }
  if (kind === "erc721") {
    const tokenId = hexToBigInt(t.erc721TokenId ?? t.tokenId);
    if (tokenId === undefined) {
      return [];
    }
    return [
      {
        ...shared,
        contract: t.rawContract.address,
        tokenId: decimalString(tokenId),
        amount: "1",
        decimals: null,
      },
    ];
  }
  if (kind === "erc1155") {
    return (t.erc1155Metadata ?? []).flatMap((entry) => {
      const tokenId = hexToBigInt(entry.tokenId);
      const amount = hexToBigInt(entry.value);
      if (tokenId === undefined || amount === undefined) {
        return [];
      }
      return [
        {
          ...shared,
          contract: t.rawContract.address,
          tokenId: decimalString(tokenId),
          amount: decimalString(amount),
          decimals,
        },
      ];
    });
  }
  // erc20
  const amount = hexToBigInt(t.rawContract.value);
  if (amount === undefined) {
    return [];
  }
  return [
    {
      ...shared,
      contract: t.rawContract.address,
      tokenId: null,
      amount: decimalString(amount),
      decimals,
    },
  ];
};

type Direction = "fromAddress" | "toAddress";

const pageParams = (
  direction: Direction,
  address: string,
  chainId: number,
  bounds: { readonly fromBlock: string; readonly toBlock: string },
  maxCount: string,
): Record<string, unknown> => ({
  fromBlock: bounds.fromBlock,
  toBlock: bounds.toBlock,
  [direction]: address,
  category: INTERNAL_CATEGORY_CHAINS.has(chainId) ? CATEGORIES_ALL : CATEGORIES_NO_INTERNAL,
  withMetadata: true,
  excludeZeroValue: false,
  maxCount,
  order: "desc",
});

const DIRECTIONS: ReadonlyArray<Direction> = ["toAddress", "fromAddress"];

/**
 * The lowest block of a direction's page, or `undefined` when the page is empty. Only directions
 * that report `pageKey` contribute to the frontier: a boundary block's transfers may be split
 * across pages, so they are withheld and collected by the next page — or the drain below.
 */
const lowestBlock = (page: UpstreamPage): bigint | undefined => {
  let low: bigint | undefined;
  for (const t of page.transfers) {
    const block = hexToBigInt(t.blockNum);
    if (block !== undefined && (low === undefined || block < low)) {
      low = block;
    }
  }
  return low;
};

const pageResult = (
  pages: ReadonlyArray<UpstreamPage>,
): {
  readonly transfers: ReadonlyArray<UpstreamTransfer>;
  readonly frontier: bigint | undefined;
} => {
  const frontiers = pages
    .filter((page) => page.pageKey !== undefined)
    .map(lowestBlock)
    .filter((b): b is bigint => b !== undefined);
  let frontier: bigint | undefined;
  for (const block of frontiers) {
    if (frontier === undefined || block > frontier) {
      frontier = block;
    }
  }
  return { transfers: pages.flatMap((page) => page.transfers), frontier };
};

/** Groups kept transfers into contract items: block desc, then hash; logs in index order. */
const buildResponse = (
  kept: ReadonlyArray<Kept>,
  cursor: HistoryResponse["cursor"],
): HistoryResponse => {
  const byHash = new Map<string, Kept[]>();
  for (const k of kept) {
    const group = byHash.get(k.hash);
    if (group === undefined) {
      byHash.set(k.hash, [k]);
    } else {
      group.push(k);
    }
  }
  const items = [...byHash.values()]
    .map((group) => {
      const [first] = group;
      const ordered = group.toSorted((a, b) => {
        const ai = a.transfer.logIndex;
        const bi = b.transfer.logIndex;
        if (ai === null) {
          return bi === null ? 0 : -1;
        }
        return bi === null ? 1 : ai - bi;
      });
      return {
        hash: first?.hash ?? "",
        block: decimalString(first?.block ?? 0n),
        timestamp: first?.timestamp ?? 0,
        transfers: ordered.map((k) => k.transfer).slice(0, HISTORY_TRANSFERS_MAX),
      };
    })
    .toSorted((a, b) =>
      a.block === b.block ? (a.hash < b.hash ? -1 : 1) : Number(BigInt(b.block) - BigInt(a.block)),
    )
    .slice(0, HISTORY_ITEMS_MAX);
  return { items, cursor };
};

/**
 * One history page: `toAddress` and `fromAddress` pages in parallel, deduped by Alchemy's
 * `uniqueId` (a self-transfer appears on both sides). Transfers at the frontier block are withheld
 * — the page boundary may have split them — and collected by the next cursor page or, when the page
 * would come back empty, by a one-round drain of the whole frontier block.
 */
export const alchemyHistoryPage = async (
  forwarder: Forwarder,
  providers: ReadonlyArray<ResolvedProvider>,
  params: {
    readonly chainId: number;
    readonly address: string;
    readonly cursor?: string;
    readonly limit: number;
  },
  /** Pays for the drain round's two extra calls; throws (429) before either is sent. */
  chargeDrain: () => Promise<void>,
  log: (line: string) => void,
): Promise<Forwarded<HistoryResponse>> =>
  forwarder.run(providers, async (send, provider) => {
    const { chainId, address, cursor, limit } = params;
    const bounds = {
      fromBlock: "0x0",
      toBlock: cursor === undefined ? "latest" : toHex(cursor),
    };
    const round = async (
      roundBounds: { readonly fromBlock: string; readonly toBlock: string },
      maxCount: string,
    ): Promise<ReadonlyArray<UpstreamPage>> =>
      Promise.all(
        DIRECTIONS.map(async (direction) =>
          call(send, provider, pageParams(direction, address, chainId, roundBounds, maxCount)),
        ),
      );

    const pages = await round(bounds, toHex(String(limit)));
    const { transfers, frontier } = pageResult(pages);
    let kept = transfers.filter(
      (t) => frontier === undefined || (hexToBigInt(t.blockNum) ?? 0n) > frontier,
    );
    let nextCursor = frontier === undefined ? null : decimalString(frontier);

    if (kept.length === 0 && frontier !== undefined) {
      await chargeDrain();
      const drainPages = await round(
        { fromBlock: toHex(decimalString(frontier)), toBlock: toHex(decimalString(frontier)) },
        DRAIN_MAX_COUNT,
      );
      if (drainPages.some((page) => page.pageKey !== undefined)) {
        // The frontier block holds more than a max page: keep what came — one bounded round
        // is the whole cost this route pays for it.
        log(JSON.stringify({ event: "history-drain-truncated" }));
      }
      kept = drainPages.flatMap((page) => page.transfers);
      nextCursor = frontier === 0n ? null : decimalString(frontier - 1n);
    }

    const seen = new Set<string>();
    const mapped: Kept[] = [];
    for (const t of kept) {
      if (seen.has(t.uniqueId)) {
        continue;
      }
      const transfers = mapTransfer(t);
      if (transfers.length === 0) {
        continue;
      }
      seen.add(t.uniqueId);
      const block = hexToBigInt(t.blockNum);
      if (block === undefined) {
        continue;
      }
      for (const transfer of transfers) {
        mapped.push({
          uniqueId: t.uniqueId,
          hash: t.hash,
          block,
          timestamp: timestampOf(t),
          transfer,
        });
      }
    }
    const response = buildResponse(mapped, nextCursor);
    if (!accepts(historyResponse, response)) {
      throw new ProviderFailure("malformed", false);
    }
    return response;
  });
