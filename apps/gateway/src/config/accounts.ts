import type { CostModel, CostRow } from "../budget/costs.ts";
import { ALCHEMY_COSTS, TRONGRID_COSTS } from "../budget/costs.ts";

/** A token bucket: `units` capacity, refilling fully every `seconds` (≤ 60). */
export type RateWindow = { readonly units: number; readonly seconds: number };
/** Hard ceilings on units granted inside any sliding 24 h (`day`) and 31 days (`month`). */
export type SpendCap = { readonly day?: number; readonly month?: number };

/** How one provider account is billed (`costs`) and how much of it we may spend (`rate`, `cap`). */
export type Account = {
  readonly costs: CostModel;
  /** Our share of the provider's throttle: bursts are bounded by the depth, never by the bill. */
  readonly rate: ReadonlyArray<RateWindow>;
  /** Sliding spend ceilings in the account's own billing unit — what keeps a plan inside its quota. */
  readonly cap?: SpendCap;
  /**
   * The fraction (0 < f ≤ 1) of the account's minute-scale capacity one IP prefix may spend per
   * minute.
   */
  readonly clientShare: number;
  /**
   * The page the `rate`/`cap` numbers come from — for a POLICY row, the provider page that
   * publishes no rate.
   */
  readonly source: string;
};

const request = (units: number, source: string): CostModel => ({
  kind: "request",
  request: { units, source } satisfies CostRow,
});

// Basic $35/mo: 100k credits per calendar month, 300/min, overage $0.0005/credit (off). Rate: r =
// 3.5/s = 210/min (70 %), depth 84 ≥ the measured 81-call cold start: 84 + 210 = 294 ≤ 300 per
// 60 s. Cap: 0.8 × 100k/month ⇒ no overage; a tenth of that per day. clientShare 0.75: the
// account's whole minute is 210, so one cold start (81) is the floor — 142 calls/min per prefix.
const COINGECKO: Account = {
  costs: request(1, "https://www.coingecko.com/en/api/pricing"),
  rate: [{ units: 84, seconds: 24 }],
  cap: { day: 8000, month: 80_000 },
  clientShare: 0.75,
  source: "https://www.coingecko.com/en/api/pricing",
};
// Keyless public coins API, no published limit. POLICY: depth 150 ≥ the measured 87-call cold
// start. clientShare 0.75 = 337 calls/min per prefix (delta 3 ⇒ 87 calls = 261 ≤ 333).
const DEFILLAMA: Account = {
  costs: request(1, "https://docs.llama.fi/pro-api"),
  rate: [{ units: 150, seconds: 20 }],
  clientShare: 0.75,
  source: "https://docs.llama.fi/pro-api",
};
// Standard (free): 5 calls per fixed 1 s window — r = 4/s, 1 + 4 = 5 per 1 s. No spend cap: the
// 0.15 % swap fee is paid on-chain by the user, not billed.
const ZEROX: Account = {
  costs: request(1, "https://docs.0x.org/docs/developer-resources/rate-limits"),
  rate: [{ units: 1, seconds: 0.25 }],
  clientShare: 0.05,
  source: "https://docs.0x.org/docs/developer-resources/rate-limits",
};
// No published limit. POLICY.
const ACROSS: Account = {
  costs: request(1, "https://docs.across.to/api-reference"),
  rate: [{ units: 10, seconds: 2 }],
  clientShare: 0.05,
  source: "https://docs.across.to/api-reference",
};

/**
 * One account per shared credential or public endpoint the gateway can spend: keyed providers are
 * named by their auth id, keyless ones by their provider id — the same egress IP makes them one
 * quota. `rate` is our own safe share of the provider's published throttle (rule: depth + refill×T
 * ≤ the provider's limit over its window T); `cap` is 0.8 × the plan's included quota (a tenth per
 * day), or the POLICY dollar ceiling for PAYG. Rows marked POLICY have no published limit and use a
 * conservative guess instead.
 */
