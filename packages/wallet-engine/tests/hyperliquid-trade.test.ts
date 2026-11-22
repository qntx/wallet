import { readFileSync } from "node:fs";

/**
 * `trade.*` end to end on the real Node kernel: the provider signs through
 * `hyperliquid(wallet).signL1` with the enabled agent of exactly that group, posts the exact signed
 * action (the signature is independently recovered against the nktkas L1 hash and the phantom-Agent
 * typed data), and maps every outcome — including unknown POST outcomes reconciled by cloid, never
 * retried.
 */
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { sessions } from "@qntx/wallet/sessions";

import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import { createHyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";
import type {
  HyperliquidProvider,
  HyperliquidProviderInternals,
} from "../src/apps/hyperliquid/provider.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const NOW = Date.now();
const DAY = 86_400_000;

const fixture = (name: string): { response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`fixtures/hyperliquid/testnet/${name}.json`, import.meta.url), "utf8"),
  ) as { response: unknown };

const MIDS = { BTC: "57957.5", ETH: "4000", "PURR/USDC": "0.5" };

/** The account with a BTC position, for close(). */
const STATE = {
  assetPositions: [
    {
      type: "oneWay",
      position: {
        coin: "BTC",
        szi: "0.5",
        leverage: { type: "cross", value: 5 },
        entryPx: "57000",
        positionValue: "28978.75",
        unrealizedPnl: "0",
        returnOnEquity: "0",
        liquidationPx: "0",
        marginUsed: "5795",
        maxLeverage: 40,
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
    },
  ],
  marginSummary: {
    accountValue: "10000",
    totalNtlPos: "28978.75",
    totalRawUsd: "10000",
    totalMarginUsed: "5795",
  },
  crossMarginSummary: {
    accountValue: "10000",
    totalNtlPos: "28978.75",
    totalRawUsd: "10000",
    totalMarginUsed: "5795",
  },
  crossMaintenanceMarginUsed: "0",
  withdrawable: "4000",
};

type Posted = { readonly endpoint: "info" | "exchange"; readonly body: Record<string, unknown> };

const manualTimer = () => {
  const queue: Array<{ at: number; fn: () => unknown; cancelled: boolean }> = [];
  const timers = {
    setTimer: (ms: number, fn: () => unknown) => {
      const entry = { at: timers.now() + ms, fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: () => timers.time,
    time: NOW,
    /** Advance to the next pending timer's time and fire everything due. */
    pump: () => {
      const due = queue
        .filter((entry) => !entry.cancelled && entry.at <= timers.time)
        .toSorted((a, b) => a.at - b.at);
      const [next] = queue.filter((entry) => !entry.cancelled).toSorted((a, b) => a.at - b.at);
      for (const entry of due) {
        entry.cancelled = true;
        entry.fn();
      }
      if (due.length === 0 && next !== undefined) {
        timers.time = next.at;
      }
      return queue.some((entry) => !entry.cancelled);
    },
    pending: () => queue.some((entry) => !entry.cancelled),
  };
  return timers;
};

type FetchAnswers = {
  readonly info?: (body: Record<string, unknown>) => unknown;
  readonly exchange?: (body: Record<string, unknown>) => unknown;
  readonly exchangeError?: (body: Record<string, unknown>) => unknown;
  /** Extra ms the server's Date header is ahead of the device clock — skews the estimate. */
  readonly serverOffset?: number;
};

const serve = (posted: Posted[], timers: ReturnType<typeof manualTimer>, answers: FetchAnswers) => {
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const endpoint = String(url).endsWith("/exchange") ? "exchange" : "info";
    posted.push({ endpoint, body });
    const headers = { date: new Date(timers.time + (answers.serverOffset ?? 0)).toUTCString() };
    if (endpoint === "exchange") {
      if (answers.exchangeError !== undefined) {
        throw new Error("connection reset");
      }
      return Response.json(
        (await answers.exchange?.(body)) ?? { status: "ok", response: { type: "default" } },
        { headers },
      );
    }
    const override = await answers.info?.(body);
    const response =
      override === undefined
        ? body["type"] === "metaAndAssetCtxs"
          ? fixture("metaAndAssetCtxs").response
          : body["type"] === "spotMetaAndAssetCtxs"
            ? fixture("spotMetaAndAssetCtxs").response
            : body["type"] === "allMids"
              ? MIDS
              : body["type"] === "frontendOpenOrders"
                ? []
                : body["type"] === "clearinghouseState"
                  ? STATE
                  : body["type"] === "orderStatus"
                    ? { status: "unknownOid" }
                    : { status: "err", response: `unhandled info ${String(body["type"])}` }
        : override;
    return Response.json(response, { headers });
  };
  return fetch;
};

const RANDOM = (length: number): Uint8Array => new Uint8Array(length).fill(7);
const LOGGER = { warn: () => undefined };

let shared: { wallet: Wallet; walletId: string } | undefined;

const nodeWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  if (shared === undefined) {
    const wallet = await createNodeWallet({
      verifyEvent,
      passkey: {
        rpId: "qntx.test",
        rpName: "qntx",
        walletSalt: "qntx/wallet",
        backupSalt: "qntx/backup",
        vaultSalt: "qntx/vault",
      },
      autoLock: { platform: "web", idleMinutes: 15 },
      authenticator: createSoftwarePasskey(new Uint8Array(32).fill(11)),
      kernelUrl: KERNEL_URL,
    });
    const { walletId } = await wallet.wallets.importMnemonic({
      mnemonic: MNEMONIC,
      factor: { kind: "password", password: PASSWORD },
    });
    shared = { wallet, walletId };
  }
  return shared;
};

const rig = async (
  posted: Posted[],
  timers: ReturnType<typeof manualTimer>,
  answers: FetchAnswers = {},
): Promise<{
  provider: HyperliquidProvider & HyperliquidProviderInternals;
  signCalls: () => number;
  wallet: Wallet;
  walletId: string;
}> => {
  const { wallet, walletId } = await nodeWallet();
  const api = sessions(wallet);
  let signCalls = 0;
  const { sign } = api;
  (api as { sign: typeof sign }).sign = async (params) => {
    signCalls += 1;
    return sign(params);
  };
  const provider = createHyperliquidProvider({
    network: "Testnet",
    fetch: serve(posted, timers, answers),
    now: timers.now,
    setTimer: timers.setTimer,
    wallet,
    random: RANDOM,
    logger: LOGGER,
  });
  return { provider, signCalls: () => signCalls, wallet, walletId };
};

const AGENT_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

/** Recover the signer of the posted body and check it is the agent — posted == signed. */
const verifyPosted = async (posted: Posted, agent: string): Promise<void> => {
  const { body } = posted;
  const { action } = body;
  const { nonce } = body;
  const signature = body["signature"] as { r: string; s: string; v: number };
  expect(signature).toMatchObject({ v: expect.any(Number) });
  expect([27, 28]).toContain(signature.v);
  expect(body["vaultAddress"]).toBeUndefined();
  const hash = createL1ActionHash({
    action: action as Parameters<typeof createL1ActionHash>[0]["action"],
    nonce: nonce as number,
    expiresAfter: body["expiresAfter"] as number,
  });
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337n,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: AGENT_TYPES,
    primaryType: "Agent",
    message: { source: "b", connectionId: hash },
    signature: `0x${signature.r.slice(2)}${signature.s.slice(2)}${signature.v.toString(16)}`,
  });
  expect(recovered.toLowerCase()).toBe(agent.toLowerCase());
};

