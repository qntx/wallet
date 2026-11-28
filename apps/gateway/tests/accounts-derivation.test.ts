// oxlint-disable vitest/no-conditional-in-test -- a table row without a published limit or volley is the POLICY case
// oxlint-disable vitest/no-conditional-expect -- POLICY rows skip the published-limit assertions
/**
 * Every production account row, re-derived from the inputs its evidence page publishes (fetched
 * 2026-11-28, copies in the audit's evidence directory). The table transcribes the inputs; the
 * assertions compute the R1/R2 formulas from them — nothing is a copied literal. POLICY rows (no
 * published limit) assert literal equality only.
 */
import { describe, expect, it } from "vite-plus/test";

import { ALCHEMY_COSTS, TRONGRID_COSTS } from "../src/budget/costs.ts";
import { PRODUCTION_ACCOUNTS } from "../src/config/accounts.ts";

type Derivation = {
  /** The page the inputs were transcribed from. */
  readonly evidence: string;
  /** The provider's published rate limit in its own unit, over `windowSeconds`. */
  readonly limit?: number;
  readonly windowSeconds?: number;
  /** The included quota the cap derives from, in the account's billing unit. */
  readonly quota?: number;
  /**
   * Provider quota units per account unit — 1 unless the quota counts a different unit (dRPC's pool
   * is in CU while the account meters requests).
   */
  readonly perCall?: number;
  /** The measured cold-start volley the rate depth must absorb (account units), where published. */
  readonly volley?: number;
  /** True when the account can bill real money — it must carry both caps. */
  readonly bills: boolean;
  readonly rate: ReadonlyArray<{ readonly units: number; readonly seconds: number }>;
  readonly cap?: { readonly day?: number; readonly month?: number };
};

const DERIVATIONS: Readonly<Record<string, Derivation>> = {
  alchemy: {
    // PAYG $0.525/M CU; 10,000 CU/s over a 10 s rolling window. Ceilings POLICY $10/day $100/month.
    evidence: "https://www.alchemy.com/docs/reference/pricing-plans",
    limit: 10_000 * 10, // CU per 10 s window
    windowSeconds: 10,
    volley: 34_750,
    bills: true,
    rate: [{ units: 36_000, seconds: 6 }],
    cap: { day: 19_047_619, month: 190_476_190 },
  },
  drpc: {
    // Pro $49/mo: 163M CU pool, 300 RPS, 20 CU/request.
    evidence: "https://drpc.org/pricing",
    limit: 300, // requests per 1 s (300 RPS ÷ 20 CU/req is not the limit — the RPS is)
    windowSeconds: 1,
    quota: 163_000_000, // CU pool
    perCall: 20, // CU per request
    volley: 200,
    bills: true,
    rate: [{ units: 200, seconds: 2 }],
    cap: { day: 652_000, month: 6_520_000 },
  },
  blockstream: {
    // Basic $40/mo: 500k credits per period. Rate POLICY — none published.
    evidence: "https://blockstream.com/blockchain-data-explorer-api",
    quota: 500_000,
    perCall: 1,
    volley: 412,
    bills: true,
    rate: [{ units: 1000, seconds: 15 }],
    cap: { day: 40_000, month: 400_000 },
  },
  coingecko: {
    // Basic $35/mo: 100k credits per calendar month, 300/min.
    evidence: "https://www.coingecko.com/en/api/pricing",
    limit: 300, // credits per 60 s
    windowSeconds: 60,
    quota: 100_000,
    perCall: 1,
    volley: 81,
    bills: true,
    rate: [{ units: 84, seconds: 24 }],
    cap: { day: 8000, month: 80_000 },
  },
  tatum: {
    // Starter $49/mo: 4M credits/month, 200 RPS. 5 credits per call POLICY.
    evidence: "https://tatum.io/pricing",
    limit: 200 * 5, // credits per 1 s: 200 calls × 5 credits
    windowSeconds: 1,
    quota: 4_000_000,
    perCall: 1,
    volley: 15 * 5, // 15 calls at 5 credits
    bills: true,
    rate: [{ units: 200, seconds: 0.25 }],
    cap: { day: 320_000, month: 3_200_000 },
  },
  ankr: {
    // Freemium: 200M credits/month, ≈1,800 req/min, 200 credits per EVM call.
    evidence: "https://www.ankr.com/docs/rpc-service/service-plans/",
    limit: 1800 * 200, // credits per 60 s
    windowSeconds: 60,
    quota: 200_000_000,
    perCall: 1,
    bills: false,
    rate: [{ units: 72_000, seconds: 15 }],
    cap: { day: 16_000_000, month: 160_000_000 },
  },
  trongrid: {
    // Free: 3M credits per UTC day, 500 credits/s. Quota is daily — no month cap.
    evidence: "https://www.trongrid.io/price",
    limit: 500, // credits per 1 s
    windowSeconds: 1,
    volley: 200, // the dearest allow-listed path
    bills: false,
    rate: [{ units: 250, seconds: 1 }],
    cap: { day: 2_400_000 },
  },
  jupiter: {
    // Free 1 RPS = 60 per sliding 60 s.
    evidence: "https://developers.jup.ag/docs/portal/rate-limits",
    limit: 60,
    windowSeconds: 60,
    bills: false,
    rate: [{ units: 12, seconds: 15 }],
  },
  "0x": {
    // Standard free: 5 per fixed 1 s window.
    evidence: "https://docs.0x.org/docs/developer-resources/rate-limits",
    limit: 5,
    windowSeconds: 1,
    bills: false,
    rate: [{ units: 1, seconds: 0.25 }],
  },
  // POLICY rows: no published limit, literal equality only.
  defillama: {
    evidence: "https://docs.llama.fi/pro-api",
    volley: 87,
    bills: false,
    rate: [{ units: 150, seconds: 20 }],
  },
  across: {
    evidence: "https://docs.across.to/api-reference",
    bills: false,
    rate: [{ units: 10, seconds: 2 }],
  },
};

