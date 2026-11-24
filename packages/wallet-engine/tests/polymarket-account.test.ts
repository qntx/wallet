import { readFileSync } from "node:fs";

/**
 * Account reads on the real Node kernel: public Data-v2 reads replay the recorded fixtures, the L2
 * reads HMAC their headers in the engine over the stored credentials and the sent `POLY_*` headers
 * are compared byte-for-byte against `createL2Headers` from @polymarket/clob-client-v2 — the
 * independent oracle (the same one vectors/chains/polymarket-l2.json was generated with). Session
 * gates — locked vault, missing credentials, a foreign owner, clock skew — are asserted to fail
 * before any request leaves the process.
 */
import { createL2Headers } from "@polymarket/clob-client-v2";
import * as fc from "fast-check";
import type { WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";

import type { Wallet } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import type { ChainsApi } from "@qntx/wallet/chains";

import { CLOB_HOST, DATA_HOST, RELAYER_HOST } from "../src/apps/polymarket/constants.ts";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import { createPolymarketHttp } from "../src/apps/polymarket/http.ts";
import { createPolymarketL2 } from "../src/apps/polymarket/l2.ts";
import { createPolymarketProvider } from "../src/apps/polymarket/provider.ts";
import type { PolymarketProvider } from "../src/apps/polymarket/provider.ts";
import {
  clobBalanceAllowance,
  clobClosedOnly,
  clobOrdersPage,
  clobTradesPage,
  dataActivity,
  dataApprovals,
  dataPositions,
  dataUserPnl,
  dataValue,
  relayerDeployed,
} from "../src/apps/polymarket/schemas.ts";
import { derivePolymarketWallets } from "../src/apps/polymarket/wallets.ts";
import type { AppGroup } from "../src/apps/types.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import {
  credentialsStore,
  MNEMONIC,
  networksStub,
  nodeWallet,
  pmChainCode,
  VERIFY,
} from "./apps-helpers.ts";

const API_A = {
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
} as const;
const API_B = {
  apiKey: "3c5e8a14-9b2d-4f6e-a7c1-5d8e2f4a6b8c",
  secret: "lqe4ydrr_A0eL0BRYnOElaa3yNnq-wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-2",
} as const;

/** Viem mnemonic accounts at m/44'/60'/0'/0/{i} — the kernel's owners for groups i. */
const accountAt = (groupIndex: number) => mnemonicToAccount(MNEMONIC, { addressIndex: groupIndex });
const signerAt = (groupIndex: number): WalletClient => {
  const account = accountAt(groupIndex);
  /* The wallet-client `ClobSigner` shape createL2Headers expects (same shim as the vector script). */
  return {
    account,
    signTypedData: account.signTypedData.bind(account),
  } as unknown as WalletClient;
};

const fixture = (name: string): { request: { url: string }; response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`fixtures/polymarket/${name}.json`, import.meta.url), "utf8"),
  ) as { request: { url: string }; response: unknown };

const ACCOUNT = JSON.parse(
  readFileSync(new URL("fixtures/polymarket/_account.json", import.meta.url), "utf8"),
) as { wallet: `0x${string}`; flagged: boolean };

const DATA_FIXTURES = [
  "account-positions",
  "account-value",
  "account-activity",
  "account-pnl",
  "account-approvals",
].map(fixture);

const L2_FIXTURES: Record<string, () => unknown> = {
  "/data/orders": () => fixture("l2-orders").response,
  "/data/trades": () => fixture("l2-trades").response,
  "/balance-allowance": () => fixture("l2-balance").response,
  "/balance-allowance/update": () => fixture("l2-balance").response,
  "/auth/ban-status/closed-only": () => fixture("l2-closed-only").response,
  "/order": () => ({ success: true }),
};

/** Query params compare order-insensitively. */
const canonical = (url: string): string => {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  return `${parsed.origin}${parsed.pathname}?${JSON.stringify(params)}`;
};

/** A value that must exist — throws a plain Error, failing the test. */
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("required value is missing");
  }
  return value;
};