export const PRODUCTION_ACCOUNTS: Readonly<Record<string, Account>> = {
  // PAYG $0.525/M CU (https://www.alchemy.com/docs/reference/pricing-plans); 10,000 CU/s over a
  // 10 s rolling window (https://www.alchemy.com/docs/reference/throughput): r = 6,000/s (60 %),
  // 36,000 + 6,000×10 = 96,000 ≤ 100,000 per 10 s, depth ≥ the 34,750-CU used-wallet cold start.
  // Ceilings POLICY $10/day, $100/month: floor(10e6/0.525) = 19,047,619 CU/day. Units are
  // max(billed CU, throughput CU) per method. Shared by every network's RPC, history's
  // alchemy_getAssetTransfers, approvals' eth_getLogs scans and the NFT routes' NFT API and DAS
  // calls. clientShare 0.1 = 36,000 CU/min per prefix ≥ 3 × the 7,150-CU fresh cold start, and the
  // 34,750-CU used one fits once.
  alchemy: {
    costs: ALCHEMY_COSTS,
    rate: [{ units: 36_000, seconds: 6 }],
    cap: { day: 19_047_619, month: 190_476_190 },
    clientShare: 0.1,
    source: "https://www.alchemy.com/docs/reference/pricing-plans",
  },
  // Pro $49/mo: 163M CU pool, 300 RPS, 20 CU/request (https://drpc.org/pricing). Rate: r = 100/s,
  // 200 + 100 = 300 ≤ 300 per 1 s, depth 200 = the measured all-used cold volley. Cap: 0.8 × 163M
  // / 20 = 6,520,000 requests/month, a tenth per day. clientShare 0.05 = 300 calls/min per prefix
  // ≥ the volley.
  drpc: {
    costs: request(1, "https://drpc.org/pricing"),
    rate: [{ units: 200, seconds: 2 }],
    cap: { day: 652_000, month: 6_520_000 },
    clientShare: 0.05,
    source: "https://drpc.org/pricing",
  },
  // Basic $40/mo subscription: 500k credits per period
  // (https://blockstream.com/blockchain-data-explorer-api). One credit per call POLICY (only
  // QuickSync is priced). Rate POLICY: no rate published; depth 1,000 ≥ the measured 412-call
  // used-wallet cold start. Cap: 0.8 × 500k/month, a tenth per day. clientShare 0.25 = 1,000
  // calls/min per prefix.
  blockstream: {
    costs: request(1, "https://blockstream.com/blockchain-data-explorer-api"),
    rate: [{ units: 1000, seconds: 15 }],
    cap: { day: 40_000, month: 400_000 },
    clientShare: 0.25,
    source: "https://blockstream.com/blockchain-data-explorer-api",
  },
  // Freemium $0 (sign in, never top up): 200M credits/month, ≈1,800 req/min, 200 credits per EVM
  // call (https://www.ankr.com/docs/rpc-service/service-plans/). Rate: r = 4,800 credits/s, 72,000
  // + 288,000 = 360,000 credits = 1,800 calls per 60 s. Cap: 0.8 × 200M/month, a tenth per day.
  ankr: {
    costs: request(200, "https://www.ankr.com/docs/rpc-service/service-plans/"),
    rate: [{ units: 72_000, seconds: 15 }],
    cap: { day: 16_000_000, month: 160_000_000 },
    clientShare: 0.05,
    source: "https://www.ankr.com/docs/rpc-service/service-plans/",
  },
  // Free (the only plan sold today: billing config billing_enabled false): 3M credits per UTC
  // day, 500 credits/s (https://www.trongrid.io/price). Credits per path from
  // https://www.trongrid.io/creditCosts. Rate: 250 + 250 = 500 per 1 s, depth ≥ the dearest path
  // (200). Cap: 0.8 × the daily quota — the quota resets daily, so there is no month cap.
  trongrid: {
    costs: TRONGRID_COSTS,
    rate: [{ units: 250, seconds: 1 }],
    cap: { day: 2_400_000 },
    clientShare: 0.1,
    source: "https://www.trongrid.io/price",
  },
  // Starter $49/mo: 4M credits/month, 200 RPS, auto-upgrade OFF (https://tatum.io/pricing). 5
  // credits per TRON call POLICY (2 standard, 5 eth_call; TRON paths are not listed). Rate: r =
  // 800 credits/s = 160 calls/s, 200 + 800 = 1,000 credits = 200 calls per 1 s, depth 40 calls ≥
  // the measured 15. Cap: 0.8 × 4M/month, a tenth per day.
  tatum: {
    costs: request(5, "https://docs.tatum.io/docs/rpc-nodes"),
    rate: [{ units: 200, seconds: 0.25 }],
    cap: { day: 320_000, month: 3_200_000 },
    clientShare: 0.1,
    source: "https://tatum.io/pricing",
  },
  // Basic $35/mo, 100k credits per calendar month, 300/min — derivation on the shared const.
  coingecko: COINGECKO,
  // Keyless public coins API, no published limit. POLICY.
  defillama: DEFILLAMA,
  // Standard free, 5 calls per fixed 1 s window.
  "0x": ZEROX,
  // Free 1 RPS = 60 per sliding 60 s, per organisation: r = 48/min, 12 + 48 = 60. One client
  // prefix may spend a quarter of it (12 calls/min).
  jupiter: {
    costs: request(1, "https://developers.jup.ag/docs/portal/rate-limits"),
    rate: [{ units: 12, seconds: 15 }],
    clientShare: 0.25,
    source: "https://developers.jup.ag/docs/portal/rate-limits",
  },
  // No published limit. POLICY.
  across: ACROSS,
};

