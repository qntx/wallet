/**
 * Polymarket account reads (design.md §account): public Data-v2 queries keyed by the located
 * account `wallet`, and L2-authenticated CLOB reads keyed by the group's stored credentials.
 *
 * `locate(group)` derives the group's `evm.bip44` signer, then resolves which of the three
 * candidate wallets exists on-chain through `wallets.locate` — the result is memoized per group per
 * session (a mid-session deploy is the enable flow's concern, not a read's). `trades` needs the
 * located wallet too: `maker_address` is a required CLOB filter.
 *
 * The spec documents `GET /data/order/{id}` 404 "Order not found" and `GET
 * /auth/ban-status/closed-only` 404 "no record" — both normalize to absence (`undefined` / `false`)
 * rather than an error; every other non-2xx propagates `unavailable` with its status.
 */
import type * as z from "zod/mini";

import type { AppGroup } from "../spi.ts";
import { DATA_HOST } from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketHttp } from "./http.ts";
import type { PolymarketL2 } from "./l2.ts";
import type { clobTrade } from "./schemas.ts";
import {
  clobApiKeyDelete,
  clobBalanceAllowance,
  clobClosedOnly,
  clobOpenOrder,
  clobOrdersPage,
  clobTradesPage,
  dataActivity,
  dataApprovals,
  dataPositions,
  dataUserPnl,
  dataValue,
} from "./schemas.ts";
import type { PolymarketAccount, PolymarketWallets } from "./wallets.ts";

export type { PolymarketAccount } from "./wallets.ts";

const POSITIONS_LIMIT = 100;

export type PolymarketPosition = {
  readonly assetId: string;
  readonly conditionId: string;
  /** Current holding in shares (decimal string). */
  readonly size: string;
  readonly avgPrice?: string;
  readonly price?: string;
  /** `size × price` in USDC. */
  readonly value?: string;
  readonly entryCost?: string;
  readonly realizedPnl?: string;
  readonly unrealizedPnl?: string;
  readonly totalPnl?: string;
  readonly status: string;
  readonly redeemable: boolean;
  readonly mergeable: boolean;
  readonly negRisk: boolean;
  readonly title?: string;
  readonly slug?: string;
  readonly outcome?: string;
  readonly outcomeIndex?: number;
  readonly endDate?: string;
};

export type PolymarketActivity = {
  /** TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, … */
  readonly type: string;
  readonly timestamp: number;
  readonly conditionId: string;
  readonly assetId: string;
  readonly side?: string;
  readonly size?: string;
  readonly usdcSize?: string;
  readonly price?: string;
  readonly transactionHash: string;
  readonly outcome?: string;
  readonly outcomeIndex?: number;
};

export type PolymarketPnlPoint = {
  readonly timestamp: number;
  readonly realizedPnl: string;
  readonly positionPnl?: string;
  readonly economicPnl?: string;
  readonly volume?: string;
  readonly tradeCount?: number;
};

export type PolymarketPnl = {
  readonly wallet: string;
  readonly interval: string;
  readonly fidelity: string;
  readonly points: ReadonlyArray<PolymarketPnlPoint>;
};

export type PolymarketApproval = {
  readonly id: string;
  readonly feature: string;
  readonly token: `0x${string}`;
  readonly spender: `0x${string}`;
  /** ERC20 allowance — `max` or a raw integer string; absent on ERC1155 rows. */
  readonly amount?: string;
  readonly standard: string;
  readonly approved: boolean;
};

export type PolymarketApprovals = {
  readonly address: `0x${string}`;
  readonly checkedAt: string;
  readonly contracts: ReadonlyArray<PolymarketApproval>;
};

export type PolymarketOrder = {
  readonly id: string;
  readonly status: string;
  readonly conditionId: string;
  readonly assetId: string;
  readonly side: string;
  readonly price: string;
  readonly originalSize: string;
  readonly sizeMatched: string;
  readonly outcome?: string;
  readonly orderType: string;
  readonly expiration: string;
  readonly createdAt: number;
  readonly makerAddress: string;
};

export type PolymarketTrade = {
  readonly id: string;
  readonly takerOrderId: string;
  readonly conditionId: string;
  readonly assetId: string;
  readonly side: string;
  readonly size: string;
  readonly price: string;
  readonly status: string;
  readonly matchTime: string;
  readonly outcome?: string;
  readonly transactionHash?: string;
  readonly traderSide: string;
  readonly makerOrders: ReadonlyArray<{
    readonly orderId: string;
    readonly matchedAmount: string;
    readonly price: string;
  }>;
};