type Captured = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

type FetchState = {
  /** `/time` answer in server seconds — default: the real clock. */
  serverSeconds?: () => number;
  /** `/deployed` answer for (address, type) — default: beacon only. */
  deployed?: (address: string, type: string) => boolean;
  /** Pathname → an answer other than the fixture (e.g. a 404). */
  override?: Map<string, { status: number; body: unknown }>;
};

const makeFetch = (state: FetchState, requests: Captured[]): typeof globalThis.fetch => {
  const dataFixtures = new Map(DATA_FIXTURES.map((f) => [canonical(f.request.url), f.response]));
  return async (input, init) => {
    await Promise.resolve();
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const overridden = state.override?.get(url.pathname);
    if (overridden !== undefined) {
      return Response.json(overridden.body, { status: overridden.status });
    }
    if (url.origin === CLOB_HOST && url.pathname === "/time") {
      return Response.json(state.serverSeconds?.() ?? Math.floor(Date.now() / 1000));
    }
    if (url.origin === RELAYER_HOST && url.pathname === "/deployed") {
      const address = (url.searchParams.get("address") ?? "").toLowerCase();
      const type = url.searchParams.get("type") ?? "SAFE";
      const answer =
        state.deployed?.(address, type) ??
        (type === "WALLET" &&
          address === derivePolymarketWallets(accountAt(0).address).beacon.toLowerCase());
      return Response.json({ deployed: answer });
    }
    if (url.origin === DATA_HOST) {
      const found = dataFixtures.get(canonical(url.toString()));
      if (found === undefined) {
        throw new Error(`unrecorded data request: ${url.toString()}`);
      }
      return Response.json(found);
    }
    if (url.origin === CLOB_HOST) {
      if (url.pathname.startsWith("/data/order/")) {
        return Response.json(fixture("l2-order").response);
      }
      const route = L2_FIXTURES[url.pathname];
      if (route !== undefined) {
        return Response.json(route());
      }
    }
    throw new Error(`unrecorded request: ${url.toString()}`);
  };
};

const setTimer = (ms: number, fn: () => unknown): (() => void) => {
  const id = setTimeout(() => void fn(), ms);
  return () => {
    clearTimeout(id);
  };
};

/* Account tests never place orders — the pipeline is stubbed to fail loudly if reached. */
const NO_REQUESTS = {
  prepare: () => {
    throw new Error("no requests in account tests");
  },
  outcome: () => {
    throw new Error("no requests in account tests");
  },
};

let wallet: Wallet;
let walletId: string;
let backing: EngineStore;

const group = (groupIndex: number): AppGroup => ({ walletId, groupIndex });

/* The store models the engine session: a locked vault reads as a closed store. */
const session = (): EngineStore | undefined =>
  wallet.getSnapshot().vault === "unlocked" ? backing : undefined;
const credentials = credentialsStore(session);
const signerOf = async (g: AppGroup): Promise<`0x${string}`> =>
  Promise.resolve(accountAt(g.groupIndex).address);

beforeAll(async () => {
  ({ wallet, walletId } = await nodeWallet());
  await wallet.vault.unlock(VERIFY).catch(() => undefined);
  backing = createMemoryEngineStore();
  /* Group 0/1 credentials — the owners are the viem accounts' EIP-55 addresses the kernel's
     `evm.bip44` derivation produces for the same groups. */
  await credentials.put(group(0), { owner: accountAt(0).address, ...API_A });
  await credentials.put(group(1), { owner: accountAt(1).address, ...API_B });
});

