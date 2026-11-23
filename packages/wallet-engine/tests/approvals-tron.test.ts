/**
 * TRON chain reads → rows: TRC-20 allowances through `triggerconstantcontract`, account permissions
 * through `/wallet/getaccount` — and the indexer candidate source, paged by `meta.fingerprint`,
 * filtered to the owner's `Approval` rows and capped at five pages.
 */
import { describe, expect, it } from "vite-plus/test";

import { tronAddressFromHex } from "@qntx/wallet-chains/tron";

import { gatherCandidates, tronGatewayCandidates } from "../src/approvals/sources.ts";
import { tronApprovals } from "../src/approvals/tron.ts";
import type { TronReadDeps } from "../src/approvals/tron.ts";
import type { ApprovalRow } from "../src/approvals/types.ts";

const NETWORK = "tron:728126428";

const tronAddress = (seed: number): string =>
  tronAddressFromHex(`41${seed.toString(16).padStart(40, "0")}`);

const OWNER = tronAddress(0x01);
const SPENDER = tronAddress(0x02);
const TOKEN = tronAddress(0x03);
const FOREIGN = tronAddress(0x04);

const nowBlock = (number: number) => ({
  blockID: "ab".repeat(32),
  block_header: { raw_data: { number, timestamp: 1_800_000_000_000 } },
});

const callOk = (word: bigint) => ({
  result: { result: true },
  constant_result: [word.toString(16).padStart(64, "0")],
});

const accountRow = (over: Record<string, unknown> = {}) => ({
  address: OWNER,
  type: "Contract",
  ...over,
});