export type PolymarketBalance = {
  /** Collateral balance as a raw 6-decimal integer string. */
  readonly balance: string;
  /** Spender → allowance, raw 6-decimal integer strings. */
  readonly allowances: Readonly<Record<string, string>>;
};

export type PolymarketPositionsParams = {
  readonly cursor?: string;
  readonly limit?: number;
};

export type PolymarketActivityParams = {
  readonly cursor?: string;
  readonly limit?: number;
  readonly start?: number;
  readonly end?: number;
  readonly sortDirection?: "ASC" | "DESC";
};

export type PolymarketPnlParams = {
  readonly interval?: "max" | "all" | "1m" | "1w" | "1d" | "12h" | "6h";
  readonly fidelity?: "1d" | "18h" | "12h" | "3h" | "1h";
};

export type PolymarketOpenOrdersParams = {
  /** Condition id — required when `assetId` is given (the CLOB refuses asset-only queries). */
  readonly market?: string;
  readonly assetId?: string;
  readonly cursor?: string;
};

export type PolymarketTradesParams = {
  readonly market?: string;
  readonly assetId?: string;
  readonly before?: number;
  readonly after?: number;
  readonly cursor?: string;
};

export type PolymarketPage<T> = {
  readonly items: ReadonlyArray<T>;
  /** Follow with the same params plus `cursor` — absent on the last page. */
  readonly nextCursor?: string;
};

export type PolymarketAccountReads = {
  /** Where this group's account lives — the located wallet or the beacon it will deploy to. */
  readonly locate: (group: AppGroup) => Promise<PolymarketAccount>;
  readonly positions: (
    wallet: `0x${string}`,
    params?: PolymarketPositionsParams,
  ) => Promise<PolymarketPage<PolymarketPosition>>;
  /** The wallet's portfolio value in USDC (decimal string). */
  readonly value: (wallet: `0x${string}`) => Promise<string>;
  readonly activity: (
    wallet: `0x${string}`,
    params?: PolymarketActivityParams,
  ) => Promise<PolymarketPage<PolymarketActivity>>;
  readonly pnl: (wallet: `0x${string}`, params?: PolymarketPnlParams) => Promise<PolymarketPnl>;
  readonly approvals: (wallet: `0x${string}`) => Promise<PolymarketApprovals>;
  readonly openOrders: (
    group: AppGroup,
    params?: PolymarketOpenOrdersParams,
  ) => Promise<PolymarketPage<PolymarketOrder>>;
  /** `undefined` when the CLOB has no such order — its documented 404. */
  readonly order: (group: AppGroup, orderId: string) => Promise<PolymarketOrder | undefined>;
  readonly trades: (
    group: AppGroup,
    params?: PolymarketTradesParams,
  ) => Promise<PolymarketPage<PolymarketTrade>>;
  /** Collateral balance + allowances at `signature_type: 3` (the deposit wallet). */
  readonly balance: (group: AppGroup) => Promise<PolymarketBalance>;
  /** Forces the CLOB to re-read on-chain balance/allowance, then returns them. */
  readonly refreshAllowance: (
    group: AppGroup,
    params: { readonly assetType: "COLLATERAL" | "CONDITIONAL"; readonly tokenId?: string },
  ) => Promise<PolymarketBalance>;
  /** `false` also when the address has no ban record (the documented 404). */
  readonly closedOnly: (group: AppGroup) => Promise<boolean>;
  /** `DELETE /auth/api-key` — revokes the group's API key on the CLOB (L2-signed). */
  readonly revokeApiKey: (group: AppGroup) => Promise<void>;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ORDER_ID = /^0x[0-9a-fA-F]{64}$/;

const isWallet = (wallet: string): wallet is `0x${string}` => ADDRESS.test(wallet);

const checkWallet = (wallet: string): `0x${string}` => {
  if (!isWallet(wallet)) {
    throw new PolymarketError("invalid-input", `bad wallet address ${wallet}`);
  }
  return wallet;
};

const checkLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > POSITIONS_LIMIT)) {
    throw new PolymarketError("invalid-input", `limit must be an integer in 1..${POSITIONS_LIMIT}`);
  }
};