const category = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HyperliquidError) {
      return error.category;
    }
    throw error;
  }
  throw new Error("expected rejection");
};

const exchangePost = (posted: Posted[]): Posted | undefined =>
  posted.find((entry) => entry.endpoint === "exchange");

const mustPost = (post: Posted | undefined): Posted => {
  if (post === undefined) {
    throw new Error("no exchange post");
  }
  return post;
};

/* The kernel caps agents at 16 per wallet — reuse records across tests. */
const agents = new Map<string, string>();

const createEnabledAgent = async (
  provider: HyperliquidProvider & HyperliquidProviderInternals,
  wallet: Wallet,
  walletId: string,
  groupIndex = 0,
  validUntil = NOW + DAY,
): Promise<string> => {
  const key = `${groupIndex}:${validUntil}`;
  let address = agents.get(key);
  if (address === undefined) {
    address = await sessions(wallet).create({
      scheme: "hyperliquid-l1-agent",
      owner: { walletId, groupIndex },
      scope: "Testnet",
      name: `a${groupIndex}t`,
      validUntil,
    });
    agents.set(key, address);
  }
  await provider.agents.refresh();
  provider.agents.markEnabled(address);
  return address;
};

const GROUP = (walletId: string, groupIndex = 0) => ({ walletId, groupIndex });