/**
 * Staging providers are keyless public endpoints — the quota is whoever shares the endpoint, so the
 * budget is only our own conservative share: POLICY 10 req/s for every public RPC/Esplora node (no
 * published limits; 1rpc was observed answering 429s).
 */
const PUBLIC_ENDPOINT_RATE: ReadonlyArray<RateWindow> = [{ units: 20, seconds: 2 }];
const publicEndpoint = (source: string): Account => ({
  costs: request(1, source),
  rate: PUBLIC_ENDPOINT_RATE,
  // 300 calls/min per prefix: staging Bitcoin's 200-call cold start fits once — not three times;
  // we do not raise budgets on third parties' public endpoints to buy that headroom.
  clientShare: 0.5,
  source,
});

export const STAGING_ACCOUNTS: Readonly<Record<string, Account>> = {
  publicnode: publicEndpoint("https://publicnode.com"),
  "1rpc": publicEndpoint("https://1rpc.io"),
  base: publicEndpoint("https://base.org"),
  zan: publicEndpoint("https://zan.top"),
  nodies: publicEndpoint("https://nodies.app"),
  hyperliquid: publicEndpoint("https://hyperliquid.xyz"),
  chainlink: publicEndpoint("https://chain.link"),
  avalanche: publicEndpoint("https://avax.network"),
  robinhood: publicEndpoint("https://chain.robinhood.com"),
  drpc: publicEndpoint("https://drpc.org"),
  onfinality: publicEndpoint("https://onfinality.io"),
  arc: publicEndpoint("https://arc.network"),
  xlayer: publicEndpoint("https://xlayer.tech"),
  mantle: publicEndpoint("https://mantle.xyz"),
  "gateway-fm": publicEndpoint("https://gateway.fm"),
  unichain: publicEndpoint("https://unichain.org"),
  sei: publicEndpoint("https://sei.io"),
  linea: publicEndpoint("https://linea.build"),
  celo: publicEndpoint("https://celo.org"),
  sonic: publicEndpoint("https://soniclabs.com"),
  zksync: publicEndpoint("https://zksync.io"),
  soneium: publicEndpoint("https://soneium.org"),
  apechain: publicEndpoint("https://apechain.com"),
  ink: publicEndpoint("https://inkonchain.com"),
  frax: publicEndpoint("https://frax.com"),
  bnbchain: publicEndpoint("https://bnbchain.org"),
  zora: publicEndpoint("https://zora.energy"),
  tatum: publicEndpoint("https://tatum.io"),
  // Nile keyless 100 credits/s, metered in TronGrid credits per path. POLICY: r = 80 credits/s,
  // depth 200 = one dearest-path call must fit. Source page publishes no rate.
  trongrid: {
    costs: TRONGRID_COSTS,
    rate: [{ units: 200, seconds: 2.5 }],
    clientShare: 0.5,
    source: "https://nile.trongrid.io",
  },
  nileex: publicEndpoint("https://nileex.io"),
  blockstream: publicEndpoint("https://blockstream.info"),
  emzy: publicEndpoint("https://mempool.emzy.de"),
  coingecko: COINGECKO,
  defillama: DEFILLAMA,
  "0x": ZEROX,
  // Keyless 0.5 RPS = 30/min sliding: r = 24/min, 6 + 24 = 30. One client prefix may spend half of
  // it (12 calls/min).
  jupiter: {
    costs: request(1, "https://developers.jup.ag/docs/portal/rate-limits"),
    rate: [{ units: 6, seconds: 15 }],
    clientShare: 0.5,
    source: "https://developers.jup.ag/docs/portal/rate-limits",
  },
  across: ACROSS,
};