const provider = (
  requests: Captured[],
  state: FetchState = {},
  now: () => number = () => Date.now(),
): PolymarketProvider =>
  createPolymarketProvider({
    fetch: makeFetch(state, requests),
    setTimer,
    now,
    wallet,
    credentials,
    /* The account seam resolves the group's Polygon address through the kernel — the same
       evm.bip44 derivation the viem oracle accounts mirror. */
    account: async (params: Parameters<ChainsApi["account"]>[0]) => chains(wallet).account(params),
    /* The chain read mirrors makeFetch's `/deployed` answer — beacon only unless overridden. */
    networks: networksStub(
      pmChainCode(
        (address, type) =>
          state.deployed?.(address, type) ??
          (type === "WALLET" &&
            address === derivePolymarketWallets(accountAt(0).address).beacon.toLowerCase()),
        accountAt(0).address,
      ),
    ),
    requests: NO_REQUESTS,
    random: () => new Uint8Array(8).fill(1),
    availability: () => "available",
    socket: () => ({
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }),
    logger: { warn: () => undefined },
  });

describe("polymarket account — public reads", () => {
  it("positions replays the recording with string-normalized decimals", async () => {
    const requests: Captured[] = [];
    const page = await provider(requests).account.positions(ACCOUNT.wallet, { limit: 50 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.toString()).toContain("/v2/positions");
    expect(requests[0]?.url.searchParams.get("user")).toBe(ACCOUNT.wallet);
    expect(page.items.length).toBeGreaterThan(0);
    const [first] = page.items;
    expect(first?.size).toBeTypeOf("string");
    expect(first?.redeemable).toBeTypeOf("boolean");
    expect(page.items.filter((item) => item.redeemable).length).toBeGreaterThan(0);
  });

  it("value replays the recording as a string", async () => {
    const value = await provider([]).account.value(ACCOUNT.wallet);
    expect(value).toBeTypeOf("string");
    expect(Number(value)).toBeCloseTo(4.9615, 4);
  });

  it("activity replays the recording with its cursor", async () => {
    const page = await provider([]).account.activity(ACCOUNT.wallet, { limit: 50 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]?.type).toBe("TRADE");
    expect(page.nextCursor).toBeDefined();
  });

  it("pnl replays the recorded points", async () => {
    const pnl = await provider([]).account.pnl(ACCOUNT.wallet, {});
    expect(pnl.wallet).toBe(ACCOUNT.wallet);
    expect(pnl.points.length).toBeGreaterThan(0);
    expect(pnl.points[0]?.realizedPnl).toBeTypeOf("string");
  });

  it("approvals replays the recorded contract catalog", async () => {
    const approvals = await provider([]).account.approvals(ACCOUNT.wallet);
    expect(approvals.address).toBe(ACCOUNT.wallet);
    expect(approvals.contracts.length).toBeGreaterThan(10);
    expect(approvals.contracts.every((c) => typeof c.approved === "boolean")).toBe(true);
  });

  it("rejects a malformed wallet or limit before any fetch", async () => {
    const requests: Captured[] = [];
    const { account } = provider(requests);
    await expect(account.positions("0x1234")).rejects.toMatchObject({
      category: "invalid-input",
    });
    await expect(account.positions(ACCOUNT.wallet, { limit: 101 })).rejects.toMatchObject({
      category: "invalid-input",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("polymarket account — locate", () => {
  it("locates the beacon wallet and memoizes the probes", async () => {
    const requests: Captured[] = [];
    const { account } = provider(requests);
    const first = await account.locate(group(0));
    expect(first.signer).toBe(accountAt(0).address);
    expect(first.wallet).toBe(derivePolymarketWallets(accountAt(0).address).beacon);
    expect(first.kind).toBe("deposit-wallet");
    expect(first.deployed).toBe(true);
    const probes = requests.length;
    const second = await account.locate(group(0));
    expect(second).toBe(first);
    expect(requests).toHaveLength(probes);
  });
});

describe("polymarket account — L2 reads", () => {
  it("openOrders replays the docs fixture with oracle-identical headers", async () => {
    const requests: Captured[] = [];
    const page = await provider(requests).account.openOrders(group(0), {});
    const sent = required(requests.find((r) => r.url.pathname === "/data/orders"));
    const { headers } = sent;
    const expected = await createL2Headers(
      signerAt(0),
      { key: API_A.apiKey, secret: API_A.secret, passphrase: API_A.passphrase },
      { method: "GET", requestPath: "/data/orders" },
      Number(headers["POLY_TIMESTAMP"]),
    );
    expect(headers["POLY_ADDRESS"]).toBe(accountAt(0).address);
    expect(headers["POLY_API_KEY"]).toBe(API_A.apiKey);
    expect(headers["POLY_PASSPHRASE"]).toBe(API_A.passphrase);
    expect(headers["POLY_SIGNATURE"]).toBe(expected.POLY_SIGNATURE);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe("MTAw");
    expect(page.items[0]?.side).toBe("BUY");
  });

  it("group B signs with its own apiKey and POLY_ADDRESS", async () => {
    const requests: Captured[] = [];
    await provider(requests).account.openOrders(group(1), {});
    const sent = required(requests.find((r) => r.url.pathname === "/data/orders"));
    const { headers } = sent;
    const expected = await createL2Headers(
      signerAt(1),
      { key: API_B.apiKey, secret: API_B.secret, passphrase: API_B.passphrase },
      { method: "GET", requestPath: "/data/orders" },
      Number(headers["POLY_TIMESTAMP"]),
    );
    expect(headers["POLY_ADDRESS"]).toBe(accountAt(1).address);
    expect(headers["POLY_API_KEY"]).toBe(API_B.apiKey);
    expect(headers["POLY_SIGNATURE"]).toBe(expected.POLY_SIGNATURE);
  });

  it("openOrders refuses assetId without market before any fetch", async () => {
    const requests: Captured[] = [];
    await expect(
      provider(requests).account.openOrders(group(0), { assetId: "1" }),
    ).rejects.toMatchObject({ category: "invalid-input" });
    expect(requests.find((r) => r.url.pathname === "/data/orders")).toBeUndefined();
  });

  it("order returns the row, and undefined on the documented 404", async () => {
    const requests: Captured[] = [];
    const { account } = provider(requests);
    const id = `0x${"ab".repeat(32)}`;
    const found = await account.order(group(0), id);
    expect(found?.id).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(found?.price).toBe("0.5");
    const missing = `0x${"cd".repeat(32)}`;
    const state: FetchState = {
      override: new Map([
        [`/data/order/${missing}`, { status: 404, body: { error: "Order not found" } }],
      ]),
    };
    const absent = await provider([], state).account.order(group(0), missing);
    expect(absent).toBeUndefined();
    await expect(account.order(group(0), "not-hex")).rejects.toMatchObject({
      category: "invalid-input",
    });
  });

  it("trades scopes to the located wallet via maker_address", async () => {
    const requests: Captured[] = [];
    const page = await provider(requests).account.trades(group(0), {});
    const sent = requests.find((r) => r.url.pathname === "/data/trades");
    expect(sent?.url.searchParams.get("maker_address")).toBe(
      derivePolymarketWallets(accountAt(0).address).beacon,
    );
    expect(page.items[0]?.takerOrderId).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(page.items[0]?.traderSide).toBe("TAKER");
  });

  it("balance and refreshAllowance read the allowance map", async () => {
    const requests: Captured[] = [];
    const { account } = provider(requests);
    const balance = await account.balance(group(0));
    expect(balance.balance).toBe("1000000000000000000");
    expect(balance.allowances["0x1234567890123456789012345678901234567890"]).toBe(
      "500000000000000000",
    );
    const sent = requests.find((r) => r.url.pathname === "/balance-allowance");
    expect(sent?.url.searchParams.get("asset_type")).toBe("COLLATERAL");
    expect(sent?.url.searchParams.get("signature_type")).toBe("3");
    const refreshed = await account.refreshAllowance(group(0), {
      assetType: "CONDITIONAL",
      tokenId: "12345",
    });
    expect(refreshed.balance).toBe("1000000000000000000");
    const update = requests.find((r) => r.url.pathname === "/balance-allowance/update");
    expect(update?.url.searchParams.get("token_id")).toBe("12345");
  });

  it("closedOnly is false on the fixture, false on 404, true when reported", async () => {
    await expect(provider([]).account.closedOnly(group(0))).resolves.toBe(false);
    const notFound: FetchState = {
      override: new Map([
        ["/auth/ban-status/closed-only", { status: 404, body: { error: "not found" } }],
      ]),
    };
    await expect(provider([], notFound).account.closedOnly(group(0))).resolves.toBe(false);
    const banned: FetchState = {
      override: new Map([
        ["/auth/ban-status/closed-only", { status: 200, body: { closed_only: true } }],
      ]),
    };
    await expect(provider([], banned).account.closedOnly(group(0))).resolves.toBe(true);
  });

  it("POST sends the exact signed body with a JSON content type", async () => {
    const requests: Captured[] = [];
    const http = createPolymarketHttp({
      fetch: makeFetch({}, requests),
      setTimer,
      now: () => Date.now(),
    });
    const l2 = createPolymarketL2({
      http,
      credentials,
      signerOf,
      now: () => Date.now(),
    });
    const body = JSON.stringify({ deferExec: false, orderType: "GTC" });
    await l2.request(group(0), { method: "POST", path: "/order", body }, z.looseObject({}));
    const sent = required(requests.find((r) => r.url.pathname === "/order"));
    expect(sent.body).toBe(body);
    expect(sent.headers["content-type"]).toBe("application/json");
    const { headers } = sent;
    const expected = await createL2Headers(
      signerAt(0),
      { key: API_A.apiKey, secret: API_A.secret, passphrase: API_A.passphrase },
      { method: "POST", requestPath: "/order", body },
      Number(headers["POLY_TIMESTAMP"]),
    );
    expect(headers["POLY_SIGNATURE"]).toBe(expected.POLY_SIGNATURE);
  });

  it("credentials reads back the group's stored record without a fetch", async () => {
    const requests: Captured[] = [];
    const l2 = createPolymarketL2({
      http: createPolymarketHttp({
        fetch: makeFetch({}, requests),
        setTimer,
        now: () => Date.now(),
      }),
      credentials,
      signerOf,
      now: () => Date.now(),
    });
    const creds = await l2.credentials(group(0));
    expect(creds?.apiKey).toBe(API_A.apiKey);
    expect(creds?.owner).toBe(accountAt(0).address);
    expect(requests).toHaveLength(0);
  });
});

describe("polymarket account — session gates", () => {
  it("a locked vault maps to unlock-required and no request leaves the process", async () => {
    await wallet.vault.lock();
    const requests: Captured[] = [];
    await expect(provider(requests).account.openOrders(group(0), {})).rejects.toMatchObject({
      category: "unlock-required",
    });
    expect(requests).toHaveLength(0);
    await wallet.vault.unlock(VERIFY);
  });

  it("a group without credentials maps to not-enabled before any fetch", async () => {
    const requests: Captured[] = [];
    await expect(provider(requests).account.openOrders(group(7), {})).rejects.toMatchObject({
      category: "not-enabled",
    });
    expect(requests).toHaveLength(0);
  });

  it("a record owned by another account refuses before any fetch", async () => {
    /* Group 1's record carrying group 0's owner is never used — the signer check fails first. */
    await credentials.put(group(1), { owner: accountAt(0).address, ...API_B });
    const requests: Captured[] = [];
    await expect(provider(requests).account.openOrders(group(1), {})).rejects.toMatchObject({
      category: "not-enabled",
    });
    expect(requests).toHaveLength(0);
    await credentials.put(group(1), { owner: accountAt(1).address, ...API_B });
  });

  it("clock skew beyond the signing window refuses before signing", async () => {
    const requests: Captured[] = [];
    const skewed: FetchState = {
      serverSeconds: () => Math.floor(Date.now() / 1000) + 60,
    };
    await expect(provider(requests, skewed).account.openOrders(group(0), {})).rejects.toMatchObject(
      { category: "clock-skew" },
    );
    /* `/time` was the only request — no L2 call ever left the process. */
    expect(requests.map((r) => r.url.pathname)).toStrictEqual(["/time"]);
  });

  it("the skew check refreshes after ten minutes", async () => {
    let now = Date.now();
    const requests: Captured[] = [];
    /* `/time` answers the injected clock so the skew stays zero. */
    const { account } = provider(
      requests,
      { serverSeconds: () => Math.floor(now / 1000) },
      () => now,
    );
    await account.openOrders(group(0), {});
    const timeCalls = () => requests.filter((r) => r.url.pathname === "/time").length;
    expect(timeCalls()).toBe(1);
    await account.openOrders(group(0), {});
    expect(timeCalls()).toBe(1);
    /* +11 minutes refreshes the check — the third request signs at the new time and goes out. */
    now += 11 * 60 * 1000;
    await account.openOrders(group(0), {});
    expect(timeCalls()).toBe(2);
  });
});

describe("polymarket account — hostile responses", () => {
  const http = (response: unknown): ReturnType<typeof createPolymarketHttp> =>
    createPolymarketHttp({
      fetch: async () => {
        await Promise.resolve();
        return typeof response === "string" ? new Response(response) : Response.json(response);
      },
      setTimer: () => () => undefined,
      now: () => 1_800_000_000_000,
    });

  const paths = (value: unknown, prefix: string[] = []): string[][] => {
    if (typeof value !== "object" || value === null) {
      return [prefix];
    }
    const entries = Array.isArray(value)
      ? value.map((item, i) => [String(i), item] as const)
      : Object.entries(value);
    return entries.flatMap(([key, item]) => paths(item, [...prefix, key]));
  };
  const setPath = (root: Record<string, unknown>, path: string[], value: unknown): void => {
    let at = root;
    for (const key of path.slice(0, -1)) {
      const next = at[key];
      if (typeof next !== "object" || next === null) {
        return;
      }
      at = next as Record<string, unknown>;
    }
    const last = path.at(-1);
    if (last !== undefined) {
      at[last] = value;
    }
  };

  /** "parsed" | "typed" | "untyped" — what a mangled answer produced through the schema. */
  const outcome = async (
    body: unknown,
    schema: z.ZodMiniType,
  ): Promise<"parsed" | "typed" | "untyped"> => {
    try {
      await http(body).request({ host: DATA_HOST, method: "GET", path: "/x" }, schema);
      return "parsed";
    } catch (error) {
      return error instanceof PolymarketError ? "typed" : "untyped";
    }
  };

  /* fixture → the schema guarding it — one hostile pass per new schema. */
  const CASES: ReadonlyArray<readonly [string, z.ZodMiniType]> = [
    ["account-positions", dataPositions],
    ["account-value", dataValue],
    ["account-activity", dataActivity],
    ["account-pnl", dataUserPnl],
    ["account-approvals", dataApprovals],
    ["l2-orders", clobOrdersPage],
    ["l2-trades", clobTradesPage],
    ["l2-balance", clobBalanceAllowance],
    ["l2-closed-only", clobClosedOnly],
    ["relayer-deployed", relayerDeployed],
  ];

  it("a mangled fixture never produces an untyped throw on any new schema", async () => {
    for (const [name, schema] of CASES) {
      const recorded = fixture(name).response;
      const allPaths = paths(recorded).filter((p) => p.length > 0);
      // oxlint-disable-next-line eslint/no-await-in-loop -- cases run sequentially
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...allPaths), fc.jsonValue(), async (path, junk) => {
          const mangled = structuredClone(recorded) as Record<string, unknown>;
          setPath(mangled, path, junk);
          await expect(outcome(mangled, schema)).resolves.not.toBe("untyped");
        }),
      );
    }
  });

  it("an oversized positions page is rejected, not held", async () => {
    const recorded = structuredClone(fixture("account-positions").response) as {
      data: unknown[];
    };
    recorded.data = Array.from({ length: 600 }, () => recorded.data[0]);
    await expect(
      http(recorded).request({ host: DATA_HOST, method: "GET", path: "/x" }, dataPositions),
    ).rejects.toMatchObject({ category: "malformed" });
  });
});