describe("hyperliquid trade on the node host", () => {
  it("signs and posts the exact action — the signature recovers to the agent", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 987654321 } }] } },
      }),
    });
    const agent = await createEnabledAgent(provider, wallet, walletId);

    const result = await provider.trade.place(GROUP(walletId), {
      coin: "BTC",
      side: "buy",
      size: "0.05",
      order: { kind: "limit", price: "58000", tif: "Gtc" },
    });

    expect(result.outcomes).toStrictEqual([
      { kind: "resting", oid: 987654321, cloid: "0x07070707070707070707070707070707" },
    ]);
    expect(result.price).toBe("58000");
    const post = mustPost(exchangePost(posted));
    await verifyPosted(post, agent);
    const action = post.body["action"] as {
      type: string;
      orders: Array<Record<string, unknown>>;
      grouping: string;
    };
    expect(action.type).toBe("order");
    expect(action.grouping).toBe("na");
    // BTC is index 3 in the recorded testnet meta (szDecimals 5).
    expect(action.orders[0]).toStrictEqual({
      a: 3,
      b: true,
      p: "58000",
      s: "0.05",
      r: false,
      t: { limit: { tif: "Gtc" } },
      c: "0x07070707070707070707070707070707",
    });
    expect(post.body["nonce"]).toBe(NOW);
    expect(post.body["expiresAfter"]).toBe(NOW + 15_000);
  });

  it("prices a market order off the mid with the slippage cap returned", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ filled: { totalSz: "0.05", avgPx: "58000", oid: 1 } }] },
        },
      }),
    });
    await createEnabledAgent(provider, wallet, walletId);

    const result = await provider.trade.place(GROUP(walletId), {
      coin: "BTC",
      side: "buy",
      size: "0.05",
      order: { kind: "market", slippageBps: 100 },
    });

    // 57957.5 × 1.01 = 58537.075 → rounded down to 5 significant figures (≤1 decimal).
    expect(result.price).toBe("58537");
    expect(result.outcomes[0]?.kind).toBe("filled");
    const action = exchangePost(posted)?.body["action"] as {
      orders: Array<{ t: { limit: { tif: string } } }>;
    };
    expect(action.orders[0]?.t.limit.tif).toBe("Ioc");
  });

  it("attaches reduce-only opposite-side TP/SL children under normalTpsl", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: {
          type: "order",
          data: {
            statuses: [{ resting: { oid: 1 } }, "waitingForTrigger", "waitingForTrigger"],
          },
        },
      }),
    });
    await createEnabledAgent(provider, wallet, walletId);

    await provider.trade.place(GROUP(walletId), {
      coin: "BTC",
      side: "buy",
      size: "0.1",
      order: { kind: "limit", price: "58000" },
      takeProfit: { triggerPx: "60000", market: false, price: "60000" },
      stopLoss: { triggerPx: "55000", market: false, price: "54000" },
    });

    const action = exchangePost(posted)?.body["action"] as {
      grouping: string;
      orders: Array<Record<string, unknown>>;
    };
    expect(action.grouping).toBe("normalTpsl");
    expect(action.orders).toHaveLength(3);
    const [entry, tp, sl] = action.orders;
    expect(entry?.["r"]).toBe(false);
    expect(tp).toMatchObject({
      b: false,
      r: true,
      s: "0.1",
      t: { trigger: { isMarket: false, triggerPx: "60000", tpsl: "tp" } },
    });
    expect(sl).toMatchObject({
      b: false,
      r: true,
      s: "0.1",
      t: { trigger: { isMarket: false, triggerPx: "55000", tpsl: "sl" } },
    });
    expect(tp?.["c"]).toBeTypeOf("string");
    expect(sl?.["c"]).toBeTypeOf("string");
  });

  it("never signs for another group's agent", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, signCalls, wallet, walletId } = await rig(posted, timers);
    await createEnabledAgent(provider, wallet, walletId, 0);

    await expect(
      category(
        provider.trade.place(GROUP(walletId, 1), {
          coin: "BTC",
          side: "buy",
          size: "1",
          order: { kind: "limit", price: "58000" },
        }),
      ),
    ).resolves.toBe("not-enabled");
    expect(signCalls()).toBe(0);
    expect(exchangePost(posted)).toBeUndefined();
  });

  it("refuses to sign when the vault is locked", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers);
    const agent = await createEnabledAgent(provider, wallet, walletId);
    await wallet.vault.lock();

    await expect(
      category(
        provider.trade.place(GROUP(walletId), {
          coin: "BTC",
          side: "buy",
          size: "1",
          order: { kind: "limit", price: "58000" },
        }),
      ),
    ).resolves.toBe("unlock-required");
    expect(posted.filter((entry) => entry.endpoint === "exchange")).toHaveLength(0);
    // Unlock again for the shared wallet.
    await wallet.vault.unlock({ kind: "password", password: PASSWORD });
    expect(agent).toMatch(/^0x/);
  });

  it("requires reauthorization when the enabled agent has expired", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, signCalls, wallet, walletId } = await rig(posted, timers);
    await createEnabledAgent(provider, wallet, walletId, 0, NOW + 60_000);
    timers.time = NOW + 61_000;

    await expect(
      category(
        provider.trade.place(GROUP(walletId), {
          coin: "BTC",
          side: "buy",
          size: "1",
          order: { kind: "limit", price: "58000" },
        }),
      ),
    ).resolves.toBe("reauthorization-required");
    expect(signCalls()).toBe(0);
    timers.time = NOW;
  });

  it("latches agent rejections — the next call fails fast without signing", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, signCalls, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "err",
        response: "User or API Wallet 0x0000000000000000000000000000000000000000 does not exist",
      }),
    });
    const agent = await createEnabledAgent(provider, wallet, walletId);

    const params = {
      coin: "BTC",
      side: "buy" as const,
      size: "1",
      order: { kind: "limit" as const, price: "58000" },
    };
    await expect(category(provider.trade.place(GROUP(walletId), params))).resolves.toBe(
      "reauthorization-required",
    );
    expect(signCalls()).toBe(1);
    expect(posted.filter((entry) => entry.endpoint === "exchange")).toHaveLength(1);

    // The rejected agent latches: the same call fails at require() — no sign, no post.
    await expect(category(provider.trade.place(GROUP(walletId), params))).resolves.toBe(
      "reauthorization-required",
    );
    expect(signCalls()).toBe(1);
    expect(posted.filter((entry) => entry.endpoint === "exchange")).toHaveLength(1);
    expect(agent).toMatch(/^0x/);
  });

  it("other err responses map to rejected without latching the agent", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, signCalls, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({ status: "err", response: "Insufficient margin" }),
    });
    await createEnabledAgent(provider, wallet, walletId);

    await expect(
      category(
        provider.trade.place(GROUP(walletId), {
          coin: "BTC",
          side: "buy",
          size: "1",
          order: { kind: "limit", price: "58000" },
        }),
      ),
    ).resolves.toBe("rejected");
    expect(signCalls()).toBe(1);
  });

  it("refuses to sign when the device clock is beyond the skew bound", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, signCalls, wallet, walletId } = await rig(posted, timers, {
      serverOffset: 10_000,
    });
    await createEnabledAgent(provider, wallet, walletId);

    await expect(
      category(
        provider.trade.place(GROUP(walletId), {
          coin: "BTC",
          side: "buy",
          size: "1",
          order: { kind: "limit", price: "58000" },
        }),
      ),
    ).resolves.toBe("clock-skew");
    expect(signCalls()).toBe(0);
    expect(exchangePost(posted)).toBeUndefined();
  });
});