describe("production account derivations", () => {
  it("the table covers exactly the production accounts", () => {
    expect(Object.keys(DERIVATIONS).toSorted()).toStrictEqual(
      Object.keys(PRODUCTION_ACCOUNTS).toSorted(),
    );
  });

  describe.each(Object.entries(DERIVATIONS))("%s", (id, row) => {
    const account = PRODUCTION_ACCOUNTS[id]!;

    it("carries the derived rate and cap", () => {
      expect(account.rate).toStrictEqual(row.rate);
      expect(account.cap).toStrictEqual(row.cap);
    });

    it("R1: depth + refill over the provider window stays inside the published limit", () => {
      const depth = Math.max(...row.rate.map((w) => w.units));
      if (row.volley !== undefined) {
        expect(depth).toBeGreaterThanOrEqual(row.volley);
      }
      if (row.limit === undefined || row.windowSeconds === undefined) {
        // POLICY row: no published limit, literal equality is all there is.
        return;
      }
      for (const window of row.rate) {
        const refill = window.units / window.seconds;
        expect(window.units + refill * row.windowSeconds).toBeLessThanOrEqual(row.limit);
      }
    });

    it("R2: the cap is 0.8 × the quota (a tenth per day), or the PAYG ceiling", () => {
      if (row.cap === undefined) {
        return;
      }
      if (row.quota !== undefined && row.perCall !== undefined) {
        expect(row.cap.month).toBe((0.8 * row.quota) / row.perCall);
      }
    });

    it("a day cap is a tenth of the month cap", () => {
      if (account.cap?.month !== undefined) {
        expect(account.cap.day).toBe(Math.floor(account.cap.month / 10));
      }
    });

    it("an account that can bill carries both caps", () => {
      if (row.bills) {
        expect(account.cap?.day).toBeGreaterThan(0);
        expect(account.cap?.month).toBeGreaterThan(0);
      }
    });
  });

  it("alchemy: the PAYG ceiling buys exactly the derived caps at $0.525/M CU", () => {
    // floor(ceiling$ / price) with integer math: $10/day at 0.525 $/M CU.
    const day = Math.floor((10 * 1e9) / 525);
    const month = Math.floor((100 * 1e9) / 525);
    expect(PRODUCTION_ACCOUNTS["alchemy"]?.cap).toStrictEqual({ day, month });
    // A month at the cap never costs more than the $100 ceiling: month × 0.525/1e6 $ ≤ 100.
    expect((month * 525) / 1e9).toBeLessThanOrEqual(100);
    expect((day * 525) / 1e9).toBeLessThanOrEqual(10);
  });

  it("drpc: the 163M CU pool at 20 CU/request buys exactly the derived caps", () => {
    const month = (0.8 * 163_000_000) / 20;
    expect(month).toBe(6_520_000);
    expect(PRODUCTION_ACCOUNTS["drpc"]?.cap).toStrictEqual({ day: month / 10, month });
  });

  it("trongrid: the daily quota caps the day, and no month cap exists", () => {
    expect(0.8 * 3_000_000).toBe(2_400_000);
    expect(PRODUCTION_ACCOUNTS["trongrid"]?.cap).toStrictEqual({ day: 2_400_000 });
  });
});

