/**
 * TRON balances: liquid TRX plus TRC-20/TRC-10 rows and the stake-resource view. TRC-20 reads are
 * per-contract `triggerconstantcontract`s (no canonical TRON Multicall); TRC-10 metadata comes from
 * `getassetissuebyid` with hex-encoded `name`/`abbr`; discovery comes from the TronGrid indexer
 * `/v1/accounts/account` — display-only — and only runs when the gateway serves the network.
 *
 * The recorded bodies are the same fixtures the gateway route tests replay (recorded by
 * apps/gateway/scripts/record-tron.ts against api.trongrid.io).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isTronAddress } from "@qntx/wallet-chains/tron";

import { AssetsController } from "../src/assets/controller.ts";
import type { AccountBalances } from "../src/assets/controller.ts";
import type { TronApi } from "../src/chains/tron.ts";
import { nativeAssetId, tokenAssetId } from "../src/gateway/contract/index.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const logger = { warn: () => {} };
const TRON_NET = "tron:728126428";
const NILE = "tron:3448148188";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const OWNER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";

// Recorded by apps/gateway/scripts/record-tron.ts — real node bodies, shared with the route tests.
const FIXTURES = resolve(import.meta.dirname, "../../../apps/gateway/tests/fixtures/tron");
const fixture = (dir: string, name: string): unknown =>
  (JSON.parse(readFileSync(resolve(FIXTURES, dir, `${name}.json`), "utf8")) as { body: unknown })
    .body;
const MAINNET = "mainnet-trongrid";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const wordHex = (v: bigint): string => v.toString(16).padStart(64, "0");

/** An ABI `string` return: offset word, length word, utf8 right-padded to a word. */
const textHex = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil(Math.max(bytes.length, 1) / 32) * 32);
  padded.set(bytes);
  return (
    wordHex(32n) +
    wordHex(BigInt(bytes.length)) +
    [...padded].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
};

const ok = (hex: string): unknown => ({
  result: { result: true },
  constant_result: hex === "" ? [] : [hex],
  energy_used: 0,
});
const fail = (): unknown => ({ result: { result: false } });

type Meta = { readonly decimals?: number; readonly symbol?: string; readonly name?: string };

type Answers = {
  readonly account?: unknown;
  readonly resource?: unknown;
  readonly reward?: unknown;
  readonly indexer?: unknown;
  readonly balances?: Readonly<Record<string, bigint | "revert">>;
  readonly meta?: Readonly<Record<string, Meta | "fail">>;
  readonly issues?: Readonly<Record<string, unknown>>;
};

type Call = { readonly path: string; readonly body: Record<string, unknown> };

const is = (body: Record<string, unknown>, selector: string): boolean =>
  typeof body["data"] === "string" && body["data"].startsWith(selector);

const tronApi = (answers: Answers, calls: Call[]): TronApi => ({
  post: async (path, body) => {
    const b = isObject(body) ? body : {};
    calls.push({ path, body: b });
    if (path === "/wallet/getaccount") {
      return Promise.resolve(answers.account ?? {});
    }
    if (path === "/wallet/getaccountresource") {
      return Promise.resolve(answers.resource ?? {});
    }
    if (path === "/wallet/getReward") {
      return Promise.resolve(answers.reward ?? {});
    }
    if (path === "/v1/accounts/account") {
      return Promise.resolve(answers.indexer ?? { success: true, data: [{}] });
    }
    if (path === "/wallet/getassetissuebyid") {
      return Promise.resolve(answers.issues?.[String(b["value"])] ?? {});
    }
    if (path === "/wallet/triggerconstantcontract") {
      const contract = String(b["contract_address"]);
      if (is(b, "70a08231")) {
        const balance = answers.balances?.[contract];
        return Promise.resolve(balance === "revert" ? fail() : ok(wordHex(balance ?? 0n)));
      }
      const meta = answers.meta?.[contract];
      if (meta === "fail" || meta === undefined) {
        return Promise.resolve(fail());
      }
      if (is(b, "313ce567")) {
        return Promise.resolve(
          meta.decimals === undefined ? fail() : ok(wordHex(BigInt(meta.decimals))),
        );
      }
      if (is(b, "95d89b41")) {
        return Promise.resolve(meta.symbol === undefined ? ok("") : ok(textHex(meta.symbol)));
      }
      if (is(b, "06fdde03")) {
        return Promise.resolve(meta.name === undefined ? ok("") : ok(textHex(meta.name)));
      }
      return Promise.resolve(fail());
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
});

/** A `getaccount` read held until `gate` resolves — for the lock-generation test. */
const gatedApi = (gate: Promise<void>, calls: Call[]): TronApi => ({
  post: async (path, body) => {
    calls.push({ path, body: isObject(body) ? body : {} });
    if (path === "/wallet/getaccount") {
      await gate;
      return accountBody();
    }
    if (path === "/wallet/triggerconstantcontract") {
      return is(isObject(body) ? body : {}, "70a08231") ? ok(wordHex(0n)) : fail();
    }
    return {};
  },
});

const make = (
  answers: Answers,
  calls: Call[],
  opts: { readonly gateway?: boolean; readonly network?: string } = {},
): AssetsController => {
  const store = createMemoryEngineStore();
  const network = opts.network ?? TRON_NET;
  return new AssetsController({
    ownBitcoinTxids: () => new Set(),
    networks: {
      info: (n: string) => (n === network ? { family: "tron" } : { family: "evm", chainId: 1 }),
      tronApi: () => tronApi(answers, calls),
    } as never,
    chains: { account: async () => Promise.reject(new Error("unmocked chains.account")) },
    openStore: async () => Promise.resolve(store),
    setTimer: () => () => {},
    logger,
    gateway:
      opts.gateway === true ? { url: "https://gateway.test", clientIds: {} as never } : undefined,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  });
};

const token = (balances: AccountBalances, address: string) =>
  balances.tokens.find((t) => t.address === address);

const metadataCalls = (calls: Call[]): Call[] =>
  calls.filter(
    (c) =>
      c.path === "/wallet/triggerconstantcontract" &&
      (is(c.body, "313ce567") || is(c.body, "95d89b41") || is(c.body, "06fdde03")),
  );

const accountBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: `41${"00".repeat(20)}`,
  balance: 123_456_789,
  ...extra,
});

