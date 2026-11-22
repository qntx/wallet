import type { CostModel, CostRow } from "../budget/costs.ts";
import { ALCHEMY_COSTS } from "../budget/costs.ts";

/**
 * A provider account's spending window: a token bucket of `units` capacity that refills fully every
 * `seconds`. `units` are the account's own metering unit (compute units or request credits).
 */
export type BudgetWindow = { readonly units: number; readonly seconds: number };

/** How one provider account is billed (`costs`) and how much of it we may spend (`budget`). */
export type Account = {
  readonly costs: CostModel;
  readonly budget: ReadonlyArray<BudgetWindow>;
  /**
   * The fraction (0 < f ≤ 1) of the account's minute-scale capacity one IP prefix may spend per
   * minute. Windows longer than a minute cap the shared budget only — they are not part of the
   * per-prefix share.
   */
  readonly clientShare: number;
  /**
   * The page the `budget` numbers come from — for a POLICY row, the provider page that publishes no
   * rate.
   */
  readonly source: string;
};

const request = (units: number, source: string): CostModel => ({
  kind: "request",
  request: { units, source } satisfies CostRow,
});

// "1 call = 1 credit"; assumes Analyst 500/min and 500k/month (≈16,129/day); 80 % plus a daily
// share of the monthly cap.
const COINGECKO: Account = {
  costs: request(1, "https://www.coingecko.com/en/api/pricing"),
  budget: [
    { units: 400, seconds: 60 },
    { units: 15_000, seconds: 86_400 },
  ],
  clientShare: 0.05,
  source: "https://www.coingecko.com/en/api/pricing",
};
// Only the Pro tier publishes a limit. POLICY.
const DEFILLAMA: Account = {
  costs: request(1, "https://docs.llama.fi/pro-api"),
  budget: [{ units: 10, seconds: 2 }],
  clientShare: 0.05,
  source: "https://docs.llama.fi/pro-api",
};
// Free tier ≈5 RPS; 80 %.
const ZEROX: Account = {
  costs: request(1, "https://docs.0x.org/docs/developer-resources/rate-limits"),
  budget: [{ units: 8, seconds: 2 }],
  clientShare: 0.05,
  source: "https://docs.0x.org/docs/developer-resources/rate-limits",
};
// No published limit. POLICY.
const ACROSS: Account = {
  costs: request(1, "https://docs.across.to/api-reference"),
  budget: [{ units: 10, seconds: 2 }],
  clientShare: 0.05,
  source: "https://docs.across.to/api-reference",
};

/**
 * One account per shared credential or public endpoint the gateway can spend: keyed providers are
 * named by their auth id, keyless ones by their provider id — the same egress IP makes them one
 * quota. The budget is our own safe share of the provider's published rate (usually ~80 %); rows
 * marked POLICY have no published limit and use a conservative guess instead.
 */