/**
 * Alchemy's compute-unit-costs page transcribed per method: [billed CU, throughput CU]. No second
 * element where the page lists no throughput column. Evidence: the audit's alchemy-cu-costs.md
 * (EVM/Solana standard, Solana DAS, NFT API, Transfers tables), fetched 2026-11-28.
 */
const ALCHEMY_PAGE: Readonly<Record<string, readonly [number, number?]>> = {
  // EVM standard JSON-RPC.
  eth_blobBaseFee: [10],
  eth_blockNumber: [10],
  eth_call: [26],
  eth_chainId: [0, 5],
  eth_createAccessList: [10],
  eth_estimateGas: [20],
  eth_feeHistory: [10],
  eth_gasPrice: [20],
  eth_getBalance: [20],
  eth_getBlockByHash: [20],
  eth_getBlockByNumber: [20],
  eth_getBlockReceipts: [20, 500],
  eth_getBlockTransactionCountByHash: [20],
  eth_getBlockTransactionCountByNumber: [20],
  eth_getCode: [20],
  eth_getLogs: [60],
  eth_getProof: [20],
  eth_getStorageAt: [20],
  eth_getTransactionByBlockHashAndIndex: [20],
  eth_getTransactionByBlockNumberAndIndex: [20],
  eth_getTransactionByHash: [20],
  eth_getTransactionCount: [20],
  eth_getTransactionReceipt: [20],
  eth_maxPriorityFeePerGas: [10],
  eth_sendRawTransaction: [40, 50],
  eth_simulateV1: [40],
  net_version: [0, 5],
  web3_clientVersion: [20],
  // Solana standard JSON-RPC.
  getAccountInfo: [10],
  getBalance: [10],
  getBlockHeight: [20],
  getBlockTime: [20],
  getEpochInfo: [20],
  getFeeForMessage: [20],
  getFirstAvailableBlock: [40],
  getGenesisHash: [10],
  getLatestBlockhash: [20],
  getMinimumBalanceForRentExemption: [10],
  getMultipleAccounts: [20],
  getRecentPrioritizationFees: [10],
  getSignatureStatuses: [20],
  getSignaturesForAddress: [40],
  getSlot: [20],
  getStakeMinimumDelegation: [20],
  getTokenAccountBalance: [20],
  getTokenAccountsByOwner: [10],
  getTokenSupply: [20],
  getTransaction: [40],
  getVersion: [20],
  getVoteAccounts: [20],
  isBlockhashValid: [20],
  sendTransaction: [20],
  simulateTransaction: [20],
  // Transfers API.
  alchemy_getAssetTransfers: [120],
  // NFT API.
  getNFTsForOwner: [480, 100],
  getNFTMetadata: [80, 10],
  getContractMetadata: [160, 10],
  getFloorPrice: [80, 10],
  // Solana DAS.
  getAssetsByOwner: [480, 200],
  getAsset: [80, 200],
};

