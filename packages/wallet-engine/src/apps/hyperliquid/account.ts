import {
  clearinghouseState,
  extraAgents,
  frontendOpenOrders,
  maxBuilderFee,
  orderStatus,
  portfolio,
  spotClearinghouseState,
  userFees,
  userFills,
  userFunding,
  userRateLimit,
  userRole,
} from "@nktkas/hyperliquid/api/info";
import type {
  ClearinghouseStateParameters,
  ClearinghouseStateResponse,
  ExtraAgentsResponse,
  FrontendOpenOrdersParameters,
  FrontendOpenOrdersResponse,
  InfoConfig,
  MaxBuilderFeeResponse,
  OrderStatusParameters,
  OrderStatusResponse,
  PortfolioResponse,
  SpotClearinghouseStateParameters,
  SpotClearinghouseStateResponse,
  UserFeesResponse,
  UserFillsParameters,
  UserFillsResponse,
  UserFundingParameters,
  UserFundingResponse,
  UserRateLimitResponse,
  UserRoleResponse,
} from "@nktkas/hyperliquid/api/info";

/** Every account read addresses the master account — agents query it lowercased. */
const master = (user: string): `0x${string}` => `0x${user.toLowerCase().replace(/^0x/, "")}`;

/**
 * Account reads over the injected transport — thin pass-throughs to the SDK request functions with
 * the user always spelled as the lowercase master address.
 */
export type HyperliquidAccount = {
  /** Perpetual margin summary and open positions. */
  readonly state: (params: ClearinghouseStateParameters) => Promise<ClearinghouseStateResponse>;
  /** Spot balances. */
  readonly spot: (
    params: SpotClearinghouseStateParameters,
  ) => Promise<SpotClearinghouseStateResponse>;
  /** Open orders with frontend display fields (triggers, TP/SL info). */
  readonly openOrders: (
    params: FrontendOpenOrdersParameters,
  ) => Promise<FrontendOpenOrdersResponse>;
  /** The account's fills, optionally aggregated by time. */
  readonly fills: (params: UserFillsParameters) => Promise<UserFillsResponse>;
  /** Funding payments and non-funding ledger updates over `[startTime, endTime)`. */
  readonly funding: (params: UserFundingParameters) => Promise<UserFundingResponse>;
  /** The account's portfolio breakdown over the standard windows. */
  readonly portfolio: (user: string) => Promise<PortfolioResponse>;
  /** The account's REST rate-limit standing. */
  readonly rateLimit: (user: string) => Promise<UserRateLimitResponse>;
  /** Fee schedule and discounts for the account. */
  readonly fees: (user: string) => Promise<UserFeesResponse>;
  /** Order status by oid or cloid — `{status:"order"}` or `{status:"unknownOid"}`. */
  readonly orderStatus: (params: OrderStatusParameters) => Promise<OrderStatusResponse>;
  /** Named API wallets (agents) the account has approved. */
  readonly extraAgents: (user: string) => Promise<ExtraAgentsResponse>;
  /** The builder fee the account approved for `builder`, in tenths of a bp. */
  readonly maxBuilderFee: (user: string, builder: string) => Promise<MaxBuilderFeeResponse>;
  /** `missing`/`user`/`agent`/`vault`/`subAccount` — gates enabling an agent. */
  readonly role: (user: string) => Promise<UserRoleResponse>;
};

export type {
  ClearinghouseStateResponse,
  ExtraAgentsResponse,
  FrontendOpenOrdersResponse,
  MaxBuilderFeeResponse,
  OrderStatusResponse,
  PortfolioResponse,
  SpotClearinghouseStateResponse,
  UserFeesResponse,
  UserFillsResponse,
  UserFundingResponse,
  UserRateLimitResponse,
  UserRoleResponse,
} from "@nktkas/hyperliquid/api/info";

export function createHyperliquidAccount(config: InfoConfig): HyperliquidAccount {
  return {
    state: async (params) => clearinghouseState(config, { ...params, user: master(params.user) }),
    spot: async (params) =>
      spotClearinghouseState(config, { ...params, user: master(params.user) }),
    openOrders: async (params) =>
      frontendOpenOrders(config, { ...params, user: master(params.user) }),
    fills: async (params) => userFills(config, { ...params, user: master(params.user) }),
    funding: async (params) => userFunding(config, { ...params, user: master(params.user) }),
    portfolio: async (user) => portfolio(config, { user: master(user) }),
    rateLimit: async (user) => userRateLimit(config, { user: master(user) }),
    fees: async (user) => userFees(config, { user: master(user) }),
    orderStatus: async (params) => orderStatus(config, { ...params, user: master(params.user) }),
    extraAgents: async (user) => extraAgents(config, { user: master(user) }),
    maxBuilderFee: async (user, builder) =>
      maxBuilderFee(config, { user: master(user), builder: master(builder) }),
    role: async (user) => userRole(config, { user: master(user) }),
  };
}
