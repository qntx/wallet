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

/* ----------------------------------------------------- account derivation --- */

/**
 * Deposit-wallet CREATE2 factory — every deposit wallet is `CREATE2(factory, keccak256(
 * abi.encode(factory, bytes32(signer))), initCodeHash)` (docs trading/wallets-auth.md §Derive a
 * Deposit Wallet Address + resources/contracts.md).
 */
export const DEPOSIT_WALLET_FACTORY: `0x${string}` = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";

/** The beacon the current deposit-wallet proxy template points at (resources/contracts.md). */
export const DEPOSIT_WALLET_BEACON: `0x${string}` = "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";

/**
 * The UUPS implementation the pre-beacon deposit-wallet template points at (wallets deployed before
 * 2026-06-29 — resources/contracts.md; `@polymarket/client@0.18.0` walletDerivation).
 */
export const DEPOSIT_WALLET_IMPLEMENTATION: `0x${string}` =
  "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

/** The Safe proxy factory legacy accounts deployed through (resources/contracts.md). */
export const SAFE_FACTORY: `0x${string}` = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";

/**
 * Keccak256 of the Safe proxy init code Polymarket deployed legacy accounts with
 * (`@polymarket/client@0.18.0` `walletDerivation.safeInitCodeHash` — checked on-chain, research.md
 * §1a).
 */
export const SAFE_INIT_CODE_HASH: `0x${string}` =
  "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

/* ------------------------------------------------------------ exchanges --- */

/** The signature chain every Polymarket exchange domain commits to (docs §Order Domain). */
export const EXCHANGE_CHAIN_ID = 137;

/** The shared EIP-712 domain name of the CTF exchanges (docs §Order Domain). */
export const CTF_EXCHANGE_NAME = "Polymarket CTF Exchange";

/** CTF Exchange v2 — non-neg-risk V1 markets (docs §Order Domain; contracts.md). */
export const CTF_EXCHANGE_V2: `0x${string}` = "0xE111180000d2663C0091e4f400237545B87B996B";

/** CTF Exchange v2 — neg-risk V1 markets (docs §Order Domain; contracts.md). */
export const NEG_RISK_EXCHANGE_V2: `0x${string}` = "0xe2222d279d744050d28e00520010520000310F59";

/** CTF Exchange v3 — `version: "v2"` markets (docs §Order Domain; contracts.md). */
export const CTF_EXCHANGE_V3: `0x${string}` = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