describe("alchemy cost rows", () => {
  const rows: Readonly<Record<string, number>> = {
    ...Object.fromEntries(
      Object.entries(ALCHEMY_COSTS.kind === "rpc" ? ALCHEMY_COSTS.methods : {}).map(
        ([method, row]) => [method, row.units],
      ),
    ),
    ...(ALCHEMY_COSTS.kind === "rpc" && ALCHEMY_COSTS.transfers !== undefined
      ? { alchemy_getAssetTransfers: ALCHEMY_COSTS.transfers.units }
      : {}),
    ...Object.fromEntries(
      Object.entries(ALCHEMY_COSTS.kind === "rpc" ? (ALCHEMY_COSTS.nfts ?? {}) : {}).map(
        ([method, row]) => [method, row.units],
      ),
    ),
  };

  it("the transcription covers exactly the cost table's methods", () => {
    expect(Object.keys(rows).toSorted()).toStrictEqual(Object.keys(ALCHEMY_PAGE).toSorted());
  });

  it.each(Object.entries(ALCHEMY_PAGE))("%s is max(billed CU, throughput CU)", (method, pair) => {
    const [billed, throughput] = pair;
    expect(rows[method]).toBe(Math.max(billed, throughput ?? billed));
  });
});

/**
 * TronGrid's per-method Credit costs (https://www.trongrid.io/creditCosts, fetched 2026-11-28),
 * transcribed for the gateway's allow-listed paths. The gateway's engine-named indexer keys map
 * onto TronGrid's `/v1/accounts/{address}` routes.
 */
const TRONGRID_PAGE: Readonly<Record<string, number>> = {
  "/wallet/getnowblock": 80,
  "/walletsolidity/getnowblock": 80,
  "/wallet/getblockbynum": 80,
  "/walletsolidity/getblockbynum": 80,
  "/wallet/getaccount": 80,
  "/wallet/getavailableunfreezecount": 80,
  "/wallet/getcandelegatedmaxsize": 80,
  "/wallet/getdelegatedresourcev2": 80,
  "/wallet/getReward": 80,
  "/wallet/getassetissuebyid": 80,
  "/wallet/listwitnesses": 150,
  "/wallet/getaccountresource": 80,
  "/wallet/getchainparameters": 80,
  "/wallet/triggerconstantcontract": 80,
  "/wallet/broadcasthex": 80,
  "/wallet/gettransactionbyid": 80,
  "/wallet/gettransactioninfobyid": 80,
  "/walletsolidity/gettransactioninfobyid": 80,
  // /v1/accounts/{address}/transactions — the engine drops the address segment in its own names.
  "/v1/accounts/transactions": 160,
  "/v1/accounts/transactions/trc20": 200,
  "/v1/accounts/account": 80,
};

describe("trongrid cost rows", () => {
  it("every path row equals the transcribed Credit cost", () => {
    if (TRONGRID_COSTS.kind !== "tron") {
      throw new Error("TRONGRID_COSTS is not tron-priced");
    }
    expect(Object.keys(TRONGRID_COSTS.paths).toSorted()).toStrictEqual(
      Object.keys(TRONGRID_PAGE).toSorted(),
    );
    for (const [path, credits] of Object.entries(TRONGRID_PAGE)) {
      const key = path as keyof typeof TRONGRID_COSTS.paths;
      expect(TRONGRID_COSTS.paths[key]?.units).toBe(credits);
    }
  });

  it("every row cites the credit-costs page", () => {
    if (TRONGRID_COSTS.kind !== "tron") {
      throw new Error("TRONGRID_COSTS is not tron-priced");
    }
    for (const row of Object.values(TRONGRID_COSTS.paths)) {
      expect(row.source).toBe("https://www.trongrid.io/creditCosts");
    }
  });
});