describe("AssetsController tron balances", () => {
  it("reads the recorded account, resource and reward bodies into the account view", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        account: fixture(MAINNET, "account-holder"),
        resource: fixture(MAINNET, "accountresource"),
        reward: fixture(MAINNET, "getreward"),
        indexer: fixture(MAINNET, "v1-accounts-account"),
        issues: { "1002000": fixture(MAINNET, "assetissuebyid") },
        balances: { [USDT]: 4_201_000n },
        meta: {},
      },
      calls,
      { gateway: true },
    );
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    expect(balances.native).toBe("1577390314629046");
    expect(balances.tron).toStrictEqual({
      frozen: { bandwidth: "0", energy: "0" },
      unfreezing: [],
      delegatedOut: { bandwidth: "0", energy: "0" },
      delegatedIn: { bandwidth: "0", energy: "2000000" },
      votes: [],
      reward: "0",
      bandwidth: { free: { limit: 600, used: 0 }, staked: { limit: 0, used: 0 } },
      energy: { limit: 19, used: 0 },
      tronPower: { limit: 0, used: 0 },
    });
    expect(token(balances, USDT)).toStrictEqual({
      address: USDT,
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      balance: "4201000",
      verified: true,
      spam: [],
      hidden: false,
    });
    // Only the nine built-in table rows appear: the account's ~200 TRC-10 ids and the indexer's
    // discovered contracts sit past the per-refresh inspection cap (and unmocked reads fail).
    expect(balances.tokens).toHaveLength(9);
    expect(balances.tokens.every((t) => t.verified)).toBe(true);
  });

  it("answers a zero native balance and nothing else for an absent account", async () => {
    const calls: Call[] = [];
    const assets = make({ account: {}, reward: { reward: 9 } }, calls, { gateway: true });
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    expect(balances).toStrictEqual({ native: "0", tokens: [] });
    // No resource, reward, call or indexer read happens for a missing account.
    expect(calls.map((c) => c.path)).toStrictEqual(["/wallet/getaccount"]);
  });

  it("reads a custom token's metadata on chain, never assuming decimals", async () => {
    const calls: Call[] = [];
    const custom = "TQhqRHgEonKEYqudomS8243o3bejg8dt1d";
    const assets = make(
      {
        account: accountBody(),
        meta: { [custom]: { decimals: 8, symbol: "GOLD", name: "Gold Token" } },
        balances: { [custom]: 55n },
      },
      calls,
    );
    await assets.init();
    await assets.addToken(TRON_NET, custom);
    calls.length = 0;
    const balances = await assets.refresh(OWNER, TRON_NET);
    expect(token(balances, custom)).toStrictEqual({
      address: custom,
      symbol: "GOLD",
      name: "Gold Token",
      decimals: 8,
      balance: "55",
      verified: false,
      spam: [],
      hidden: false,
    });
    // Metadata was read once at addToken — refresh asks only balanceOf again.
    expect(metadataCalls(calls)).toStrictEqual([]);
  });

  it("omits an added token whose decimals cannot be read", async () => {
    const calls: Call[] = [];
    const custom = "TSG5MMxrio1h8wT7D4XGz4XuxJGXwPhZBj";
    const assets = make({ account: accountBody(), meta: { [custom]: "fail" } }, calls);
    await assets.init();
    await expect(assets.addToken(TRON_NET, custom)).rejects.toThrow(TypeError);
  });

  it("discovers TRC-20 rows from the indexer, unverified, and caches metadata per unlock", async () => {
    const calls: Call[] = [];
    const seen = "TSG5MMxrio1h8wT7D4XGz4XuxJGXwPhZBj";
    const assets = make(
      {
        account: accountBody(),
        indexer: { success: true, data: [{ trc20: [{ [seen]: "777" }] }] },
        meta: { [seen]: { decimals: 6, symbol: "ABC", name: "ABC Token" } },
      },
      calls,
      { gateway: true },
    );
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    expect(token(balances, seen)).toStrictEqual({
      address: seen,
      symbol: "ABC",
      name: "ABC Token",
      decimals: 6,
      balance: "777",
      verified: false,
      spam: [],
      hidden: false,
    });
    const firstReads = metadataCalls(calls).length;
    expect(firstReads).toBe(3);
    calls.length = 0;
    await assets.refresh(OWNER, TRON_NET);
    // The same unlock re-reads no metadata — only the account and the indexer answer.
    expect(metadataCalls(calls)).toStrictEqual([]);
  });

  it("skips indexer discovery when the gateway does not serve the network", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        account: accountBody(),
        indexer: { success: true, data: [{ trc20: [{ [USDT]: "1" }] }] },
      },
      calls,
    );
    await assets.init();
    await assets.refresh(OWNER, TRON_NET);
    expect(calls.some((c) => c.path === "/v1/accounts/account")).toBe(false);
  });

  it("rejects the refresh rather than show a fabricated zero for a failed built-in read", async () => {
    const calls: Call[] = [];
    const assets = make({ account: accountBody(), balances: { [USDT]: "revert" } }, calls);
    await assets.init();
    await expect(assets.refresh(OWNER, TRON_NET)).rejects.toThrow(/balanceOf/);
  });

  it("rejects the refresh rather than show a fabricated zero for a failed custom read", async () => {
    const calls: Call[] = [];
    const custom = "TQhqRHgEonKEYqudomS8243o3bejg8dt1d";
    const assets = make(
      {
        account: accountBody(),
        meta: { [custom]: { decimals: 6, symbol: "GOLD" } },
        balances: { [custom]: "revert" },
      },
      calls,
    );
    await assets.init();
    await assets.addToken(TRON_NET, custom);
    await expect(assets.refresh(OWNER, TRON_NET)).rejects.toThrow(/balanceOf/);
  });

  it("decodes a recorded TRC-10 asset issue and marks the row unverified", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        account: accountBody({ assetV2: [{ key: "1002000", value: 1_234_567 }] }),
        issues: { "1002000": fixture(MAINNET, "assetissuebyid") },
      },
      calls,
      { gateway: true },
    );
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    // "BTT" is owned by the verified TRC-20 — a same-symbol TRC-10 is a look-alike.
    expect(token(balances, "1002000")).toStrictEqual({
      address: "1002000",
      symbol: "BTT",
      name: "BitTorrent",
      decimals: 6,
      balance: "1234567",
      verified: false,
      spam: ["impersonation"],
      hidden: true,
    });
    const issueCalls = calls.filter((c) => c.path === "/wallet/getassetissuebyid");
    expect(issueCalls.map((c) => c.body["value"])).toStrictEqual([1002000]);
  });

  it("flags a look-alike USDT discovered at another address as impersonation", async () => {
    const calls: Call[] = [];
    const fake = "TSG5MMxrio1h8wT7D4XGz4XuxJGXwPhZBj";
    const assets = make(
      {
        account: accountBody(),
        indexer: { success: true, data: [{ trc20: [{ [fake]: "999" }] }] },
        meta: { [fake]: { decimals: 6, symbol: "USDT", name: "Tether USD" } },
        balances: { [USDT]: 0n },
      },
      calls,
      { gateway: true },
    );
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    const row = token(balances, fake);
    expect(row?.spam).toContain("impersonation");
    expect(row?.verified).toBe(false);
    expect(token(balances, USDT)?.spam).toStrictEqual([]);
  });

  it("inspects at most fifty unknown assets per refresh", async () => {
    const calls: Call[] = [];
    const ids = Array.from({ length: 60 }, (_, i) => `${2_000_000 + i}`);
    const assets = make(
      {
        account: accountBody({ assetV2: ids.map((key) => ({ key, value: 7 })) }),
        issues: Object.fromEntries(
          ids.map((id) => [
            id,
            { abbr: "585858".padStart(64, "0"), name: "585858".padStart(64, "0"), precision: 0 },
          ]),
        ),
      },
      calls,
      { gateway: true },
    );
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    const reads = calls.filter((c) => c.path === "/wallet/getassetissuebyid").length;
    expect(reads).toBe(50);
    expect(balances.tokens.filter((t) => t.address.startsWith("2"))).toHaveLength(50);
    await assets.refresh(OWNER, TRON_NET);
    const second = calls.filter((c) => c.path === "/wallet/getassetissuebyid").length;
    expect(second).toBe(60);
  });

  it("does not record a refresh that resolves across a lock", async () => {
    const calls: Call[] = [];
    let hold: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      hold = resolve;
    });
    const assets = new AssetsController({
      ownBitcoinTxids: () => new Set(),
      networks: {
        info: () => ({ family: "tron" }),
        tronApi: () => gatedApi(gate, calls),
      } as never,
      chains: { account: async () => Promise.reject(new Error("unmocked")) },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      setTimer: () => () => {},
      logger,
      gateway: undefined,
      fetch: globalThis.fetch,
      now: () => Date.now(),
    });
    await assets.init();
    const pending = assets.refresh(OWNER, TRON_NET);
    assets.lock();
    hold?.();
    const balances = await pending;
    expect(balances.native).toBe("123456789");
    // The result returned but was never recorded into the post-lock state.
    expect(assets.getState().balances[`${TRON_NET}:${OWNER}`]).toBeUndefined();
  });

  it("sums frozen, unfreezing and delegated amounts from the account fields", async () => {
    const calls: Call[] = [];
    const assets = make(
      {
        account: accountBody({
          balance: 100,
          frozenV2: [
            {},
            { type: "ENERGY", amount: 2_000_000 },
            { type: "BANDWIDTH", amount: 3_000_000 },
            { type: "TRON_POWER" },
          ],
          unfrozenV2: [
            { unfreeze_amount: 4_000_000, unfreeze_expire_time: 1_800_000_000_000 },
            {
              type: "ENERGY",
              unfreeze_amount: 5_000_000,
              unfreeze_expire_time: 1_800_000_100_000,
            },
          ],
          votes: [
            { vote_address: "418440ffd578f7a5abf3537b5f46a6980d382db581", vote_count: 7 },
            { vote_address: "not-an-address", vote_count: 9 },
          ],
          delegated_frozenV2_balance_for_bandwidth: 6_000_000,
          acquired_delegated_frozenV2_balance_for_bandwidth: 8_000_000,
          account_resource: {
            delegated_frozenV2_balance_for_energy: 9_000_000,
            acquired_delegated_frozenV2_balance_for_energy: 11_000_000,
          },
        }),
        resource: {
          freeNetLimit: 600,
          freeNetUsed: 12,
          NetLimit: 5000,
          NetUsed: 400,
          EnergyLimit: 30_000,
          EnergyUsed: 600,
          tronPowerLimit: 5,
          tronPowerUsed: 2,
        },
        reward: { reward: 42_000_000 },
      },
      calls,
    );
    await assets.init();
    const balances = await assets.refresh(OWNER, TRON_NET);
    expect(balances.tron).toStrictEqual({
      frozen: { bandwidth: "3000000", energy: "2000000" },
      unfreezing: [
        { resource: "bandwidth", amount: "4000000", expiresAt: 1_800_000_000_000 },
        { resource: "energy", amount: "5000000", expiresAt: 1_800_000_100_000 },
      ],
      delegatedOut: { bandwidth: "6000000", energy: "9000000" },
      delegatedIn: { bandwidth: "8000000", energy: "11000000" },
      votes: [{ witness: "TN2W4cc7a4dsYyTLiLMWa9m7jVpdLjGvYs", count: "7" }],
      reward: "42000000",
      bandwidth: { free: { limit: 600, used: 12 }, staked: { limit: 5000, used: 400 } },
      energy: { limit: 30_000, used: 600 },
      tronPower: { limit: 5, used: 2 },
    });
  });
});

describe("TRON price asset ids", () => {
  it("maps TRX to slip44:195 and keeps TRC-20 ids case-preserved", () => {
    expect(nativeAssetId(TRON_NET)).toBe("tron:728126428/slip44:195");
    expect(tokenAssetId(TRON_NET, USDT)).toBe(
      "tron:728126428/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    );
    expect(tokenAssetId(TRON_NET, USDT.toLowerCase())).toBeUndefined();
    // Testnets stay unpriced like every other family.
    expect(nativeAssetId(NILE)).toBeUndefined();
    expect(tokenAssetId(NILE, "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf")).toBeUndefined();
  });

  it("validates TRON addresses used in tests", () => {
    expect(isTronAddress(OWNER)).toBe(true);
    expect(isTronAddress("TSG5MMxrio1h8wT7D4XGz4XuxJGXwPhZBj")).toBe(true);
    expect(isTronAddress("TQhqRHgEonKEYqudomS8243o3bejg8dt1d")).toBe(true);
  });
});