/** The documented absence answers: a 404 `unavailable` becomes `absent`, anything else throws. */
const absentOn404 = (error: unknown): "absent" => {
  if (
    error instanceof PolymarketError &&
    error.category === "unavailable" &&
    error.status === 404
  ) {
    return "absent";
  }
  throw error;
};

/** CLOB page cursors mark the end with `LTE=` (base64 `-1`) or an empty string. */
const clobCursor = (next: string): string | undefined =>
  next === "" || next === "LTE=" ? undefined : next;

type WirePosition = z.output<typeof dataPositions>["data"][number];

const normalizePosition = (row: WirePosition): PolymarketPosition => ({
  assetId: row.token_id,
  conditionId: row.condition_id,
  size: row.current_size,
  ...(row.avg_price === undefined || row.avg_price === null ? {} : { avgPrice: row.avg_price }),
  ...(row.current_price === undefined || row.current_price === null
    ? {}
    : { price: row.current_price }),
  ...(row.current_value === undefined || row.current_value === null
    ? {}
    : { value: row.current_value }),
  ...(row.entry_cost_usdc === undefined || row.entry_cost_usdc === null
    ? {}
    : { entryCost: row.entry_cost_usdc }),
  ...(row.realized_pnl === undefined || row.realized_pnl === null
    ? {}
    : { realizedPnl: row.realized_pnl }),
  ...(row.unrealized_pnl === undefined || row.unrealized_pnl === null
    ? {}
    : { unrealizedPnl: row.unrealized_pnl }),
  ...(row.total_pnl === undefined || row.total_pnl === null ? {} : { totalPnl: row.total_pnl }),
  status: row.status,
  redeemable: row.redeemable ?? false,
  mergeable: row.mergeable ?? false,
  negRisk: row.negative_risk ?? false,
  ...(row.title === undefined || row.title === null ? {} : { title: row.title }),
  ...(row.slug === undefined || row.slug === null ? {} : { slug: row.slug }),
  ...(row.outcome === undefined || row.outcome === null ? {} : { outcome: row.outcome }),
  ...(row.outcome_index === undefined || row.outcome_index === null
    ? {}
    : { outcomeIndex: row.outcome_index }),
  ...(row.end_date === undefined || row.end_date === null ? {} : { endDate: row.end_date }),
});

type WireActivity = z.output<typeof dataActivity>["data"][number];

const normalizeActivity = (row: WireActivity): PolymarketActivity => ({
  type: row.type,
  timestamp: row.timestamp,
  conditionId: row.condition_id,
  assetId: row.token_id,
  ...(row.side === undefined || row.side === "" ? {} : { side: row.side }),
  ...(row.size === undefined || row.size === null ? {} : { size: row.size }),
  ...(row.usdc_size === undefined || row.usdc_size === null ? {} : { usdcSize: row.usdc_size }),
  ...(row.price === undefined || row.price === null ? {} : { price: row.price }),
  transactionHash: row.transaction_hash,
  ...(row.outcome === undefined || row.outcome === null ? {} : { outcome: row.outcome }),
  ...(row.outcome_index === undefined || row.outcome_index === null
    ? {}
    : { outcomeIndex: row.outcome_index }),
});

type WireOrder = z.output<typeof clobOpenOrder>;

const normalizeOrder = (row: WireOrder): PolymarketOrder => ({
  id: row.id,
  status: row.status,
  conditionId: row.market,
  assetId: row.asset_id,
  side: row.side,
  price: row.price,
  originalSize: row.original_size,
  sizeMatched: row.size_matched,
  ...(row.outcome === undefined || row.outcome === null ? {} : { outcome: row.outcome }),
  orderType: row.order_type,
  expiration: row.expiration,
  createdAt: row.created_at,
  makerAddress: row.maker_address,
});

type WireTrade = z.output<typeof clobTrade>;

const normalizeTrade = (row: WireTrade): PolymarketTrade => ({
  id: row.id,
  takerOrderId: row.taker_order_id,
  conditionId: row.market,
  assetId: row.asset_id,
  side: row.side,
  size: row.size,
  price: row.price,
  status: row.status,
  matchTime: row.match_time,
  ...(row.outcome === undefined || row.outcome === null ? {} : { outcome: row.outcome }),
  ...(row.transaction_hash === undefined || row.transaction_hash === null
    ? {}
    : { transactionHash: row.transaction_hash }),
  traderSide: row.trader_side,
  makerOrders: (row.maker_orders ?? []).map((order) => ({
    orderId: order.order_id,
    matchedAmount: order.matched_amount,
    price: order.price,
  })),
});