type Scripted = {
  readonly head?: number;
  /** `/wallet/getaccount` answers keyed by address; absent → undefined (absent account). */
  readonly accounts?: ReadonlyMap<string, unknown>;
  readonly posts?: Array<{ path: string; body: unknown }>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const api = (script: Scripted) => ({
  post: async (path: string, body: unknown) => {
    script.posts?.push({ path, body });
    if (path === "/wallet/getnowblock") {
      return Promise.resolve(nowBlock(script.head ?? 100));
    }
    if (path === "/wallet/getaccount") {
      const address = isObj(body) ? str(body["address"]) : "";
      return Promise.resolve(script.accounts?.get(address) ?? {});
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
});

const deps = (
  primary: ReturnType<typeof api>,
  independent:
    | { kind: "available"; source: "host"; client: ReturnType<typeof api> }
    | { kind: "unavailable" },
): TronReadDeps => ({
  networks: {
    tronApi: () => primary,
    independentTronApi: () => independent,
  },
  token: async () => Promise.resolve({ symbol: "USDT", decimals: 6 }),
  known: () => [],
});

const row = (rows: ReadonlyArray<ApprovalRow>, kind: ApprovalRow["kind"]) =>
  rows.find((r) => r.kind === kind);

/** Narrows a row to the variants carrying `field` — union narrowing in tests. */
const has = <F extends string>(
  r: ApprovalRow | undefined,
  f: F,
): (ApprovalRow & Record<F, unknown>) | undefined => (r !== undefined && f in r ? r : undefined);

/** An api answering allowance → `allowance` and balanceOf → `balance` on every contract call. */
const bySelector = (allowance: bigint, balance: bigint) => ({
  post: async (path: string, body: unknown) => {
    if (path === "/wallet/getnowblock") {
      return Promise.resolve(nowBlock(100));
    }
    if (path === "/wallet/getaccount") {
      const address = isObj(body) ? str(body["address"]) : "";
      return Promise.resolve(address === SPENDER ? { address: SPENDER, type: "Contract" } : {});
    }
    if (path === "/wallet/triggerconstantcontract") {
      const data = isObj(body) ? str(body["data"]) : "";
      return Promise.resolve(callOk(data.startsWith("dd62ed3e") ? allowance : balance));
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
});

describe("tron approvals reads", () => {
  it("a trc20 allowance reads and corroborates; exposure is balance-bounded", async () => {
    const result = await tronApprovals(
      deps(bySelector(200n, 500n), {
        kind: "available",
        source: "host",
        client: bySelector(200n, 500n),
      }),
      NETWORK,
      OWNER,
      gatherCandidates([
        { candidate: { kind: "trc20", token: TOKEN, spender: SPENDER }, source: "gateway" },
      ]),
    );
    const shown = row(result.rows, "trc20");
    expect(has(shown, "amount")?.amount).toBe("200");
    expect(has(shown, "exposure")?.exposure).toBe("200");
    expect(shown?.verified).toBe(true);
  });

  it("a permission holding a foreign key produces a tron-permission row", async () => {
    const script: Scripted = {
      accounts: new Map([
        [
          OWNER,
          accountRow({
            type: undefined,
            owner_permission: {
              permission_name: "owner",
              threshold: 2,
              keys: [
                { address: OWNER, weight: 1 },
                { address: FOREIGN, weight: 2 },
              ],
            },
          }),
        ],
      ]),
    };
    const result = await tronApprovals(
      deps(api(script), { kind: "unavailable" }),
      NETWORK,
      OWNER,
      [],
    );
    const shown = row(result.rows, "tron-permission");
    expect(shown).toMatchObject({
      kind: "tron-permission",
      keys: [
        { address: OWNER, weight: "1" },
        { address: FOREIGN, weight: "2" },
      ],
      threshold: "2",
    });
    expect(result.exhaustive).toStrictEqual(["tron-permission"]);
  });
});

const indexerRow = (over: Record<string, unknown>) => ({
  transaction_id: "cd".repeat(32),
  block_timestamp: 1_800_000_000_000,
  from: OWNER,
  to: SPENDER,
  type: "Approval",
  value: "100",
  token_info: { address: TOKEN, symbol: "USDT", decimals: 6 },
  ...over,
});

describe("tron indexer candidates", () => {
  const indexer = (pages: ReadonlyArray<{ data: unknown[]; fingerprint?: string }>) => {
    let page = 0;
    return {
      post: async (path: string, body: unknown) => {
        if (path !== "/v1/accounts/transactions/trc20") {
          return Promise.reject(new Error(`unmocked ${path}`));
        }
        const current = pages[Math.min(page, pages.length - 1)] ?? { data: [] };
        page += 1;
        void body;
        return Promise.resolve({
          success: true,
          data: current.data,
          meta: current.fingerprint === undefined ? {} : { fingerprint: current.fingerprint },
        });
      },
      pages: () => page,
    };
  };

  const networks = (endpoint: { post: (p: string, b: unknown) => Promise<unknown> }) =>
    ({
      tronApi: () => endpoint,
      gatewayFirst: () => true,
    }) as never;

  it("keeps the owner's Approval rows and ignores every other type", async () => {
    const feed = indexer([
      {
        data: [
          indexerRow({}),
          indexerRow({ type: "Transfer" }),
          indexerRow({ from: FOREIGN }),
          indexerRow({ token_info: {} }),
        ],
      },
    ]);
    const result = await tronGatewayCandidates(
      { networks: networks(feed), now: () => 0 },
      NETWORK,
      OWNER,
    );
    expect(result.status).toBe("ok");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.candidate).toStrictEqual({
      kind: "trc20",
      token: TOKEN,
      spender: SPENDER,
    });
  });

  it("follows fingerprints up to five pages, then truncates", async () => {
    const feed = indexer(
      Array.from({ length: 6 }, (_, i) => ({
        data: [indexerRow({ transaction_id: `${i}`.padStart(2, "0").repeat(32) })],
        fingerprint: `fp${i}`,
      })),
    );
    const result = await tronGatewayCandidates(
      { networks: networks(feed), now: () => 0 },
      NETWORK,
      OWNER,
    );
    expect(result.status).toBe("truncated");
    expect(feed.pages()).toBe(5);
    expect(result.candidates).toHaveLength(5);
  });

  it("a host-first network reports unavailable without an upstream call", async () => {
    const feed = indexer([{ data: [indexerRow({})] }]);
    const notGatewayFirst = {
      tronApi: () => feed,
      gatewayFirst: () => false,
    } as never;
    const result = await tronGatewayCandidates(
      { networks: notGatewayFirst, now: () => 0 },
      NETWORK,
      OWNER,
    );
    expect(result.status).toBe("unavailable");
    expect(feed.pages()).toBe(0);
  });
});
