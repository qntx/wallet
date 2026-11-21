import type { CostModel, CostRow } from "../budget/costs.ts";
import { ALCHEMY_COSTS, DRPC_COSTS } from "../budget/costs.ts";

/**
 * A provider account's spending window: a token bucket of `units` capacity that refills fully every
 * `seconds`. `units` are the account's own metering unit (compute units or request credits).
 */
export type BudgetWindow = { readonly units: number; readonly seconds: number };

/** How one provider account is billed (`costs`) and how much of it we may spend (`budget`). */
export type Account = {
  readonly costs: CostModel;
  readonly budget: ReadonlyArray<BudgetWindow>;
};

const request = (units: number, source: string): CostModel => ({
  kind: "request",
  request: { units, source } satisfies CostRow,
});

// https://www.coingecko.com/en/api/pricing — "1 call = 1 credit"; assumes Analyst 500/min and
// 500k/month (≈16,129/day); 80 % plus a daily share of the monthly cap.
const COINGECKO: Account = {
  costs: request(1, "https://www.coingecko.com/en/api/pricing"),
  budget: [
    { units: 400, seconds: 60 },
    { units: 15_000, seconds: 86_400 },
  ],
};
// https://docs.llama.fi/pro-api — only the Pro tier publishes a limit. POLICY.
const DEFILLAMA: Account = {
  costs: request(1, "https://docs.llama.fi/pro-api"),
  budget: [{ units: 10, seconds: 2 }],
};
// https://docs.0x.org/docs/developer-resources/rate-limits — free tier ≈5 RPS; 80 %.
const ZEROX: Account = {
  costs: request(1, "https://docs.0x.org/docs/developer-resources/rate-limits"),
  budget: [{ units: 8, seconds: 2 }],
};
// https://docs.across.to/api-reference — no published limit. POLICY.
const ACROSS: Account = {
  costs: request(1, "https://docs.across.to/api-reference"),
  budget: [{ units: 10, seconds: 2 }],
};

/**
 * One account per shared credential or public endpoint the gateway can spend: keyed providers are
 * named by their auth id, keyless ones by their provider id — the same egress IP makes them one
 * quota. The budget is our own safe share of the provider's published rate (usually ~80 %); rows
 * marked POLICY have no published limit and use a conservative guess instead.
 */
export const PRODUCTION_ACCOUNTS: Readonly<Record<string, Account>> = {
  // https://www.alchemy.com/docs/reference/pricing-plans — PAYG 10,000 throughput CU/s; budget is
  // 80 % = 8,000/s. Shared by every network's RPC and by history's alchemy_getAssetTransfers.
  alchemy: { costs: ALCHEMY_COSTS, budget: [{ units: 40_000, seconds: 5 }] },
  // https://drpc.org/docs/pricing/plans — assumes PAYG 100 RPS × 20 CU = 2,000 CU/s; 80 %. The
  // plan size is an operator assumption.
  drpc: { costs: DRPC_COSTS, budget: [{ units: 8000, seconds: 5 }] },
  // https://blockstream.info/explorer-api — one credit per call. POLICY: no published rate limit.
  blockstream: {
    costs: request(1, "https://blockstream.info/explorer-api"),
    budget: [{ units: 10, seconds: 2 }],
  },
  // https://www.coingecko.com/en/api/pricing — "1 call = 1 credit"; assumes Analyst 500/min and
  // 500k/month (≈16,129/day); 80 % plus a daily share of the monthly cap.
  coingecko: COINGECKO,
  // https://docs.llama.fi/pro-api — only the Pro tier publishes a limit. POLICY.
  defillama: DEFILLAMA,
  // https://docs.0x.org/docs/developer-resources/rate-limits — free tier ≈5 RPS; 80 %.
  "0x": ZEROX,
  // https://developers.jup.ag/docs/portal/rate-limits — keyed Free plan 1 RPS; 80 %.
  jupiter: {
    costs: request(1, "https://developers.jup.ag/docs/portal/rate-limits"),
    budget: [{ units: 4, seconds: 5 }],
  },
  // https://docs.across.to/api-reference — no published limit. POLICY.
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
  tatum: publicEndpoint("https://tatum.io"),
  blockstream: publicEndpoint("https://blockstream.info"),
  emzy: publicEndpoint("https://mempool.emzy.de"),
  coingecko: COINGECKO,
  defillama: DEFILLAMA,
  "0x": ZEROX,
  // https://developers.jup.ag/docs/portal/rate-limits — keyless 0.5 RPS; 80 %.
  jupiter: {
    costs: request(1, "https://developers.jup.ag/docs/portal/rate-limits"),
    budget: [{ units: 2, seconds: 5 }],
  },
  across: ACROSS,
};
