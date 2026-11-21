/**
 * Polymarket hosts (docs.polymarket.com getting-started/api.md; research.md §5). Every request goes
 * to one of these over the injected fetch — nothing else is a valid base.
 */

/** Gamma API — market/event metadata (events, markets, search). */
export const GAMMA_HOST = "https://gamma-api.polymarket.com";

/** CLOB REST — order book, prices, fees, server time, L2-authenticated trading. */
export const CLOB_HOST = "https://clob.polymarket.com";

/** Data API v2 — positions, activity, resolutions, approvals. */
export const DATA_HOST = "https://data-api.polymarket.com";

/** Relayer — deposit-wallet deploy, batched approvals, Safe transactions. */
export const RELAYER_HOST = "https://relayer-v2.polymarket.com";

/** Market-channel WebSocket (`/ws/market`) — book/price/trade events. */
export const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