type WirePnlPoint = z.output<typeof dataUserPnl>["data"]["points"][number];

const normalizePnlPoint = (point: WirePnlPoint): PolymarketPnlPoint => ({
  timestamp: point.timestamp,
  realizedPnl: point.realized_pnl,
  ...(point.position_pnl === undefined || point.position_pnl === null
    ? {}
    : { positionPnl: point.position_pnl }),
  ...(point.economic_pnl === undefined || point.economic_pnl === null
    ? {}
    : { economicPnl: point.economic_pnl }),
  ...(point.volume_usdc === undefined || point.volume_usdc === null
    ? {}
    : { volume: point.volume_usdc }),
  ...(point.trade_count === undefined || point.trade_count === null
    ? {}
    : { tradeCount: point.trade_count }),
});

type WireApproval = z.output<typeof dataApprovals>["data"]["contracts"][number];

const normalizeApproval = (contract: WireApproval): PolymarketApproval => ({
  id: contract.id,
  feature: contract.feature,
  token: contract.token,
  spender: contract.spender,
  standard: contract.standard,
  ...(contract.amount === undefined || contract.amount === null ? {} : { amount: contract.amount }),
  approved: contract.approved,
});

export function createPolymarketAccount(options: {
  readonly http: PolymarketHttp;
  readonly l2: PolymarketL2;
  readonly wallets: PolymarketWallets;
  /** The group's `evm.bip44` signer address — the apps account seam on Polygon. */
  readonly signerOf: (group: AppGroup) => Promise<`0x${string}`>;
}): PolymarketAccountReads {
  /** Group key → the locate call — one relayer probe per group per session. */
  const located = new Map<string, Promise<PolymarketAccount>>();

  const locate = async (group: AppGroup): Promise<PolymarketAccount> => {
    const key = `${group.walletId}/${group.groupIndex}`;
    let pending = located.get(key);
    if (pending === undefined) {
      const run = async (): Promise<PolymarketAccount> =>
        options.wallets.locate(await options.signerOf(group));
      pending = run();
      located.set(key, pending);
    }
    const account = await pending;
    /* Only a deployed wallet is a permanent fact — an undeployed result goes stale the moment a
       deploy confirms, so it is dropped once settled and the next call re-probes. */
    if (!account.deployed && located.get(key) === pending) {
      located.delete(key);
    }
    return account;
  };

  return {
    locate,

    positions: async (wallet, params) => {
      checkWallet(wallet);
      checkLimit(params?.limit);
      const page = await options.http.request(
        {
          host: DATA_HOST,
          method: "GET",
          path: "/v2/positions",
          query: {
            user: wallet,
            ...(params?.limit === undefined ? {} : { limit: params.limit }),
            ...(params?.cursor === undefined ? {} : { cursor: params.cursor }),
          },
        },
        dataPositions,
      );
      return {
        items: page.data.map(normalizePosition),
        ...(page.pagination.next_cursor === undefined ||
        page.pagination.next_cursor === null ||
        page.pagination.next_cursor === ""
          ? {}
          : { nextCursor: page.pagination.next_cursor }),
      };
    },

    value: async (wallet) => {
      checkWallet(wallet);
      const answer = await options.http.request(
        { host: DATA_HOST, method: "GET", path: "/v2/value", query: { user: wallet } },
        dataValue,
      );
      return answer.data.value;
    },

    activity: async (wallet, params) => {
      checkWallet(wallet);
      checkLimit(params?.limit);
      const page = await options.http.request(
        {
          host: DATA_HOST,
          method: "GET",
          path: "/v2/activity",
          query: {
            user: wallet,
            ...(params?.limit === undefined ? {} : { limit: params.limit }),
            ...(params?.cursor === undefined ? {} : { cursor: params.cursor }),
            ...(params?.start === undefined ? {} : { start: params.start }),
            ...(params?.end === undefined ? {} : { end: params.end }),
            ...(params?.sortDirection === undefined
              ? {}
              : { sort_direction: params.sortDirection }),
          },
        },
        dataActivity,
      );
      return {
        items: page.data.map(normalizeActivity),
        ...(page.pagination.next_cursor === undefined ||
        page.pagination.next_cursor === null ||
        page.pagination.next_cursor === ""
          ? {}
          : { nextCursor: page.pagination.next_cursor }),
      };
    },

    pnl: async (wallet, params) => {
      checkWallet(wallet);
      const answer = await options.http.request(
        {
          host: DATA_HOST,
          method: "GET",
          path: "/v2/user-pnl",
          query: {
            user: wallet,
            ...(params?.interval === undefined ? {} : { interval: params.interval }),
            ...(params?.fidelity === undefined ? {} : { fidelity: params.fidelity }),
          },
        },
        dataUserPnl,
      );
      return {
        wallet: answer.data.proxy_wallet,
        interval: answer.data.interval,
        fidelity: answer.data.fidelity,
        points: answer.data.points.map(normalizePnlPoint),
      };
    },

    approvals: async (wallet) => {
      checkWallet(wallet);
      const answer = await options.http.request(
        { host: DATA_HOST, method: "GET", path: "/v2/approvals", query: { user: wallet } },
        dataApprovals,
      );
      return {
        address: answer.data.address,
        checkedAt: answer.data.checked_at,
        contracts: answer.data.contracts.map(normalizeApproval),
      };
    },

    openOrders: async (group, params) => {
      if (params?.assetId !== undefined && params.market === undefined) {
        throw new PolymarketError("invalid-input", "assetId requires market");
      }
      const page = await options.l2.request(
        group,
        {
          method: "GET",
          path: "/data/orders",
          query: {
            ...(params?.market === undefined ? {} : { market: params.market }),
            ...(params?.assetId === undefined ? {} : { asset_id: params.assetId }),
            ...(params?.cursor === undefined ? {} : { next_cursor: params.cursor }),
          },
        },
        clobOrdersPage,
      );
      const nextCursor = clobCursor(page.next_cursor);
      return {
        items: page.data.map(normalizeOrder),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },

    order: async (group, orderId) => {
      if (!ORDER_ID.test(orderId)) {
        throw new PolymarketError("invalid-input", `bad order id ${orderId}`);
      }
      const row = await options.l2
        .request(group, { method: "GET", path: `/data/order/${orderId}` }, clobOpenOrder)
        .catch(absentOn404);
      return row === "absent" ? undefined : normalizeOrder(row);
    },

    trades: async (group, params) => {
      /* `maker_address` is a required filter — it scopes to the located account wallet. */
      const located_ = await locate(group);
      const maker = located_.wallet;
      const page = await options.l2.request(
        group,
        {
          method: "GET",
          path: "/data/trades",
          query: {
            maker_address: maker,
            ...(params?.market === undefined ? {} : { market: params.market }),
            ...(params?.assetId === undefined ? {} : { asset_id: params.assetId }),
            ...(params?.before === undefined ? {} : { before: params.before }),
            ...(params?.after === undefined ? {} : { after: params.after }),
            ...(params?.cursor === undefined ? {} : { next_cursor: params.cursor }),
          },
        },
        clobTradesPage,
      );
      const nextCursor = clobCursor(page.next_cursor);
      return {
        items: page.data.map(normalizeTrade),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },

    balance: async (group) => {
      const answer = await options.l2.request(
        group,
        {
          method: "GET",
          path: "/balance-allowance",
          query: { asset_type: "COLLATERAL", signature_type: 3 },
        },
        clobBalanceAllowance,
      );
      return { balance: answer.balance, allowances: answer.allowances };
    },

    refreshAllowance: async (group, params) => {
      const answer = await options.l2.request(
        group,
        {
          method: "GET",
          path: "/balance-allowance/update",
          query: {
            asset_type: params.assetType,
            signature_type: 3,
            ...(params.tokenId === undefined ? {} : { token_id: params.tokenId }),
          },
        },
        clobBalanceAllowance,
      );
      return { balance: answer.balance, allowances: answer.allowances };
    },

    closedOnly: async (group) => {
      const answer = await options.l2
        .request(group, { method: "GET", path: "/auth/ban-status/closed-only" }, clobClosedOnly)
        .catch(absentOn404);
      return answer === "absent" ? false : answer.closed_only;
    },

    revokeApiKey: async (group) => {
      /* The answer is the bare string "OK" — nothing to parse. */
      await options.l2.request(
        group,
        { method: "DELETE", path: "/auth/api-key" },
        clobApiKeyDelete,
      );
    },
  };
}