export const PRODUCTION_ACCOUNTS: Readonly<Record<string, Account>> = {
  // PAYG 10,000 throughput CU/s; budget is 80 % = 8,000/s. Shared by every network's RPC and by
  // history's alchemy_getAssetTransfers.
  alchemy: {
    costs: ALCHEMY_COSTS,
    budget: [{ units: 40_000, seconds: 5 }],
    clientShare: 0.05,
    source: "https://www.alchemy.com/docs/reference/pricing-plans",
  },
  // Assumes the PAYG plan for accounts created after 2026-10-19: 100 RPS, and rate limiting bills
  // every call at least one request unit. 80 % = 400 calls/5 s; the plan itself is an operator
  // assumption.
  drpc: {
    costs: request(1, "https://drpc.org/docs/howitworks/ratelimiting"),
    budget: [{ units: 400, seconds: 5 }],
    clientShare: 0.05,
    source: "https://drpc.org/docs/howitworks/ratelimiting",
  },
  // One credit per call. POLICY: the page sells prepaid credit packs and publishes no rate;
  // the numbers are re-sized in a later layer.
  blockstream: {
    costs: request(1, "https://blockstream.info/explorer-api"),
    budget: [{ units: 10, seconds: 2 }],
    clientShare: 0.05,
    source: "https://blockstream.info/explorer-api",
  },
  // Rate: 80 % of the Freemium/Public "≈1800 reqs/min — guaranteed" (24 req/s = 120/5 s). Day:
  // Freemium 200M API credits/month ÷ 200 credits per EVM request ÷ 30 × 80 % ≈ 26,666 → 26,000.
  // POLICY: the operator confirms the plan; `x-api-key` header auth is still unverified with a
  // real key (operator step).
  ankr: {
    costs: request(1, "https://www.ankr.com/docs/rpc-service/service-plans/"),
    budget: [
      { units: 120, seconds: 5 },
      { units: 26_000, seconds: 86_400 },
    ],
    clientShare: 0.05,
    source: "https://www.ankr.com/docs/rpc-service/service-plans/",
  },
  // Day: 80 % of the Basic plan's published 100,000 requests/day. Rate POLICY: TronGrid publishes
  // no keyed QPS (https://developers.tron.network/reference/rate-limits says "Do not hard-code
  // fixed limits"), only that keyless requests get 3 QPS
  // (https://www.trongrid.io/changeLog/v1-10-0) and keyed ones are not lower — 80 % of 3 QPS is at
  // or below the free tier. Operator: read the key's QPS in the TronGrid console to raise it.
  // 12 calls/5 s = 144/min × 0.1 = 14 calls/min/prefix.
  trongrid: {
    costs: request(1, "https://developers.tron.network/reference/rate-limits"),
    budget: [
      { units: 12, seconds: 5 },
      { units: 80_000, seconds: 86_400 },
    ],
    clientShare: 0.1,
    source: "https://www.trongrid.io/price",
  },
  // Rate: 80 % of the Free plan's 3 RPS — the lowest published plan rate, at or below every plan.
  // Day: Starter 4M credits/month ÷ 30 ÷ 5 credits per call (worst case: `eth_call`-class methods
  // cost 5, standard 2) × 80 % ≈ 21,333 → 21,000. Operator: confirm a paid plan (Starter or
  // above) and turn off auto-upgrade. 12 calls/5 s = 144/min × 0.1 = 14 calls/min/prefix.
  tatum: {
    costs: request(1, "https://docs.tatum.io/docs/rpc-nodes"),
    budget: [
      { units: 12, seconds: 5 },
      { units: 21_000, seconds: 86_400 },
    ],
    clientShare: 0.1,
    source: "https://docs.tatum.io/docs/plans-limits",
  },
  // "1 call = 1 credit"; assumes Analyst 500/min and 500k/month (≈16,129/day); 80 % plus a daily
  // share of the monthly cap.
  coingecko: COINGECKO,
  // Only the Pro tier publishes a limit. POLICY.
  defillama: DEFILLAMA,
  // Free tier ≈5 RPS; 80 %.
  "0x": ZEROX,
  // Keyed Free plan 1 RPS; 80 % = 4 calls per 5 s = 48/min, and one client prefix may spend a
  // quarter of it (12 calls/min).
  jupiter: {
    costs: request(1, "https://developers.jup.ag/docs/portal/rate-limits"),
    budget: [{ units: 4, seconds: 5 }],
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
const PUBLIC_ENDPOINT_BUDGET: ReadonlyArray<BudgetWindow> = [{ units: 20, seconds: 2 }];
const publicEndpoint = (source: string): Account => ({
  costs: request(1, source),
  budget: PUBLIC_ENDPOINT_BUDGET,
  clientShare: 0.05,
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
  trongrid: publicEndpoint("https://nile.trongrid.io"),
  nileex: publicEndpoint("https://nileex.io"),
  blockstream: publicEndpoint("https://blockstream.info"),
  emzy: publicEndpoint("https://mempool.emzy.de"),
  coingecko: COINGECKO,
  defillama: DEFILLAMA,
  "0x": ZEROX,
  // Keyless 0.5 RPS; 80 % = 2 calls per 5 s = 24/min, and one client prefix may spend half of it
  // (12 calls/min).
  jupiter: {
    costs: request(1, "https://developers.jup.ag/docs/portal/rate-limits"),
    budget: [{ units: 2, seconds: 5 }],
    clientShare: 0.5,
    source: "https://developers.jup.ag/docs/portal/rate-limits",
  },
  across: ACROSS,
};
