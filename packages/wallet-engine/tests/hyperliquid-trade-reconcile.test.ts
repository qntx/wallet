import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * Unknown-outcome and response mapping for `trade.*`: an /exchange POST that times out, drops, or
 * 502s may have committed — orders are reconciled by polling `orderStatus` by cloid on the injected
 * clock (never re-posted), everything else is `{kind:"unknown"}`. The wire actions of every other
 * trade method are checked against the captured body.
 */
import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";
import type { ChainsApi } from "@qntx/wallet/chains";
import type { HyperliquidL1Action } from "@qntx/wallet/protocol";
import { sessions } from "@qntx/wallet/sessions";

import { createHyperliquidAccount } from "../src/apps/hyperliquid/account.ts";
import { createHyperliquidAgentRegistry } from "../src/apps/hyperliquid/agents.ts";
import type { HyperliquidAgentRegistry, HyperliquidGroup } from "../src/apps/hyperliquid/agents.ts";
import { createHyperliquidClock } from "../src/apps/hyperliquid/clock.ts";
import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import { createHyperliquidExchange } from "../src/apps/hyperliquid/exchange.ts";
import type { HyperliquidOutcomeCorrection } from "../src/apps/hyperliquid/exchange.ts";
import { createHyperliquidMarkets } from "../src/apps/hyperliquid/markets.ts";
import { createHyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";
import type {
  HyperliquidProvider,
  HyperliquidProviderInternals,
} from "../src/apps/hyperliquid/provider.ts";
import { createHyperliquidSocket } from "../src/apps/hyperliquid/socket.ts";
import type { AppSocket } from "../src/apps/hyperliquid/socket.ts";
import { createHyperliquidTransport } from "../src/apps/hyperliquid/transport.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
/** Agent limits generous enough for every fixture trade — the metering tests pin their own. */
const HL_LIMITS = {
  notional: "1000000000000",
  maxLeverage: 100,
  assets: [0, 1, 3, 4, 5, 7, 40, 42].map((asset) => ({ asset, size: "1000000" })),
};
const NOW = Date.now();
const DAY = 86_400_000;
const CLOID = "0x07070707070707070707070707070707";
const MASTER = "0x000000000000000000000000000000000000dead";

const fixture = (name: string): { response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`fixtures/hyperliquid/testnet/${name}.json`, import.meta.url), "utf8"),
  ) as { response: unknown };

const MIDS = { BTC: "57957.5", ETH: "4000", "PURR/USDC": "0.5" };

/** A clearinghouse state carrying one short BTC position — close() reads szi. */
const STATE = {
  assetPositions: [
    {
      type: "oneWay",
      position: { coin: "BTC", szi: "-0.5", leverage: { type: "cross", value: 5 } },
    },
  ],
  marginSummary: { accountValue: "1" },
  crossMarginSummary: { accountValue: "1" },
  withdrawable: "1",
};

type Posted = { readonly endpoint: "info" | "exchange"; readonly body: Record<string, unknown> };

const manualTimer = () => {
  const queue: Array<{ at: number; fn: () => unknown; cancelled: boolean }> = [];
  const timers = {
    time: NOW,
    now: () => timers.time,
    setTimer: (ms: number, fn: () => unknown) => {
      const entry = { at: timers.time + ms, fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Advance to the next pending timer and fire everything now due. */
    step: (): boolean => {
      const [next] = queue.filter((entry) => !entry.cancelled).toSorted((a, b) => a.at - b.at);
      if (next === undefined) {
        return false;
      }
      timers.time = Math.max(timers.time, next.at);
      for (const entry of queue.filter(
        (candidate) => !candidate.cancelled && candidate.at <= timers.time,
      )) {
        entry.cancelled = true;
        entry.fn();
      }
      return true;
    },
  };
  return timers;
};

type Timers = ReturnType<typeof manualTimer>;

/** Drive a promise to settlement by pumping manual timers and microtasks. */
const drive = async <T>(timers: Timers, promise: Promise<T>): Promise<T> => {
  let settled = false;
  const outcome = promise.then(
    (v) => {
      settled = true;
      return v;
    },
    (error_: unknown) => {
      settled = true;
      throw error_;
    },
  );
  for (let i = 0; i < 10_000; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the pump must tick between timer steps.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    if (!timers.step()) {
      /* Nothing is due on the manual clock, so the call waits on real work — the kernel signing
         in its worker. Give it real time instead of spinning through the iteration budget. */
      // oxlint-disable-next-line eslint/no-await-in-loop -- the pump must tick between timer steps.
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    if (settled) {
      break;
    }
  }
  if (!settled) {
    throw new Error("the call never settled");
  }
  return outcome;
};

/** Step the manual timers like `drive` until `reached` holds — mid-call, before it settles. */
const stepUntil = async (timers: Timers, reached: () => boolean): Promise<void> => {
  for (let i = 0; i < 10_000; i += 1) {
    if (reached()) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- the pump must tick between steps.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    if (!timers.step()) {
      /* As in `drive`: nothing is due on the manual clock, so the call waits on the kernel signing
         in its worker — give it real time instead of spinning through the iteration budget. */
      // oxlint-disable-next-line eslint/no-await-in-loop -- the pump must tick between steps.
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  }
  throw new Error("the awaited point was never reached");
};

type InfoAnswers = (body: Record<string, unknown>) => unknown;

const serve = (
  posted: Posted[],
  timers: Timers,
  answers: {
    readonly info?: InfoAnswers;
    readonly exchange?: (body: Record<string, unknown>) => unknown;
    readonly exchangeResponse?: Response;
  },
) => {
  const produce = async (
    endpoint: "info" | "exchange",
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const headers = { date: new Date(timers.time).toUTCString() };
    if (endpoint === "exchange") {
      if (answers.exchangeResponse !== undefined) {
        return new Response(answers.exchangeResponse.body, {
          status: answers.exchangeResponse.status,
          headers,
        });
      }
      return Response.json(
        (await answers.exchange?.(body)) ?? {
          status: "ok",
          response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }] } },
        },
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
                : body["type"] === "orderStatus"
                  ? { status: "unknownOid" }
                  : {}
        : override;
    return Response.json(response, { headers });
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const endpoint = String(url).endsWith("/exchange") ? "exchange" : "info";
    posted.push({ endpoint, body });
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
      void produce(endpoint, body).then(resolve, reject);
    });
  };
  return fetch;
};

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

class FakeSocket implements AppSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(method: string): unknown[] {
    return this.sent
      .map((f) => JSON.parse(f) as { method?: string; subscription?: unknown })
      .filter((f) => f.method === method)
      .map((f) => f.subscription);
  }
}

const rig = async (
  posted: Posted[],
  timers: Timers,
  answers: Parameters<typeof serve>[2] = {},
  extra: {
    readonly random?: (length: number) => Uint8Array;
    readonly sockets?: FakeSocket[];
  } = {},
): Promise<{
  provider: Omit<HyperliquidProvider, "approveBuilder"> & HyperliquidProviderInternals;
  wallet: Wallet;
  walletId: string;
}> => {
  const { wallet, walletId } = await nodeWallet();
  const random = extra.random ?? ((length: number) => new Uint8Array(length).fill(7));
  const provider = createHyperliquidProvider({
    network: "Testnet",
    fetch: serve(posted, timers, answers),
    now: timers.now,
    setTimer: timers.setTimer,
    wallet,
    account: async (params: Parameters<ChainsApi["account"]>[0]) => chains(wallet).account(params),
    random,
    logger: { warn: () => undefined },
    ...(extra.sockets === undefined
      ? {}
      : {
          socket: createHyperliquidSocket({
            network: "Testnet",
            socket: () => {
              const s = new FakeSocket();
              extra.sockets?.push(s);
              return s;
            },
            setTimer: timers.setTimer,
            random,
          }),
        }),
  });
  return { provider, wallet, walletId };
};

/** A macrotask flushes every queued microtask — owner resolution, SDK chains, fetches. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
};

/** Step the manual timers and flush the async work one poll round at a time. */
const pump = async (timers: Timers, steps = 1): Promise<void> => {
  for (let i = 0; i < steps; i += 1) {
    timers.step();
    // oxlint-disable-next-line eslint/no-await-in-loop -- the pump must tick between steps.
    await tick();
  }
};

let agentAddress: string | undefined;

const enable = async (
  provider: Omit<HyperliquidProvider, "approveBuilder"> & HyperliquidProviderInternals,
  wallet: Wallet,
  walletId: string,
): Promise<{ address: string; group: { walletId: string; groupIndex: number } }> => {
  agentAddress ??= await sessions(wallet).create({
    scheme: "hyperliquid-l1-agent",
    limits: HL_LIMITS,
    verify: VERIFY,
    owner: { walletId, groupIndex: 0 },
    scope: "Testnet",
    name: "reconcile",
    validUntil: NOW + DAY,
  });
  /* The agent is shared across tests; a lock+unlock in one clears its opened mark, so a cached
     address must be re-opened (idempotent on a session just created). */
  await sessions(wallet).open(agentAddress, VERIFY);
  await provider.agents.refresh();
  provider.agents.markEnabled(agentAddress);
  return { address: agentAddress, group: { walletId, groupIndex: 0 } };
};

const ORDER = {
  coin: "BTC",
  side: "buy" as const,
  size: "0.05",
  order: { kind: "limit" as const, price: "58000" },
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

const isOrderStatusPost = (entry: Posted): boolean =>
  entry.endpoint === "info" && entry.body["type"] === "orderStatus";

const exchangeCount = (posted: Posted[]): number =>
  posted.filter((entry) => entry.endpoint === "exchange").length;

/** An info answer that serves `value` only for `type` — keeps conditionals out of test bodies. */
const whenType = (type: string, value: unknown): InfoAnswers => {
  return (body) => (body["type"] === type ? value : undefined);
};

/** OrderStatus stays unknownOid until `exists` — the endpoint catching up after the call. */
const orderStatusAfter = (exists: () => boolean, found: unknown): InfoAnswers => {
  return (body) => (body["type"] === "orderStatus" && exists() ? found : undefined);
};

/** An info answer that throws for `type` — orderStatus polling failures. */
const throwOnType = (type: string, error: unknown): InfoAnswers => {
  return (body) => {
    if (body["type"] === type) {
      throw error;
    }
    return undefined;
  };
};

const orderFound = (status: string, order: Record<string, unknown> = {}): unknown => ({
  status: "order",
  order: {
    order: { oid: 424242, origSz: "0.05", sz: "0.05", limitPx: "58000", ...order },
    status,
    statusTimestamp: NOW,
  },
});

describe("hyperliquid trade — unknown POST outcomes", () => {
  it("a dropped post is never retried; the cloid reconciles to its real outcome", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
      info: whenType("orderStatus", orderFound("filled", { sz: "0" })),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(exchangeCount(posted)).toBe(1);
    expect(result.outcomes).toStrictEqual([
      { kind: "filled", oid: 424242, cloid: CLOID, totalSz: "0.05" },
    ]);
    const orderStatusCalls = posted.filter(isOrderStatusPost);
    expect(orderStatusCalls).toHaveLength(1);
    expect(orderStatusCalls[0]?.body["oid"]).toBe(CLOID);
  });

  it("a timeout reconciles to resting, and a rejected status maps its reason", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      // Never answers: the transport's own 10 s deadline fires the abort.
      exchange: async () => new Promise<never>(() => {}),
      info: whenType("orderStatus", orderFound("perpMarginRejected")),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(exchangeCount(posted)).toBe(1);
    expect(result.outcomes).toStrictEqual([
      {
        kind: "rejected",
        cloid: CLOID,
        reason: "margin",
        message: "perpMarginRejected",
      },
    ]);
  });

  it("a 502 reconciles to unknown — unknownOid can never prove the order was not placed", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchangeResponse: new Response("bad gateway", { status: 502 }),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(exchangeCount(posted)).toBe(1);
    expect(result.outcomes).toStrictEqual([{ kind: "unknown", cloid: CLOID }]);
    // expiresAfter + 5 s skew + 2 s slack — the last poll is past now+22 s.
    expect(timers.time).toBeGreaterThan(NOW + 22_000);
  });

  it("a status first answering in the deadline's last seconds still reconciles", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
      /* The endpoint catches up only at now+20 s — inside the last 10 s of the 22 s window. */
      info: orderStatusAfter(() => timers.time >= NOW + 20_000, orderFound("filled", { sz: "0" })),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([
      { kind: "filled", oid: 424242, cloid: CLOID, totalSz: "0.05" },
    ]);
  });

  it("orderStatus failures until the deadline leave the outcome unknown", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
      info: throwOnType("orderStatus", new Error("info down")),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([{ kind: "unknown", cloid: CLOID }]);
    expect(timers.time).toBeGreaterThan(NOW + 22_000);
  });

  it("a found open order reconciles to resting", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
      info: whenType("orderStatus", orderFound("open")),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([{ kind: "resting", oid: 424242, cloid: CLOID }]);
  });

  it("an open order that already filled in part reports its filled size", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
      info: whenType("orderStatus", orderFound("open", { sz: "0.02" })),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([
      { kind: "resting", oid: 424242, cloid: CLOID, filledSz: "0.03" },
    ]);
  });

  it("a terminal status with a partial fill reports the filled size, not a rejection", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
      info: whenType("orderStatus", orderFound("canceled", { sz: "0.04" })),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([
      { kind: "filled", oid: 424242, cloid: CLOID, totalSz: "0.01" },
    ]);
  });

  it("an answered but malformed status list reconciles by cloid instead of rejecting", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: { type: "order", data: { statuses: [{ bogus: true }] } },
      }),
      info: whenType("orderStatus", orderFound("filled", { sz: "0" })),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(exchangeCount(posted)).toBe(1);
    expect(result.outcomes).toStrictEqual([
      { kind: "filled", oid: 424242, cloid: CLOID, totalSz: "0.05" },
    ]);
  });

  it("a lost non-order action reports unknown — never re-posted", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => {
        throw new Error("connection reset");
      },
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(
      timers,
      provider.trade.twapCancel(group, { coin: "BTC", twapId: 1 }),
    );

    expect(result).toStrictEqual({ kind: "unknown" });
    expect(exchangeCount(posted)).toBe(1);
  });
});

describe("hyperliquid trade — late reconciliation", () => {
  const UNKNOWN = { kind: "unknown" as const, cloid: CLOID };

  it("unknownOid until the deadline, filled after — unknown, then a correction", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    let orderExists = false;
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: async () => new Promise<never>(() => {}),
      info: orderStatusAfter(() => orderExists, orderFound("filled", { sz: "0" })),
    });
    const { group } = await enable(provider, wallet, walletId);
    const corrections: HyperliquidOutcomeCorrection[] = [];
    provider.trade.corrections.subscribe((correction) => corrections.push(correction));

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([UNKNOWN]);
    // expiresAfter + 5 s skew + 2 s slack — the last poll ran past now+22 s.
    expect(timers.time).toBeGreaterThan(NOW + 22_000);

    // The order committed after all: the endpoint knows it on the late poll's next beat.
    orderExists = true;
    await pump(timers, 3);
    expect(corrections).toStrictEqual([
      {
        group,
        cloid: CLOID,
        outcome: { kind: "filled", oid: 424242, cloid: CLOID, totalSz: "0.05" },
      },
    ]);
    // A corrected cloid leaves the pending set — no further orderStatus calls for it.
    const calls = posted.filter(isOrderStatusPost).length;
    await pump(timers, 3);
    expect(posted.filter(isOrderStatusPost)).toHaveLength(calls);
  });

  it("the late window expires — no correction, nothing left to poll", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: async () => new Promise<never>(() => {}),
    });
    const { group } = await enable(provider, wallet, walletId);
    const corrections: HyperliquidOutcomeCorrection[] = [];
    provider.trade.corrections.subscribe((correction) => corrections.push(correction));

    const result = await drive(timers, provider.trade.place(group, ORDER));
    expect(result.outcomes).toStrictEqual([UNKNOWN]);

    // Sixty-one 10 s beats carry the pending cloid past its ten-minute window.
    await pump(timers, 62);
    expect(corrections).toStrictEqual([]);
    // The expired entry dropped out — no late-poll timer remains.
    expect(timers.step()).toBe(false);
  });

  it("locking the vault drops the pending set — the late poll never fires again", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: async () => new Promise<never>(() => {}),
    });
    const { group } = await enable(provider, wallet, walletId);
    const corrections: HyperliquidOutcomeCorrection[] = [];
    provider.trade.corrections.subscribe((correction) => corrections.push(correction));

    const result = await drive(timers, provider.trade.place(group, ORDER));
    expect(result.outcomes).toStrictEqual([UNKNOWN]);
    const calls = posted.filter(isOrderStatusPost).length;

    await wallet.vault.lock();
    await pump(timers, 3);
    expect(corrections).toStrictEqual([]);
    expect(posted.filter(isOrderStatusPost)).toHaveLength(calls);
    expect(timers.step()).toBe(false);
    await wallet.vault.unlock({ kind: "password", password: PASSWORD });
  });

  it("a lock and unlock during the in-call reconcile leave its cloid out of the new session", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    let orderExists = false;
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: async () => new Promise<never>(() => {}),
      info: orderStatusAfter(() => orderExists, orderFound("filled", { sz: "0" })),
    });
    const { group } = await enable(provider, wallet, walletId);
    const corrections: HyperliquidOutcomeCorrection[] = [];
    provider.trade.corrections.subscribe((correction) => corrections.push(correction));

    // The POST is lost; step until the in-call orderStatus polling has begun.
    const placing = provider.trade.place(group, ORDER);
    placing.catch(() => undefined);
    await stepUntil(timers, () => posted.some(isOrderStatusPost));

    // The session that placed the order ends while its reconcile is still polling.
    await wallet.vault.lock();
    await wallet.vault.unlock({ kind: "password", password: PASSWORD });

    const result = await drive(timers, placing);
    expect(result.outcomes).toStrictEqual([UNKNOWN]);

    // The order committed after all — but it belongs to the locked session: no late poll, no
    // correction in the new one.
    orderExists = true;
    await pump(timers, 3);
    expect(corrections).toStrictEqual([]);
  });

  it("the pending set is capped — the oldest unknown cloid is evicted", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    let orderExists = false;
    const { wallet, walletId } = await nodeWallet();
    const clock = createHyperliquidClock(timers.now);
    const transport = createHyperliquidTransport({
      network: "Testnet",
      fetch: serve(posted, timers, {
        exchange: async () => new Promise<never>(() => {}),
        info: orderStatusAfter(() => orderExists, orderFound("filled", { sz: "0" })),
      }),
      setTimer: timers.setTimer,
      now: timers.now,
      clock,
    });
    agentAddress ??= await sessions(wallet).create({
      scheme: "hyperliquid-l1-agent",
      limits: HL_LIMITS,
      verify: VERIFY,
      owner: { walletId, groupIndex: 0 },
      scope: "Testnet",
      name: "reconcile",
      validUntil: NOW + DAY,
    });
    await sessions(wallet).open(agentAddress, VERIFY);
    const group: HyperliquidGroup = { walletId, groupIndex: 0 };
    const exchange = createHyperliquidExchange({
      wallet,
      transport,
      clock,
      markets: createHyperliquidMarkets({ transport }),
      account: createHyperliquidAccount({ transport }),
      registry: {
        require: () => ({ address: agentAddress!, owner: MASTER, validUntil: NOW + DAY }),
      } as unknown as HyperliquidAgentRegistry,
      now: timers.now,
      setTimer: timers.setTimer,
    });
    const corrections: HyperliquidOutcomeCorrection[] = [];
    exchange.corrections.subscribe((correction) => corrections.push(correction));

    // 64 + 1 orders across two lost POSTs — one cloid over the pending cap.
    const cloid = (n: number): string => `0x${n.toString(16).padStart(32, "0")}`;
    const action = (from: number, count: number): HyperliquidL1Action => ({
      type: "order",
      orders: Array.from({ length: count }, (_, i) => ({
        a: 0,
        b: true,
        p: "58000",
        s: "0.05",
        r: false,
        t: { limit: { tif: "Gtc" as const } },
        c: cloid(from + i),
      })),
      grouping: "na",
    });
    const first = await drive(timers, exchange.order(group, action(1, 64)));
    const second = await drive(timers, exchange.order(group, action(65, 1)));
    expect(first.every((outcome) => outcome.kind === "unknown")).toBe(true);
    expect(second).toStrictEqual([{ kind: "unknown", cloid: cloid(65) }]);

    // Every pending cloid fills late; the evicted first one earns no correction.
    orderExists = true;
    await pump(timers, 3);
    const corrected = new Set(corrections.map((correction) => correction.cloid));
    expect(corrected.has(cloid(1))).toBe(false);
    expect(corrected.size).toBe(64);
  });

  it("a checksummed user and a mixed-case cloid still match the pending entry", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { wallet, walletId } = await nodeWallet();
    const clock = createHyperliquidClock(timers.now);
    const transport = createHyperliquidTransport({
      network: "Testnet",
      fetch: serve(posted, timers, { exchange: async () => new Promise<never>(() => {}) }),
      setTimer: timers.setTimer,
      now: timers.now,
      clock,
    });
    agentAddress ??= await sessions(wallet).create({
      scheme: "hyperliquid-l1-agent",
      limits: HL_LIMITS,
      verify: VERIFY,
      owner: { walletId, groupIndex: 0 },
      scope: "Testnet",
      name: "reconcile",
      validUntil: NOW + DAY,
    });
    await sessions(wallet).open(agentAddress, VERIFY);
    const group: HyperliquidGroup = { walletId, groupIndex: 0 };
    const exchange = createHyperliquidExchange({
      wallet,
      transport,
      clock,
      markets: createHyperliquidMarkets({ transport }),
      account: createHyperliquidAccount({ transport }),
      registry: {
        require: () => ({ address: agentAddress!, owner: MASTER, validUntil: NOW + DAY }),
      } as unknown as HyperliquidAgentRegistry,
      now: timers.now,
      setTimer: timers.setTimer,
    });
    const corrections: HyperliquidOutcomeCorrection[] = [];
    exchange.corrections.subscribe((correction) => corrections.push(correction));

    const cloid = "0xabcdef0123456789abcdef0123456789";
    const action: HyperliquidL1Action = {
      type: "order",
      orders: [
        {
          a: 0,
          b: true,
          p: "58000",
          s: "0.05",
          r: false,
          t: { limit: { tif: "Gtc" } },
          c: cloid,
        },
      ],
      grouping: "na",
    };
    const outcomes = await drive(timers, exchange.order(group, action));
    expect(outcomes).toStrictEqual([{ kind: "unknown", cloid }]);

    /* The echo spells the owner checksummed and the cloid upper-cased — the same order. */
    const upper = `0X${cloid.slice(2).toUpperCase()}`;
    exchange.sighted(MASTER.toUpperCase(), {
      orders: [{ coin: "BTC", oid: 99, cloid: upper }],
    });
    expect(corrections).toStrictEqual([
      { group, cloid: upper, outcome: { kind: "resting", oid: 99, cloid: upper } },
    ]);
  });

  it("an openOrders frame carrying the pending cloid corrects to resting without a poll", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const sockets: FakeSocket[] = [];
    const { provider, wallet, walletId } = await rig(
      posted,
      timers,
      { exchange: async () => new Promise<never>(() => {}) },
      { sockets },
    );
    const { group } = await enable(provider, wallet, walletId);
    const corrections: HyperliquidOutcomeCorrection[] = [];
    provider.trade.corrections.subscribe((correction) => corrections.push(correction));

    const result = await drive(timers, provider.trade.place(group, ORDER));
    expect(result.outcomes).toStrictEqual([UNKNOWN]);
    const calls = posted.filter(isOrderStatusPost).length;

    const view = provider.live?.openOrders(group);
    await tick();
    const s = sockets[0]!;
    s.open();
    s.push({
      channel: "subscriptionResponse",
      data: { method: "subscribe", subscription: s.frames("subscribe")[0] },
    });
    const { user } = s.frames("subscribe")[0] as { user: string };
    s.push({
      channel: "openOrders",
      data: { dex: "", user, orders: [{ coin: "BTC", oid: 99, cloid: CLOID }] },
    });
    expect(corrections).toStrictEqual([
      { group, cloid: CLOID, outcome: { kind: "resting", oid: 99, cloid: CLOID } },
    ]);
    // Proven by the frame — the late poll made no orderStatus call for it.
    expect(posted.filter(isOrderStatusPost)).toHaveLength(calls);
    await view?.close();
  });

  it("a fills frame carrying the pending cloid triggers an immediate orderStatus lookup", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const sockets: FakeSocket[] = [];
    let orderExists = false;
    const { provider, wallet, walletId } = await rig(
      posted,
      timers,
      {
        exchange: async () => new Promise<never>(() => {}),
        info: orderStatusAfter(() => orderExists, orderFound("filled", { sz: "0" })),
      },
      { sockets },
    );
    const { group } = await enable(provider, wallet, walletId);
    const corrections: HyperliquidOutcomeCorrection[] = [];
    provider.trade.corrections.subscribe((correction) => corrections.push(correction));

    const result = await drive(timers, provider.trade.place(group, ORDER));
    expect(result.outcomes).toStrictEqual([UNKNOWN]);
    const calls = posted.filter(isOrderStatusPost).length;

    const view = provider.live?.fills(group);
    await tick();
    const s = sockets[0]!;
    s.open();
    s.push({
      channel: "subscriptionResponse",
      data: { method: "subscribe", subscription: s.frames("subscribe")[0] },
    });
    const { user } = s.frames("subscribe")[0] as { user: string };
    orderExists = true;
    s.push({
      channel: "userFills",
      data: { user, fills: [{ tid: 1, coin: "BTC", cloid: CLOID, oid: 424242 }], isSnapshot: true },
    });
    await tick();
    // The fill alone could not prove the fill — orderStatus was re-asked immediately.
    expect(posted.filter(isOrderStatusPost).length).toBeGreaterThan(calls);
    expect(corrections).toStrictEqual([
      {
        group,
        cloid: CLOID,
        outcome: { kind: "filled", oid: 424242, cloid: CLOID, totalSz: "0.05" },
      },
    ]);
    await view?.close();
  });

  it("a filled answer without avgPx still reconciles — a misread is never a verdict", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.05", oid: 8 } }] } },
      }),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await drive(timers, provider.trade.place(group, ORDER));

    // orderStatus carries no fill price — without avgPx the status list answer cannot be trusted.
    expect(result.outcomes).toStrictEqual([UNKNOWN]);
  });
});

describe("hyperliquid trade — response mapping", () => {
  const statuses = (entries: ReadonlyArray<unknown>) => ({
    status: "ok",
    response: { type: "order", data: { statuses: entries } },
  });

  it.each([
    ["resting", [{ resting: { oid: 7 } }], [{ kind: "resting", oid: 7, cloid: CLOID }]],
    [
      "filled",
      [{ filled: { totalSz: "0.05", avgPx: "57900", oid: 8 } }],
      [{ kind: "filled", oid: 8, cloid: CLOID, totalSz: "0.05", avgPx: "57900" }],
    ],
    [
      "tick",
      [{ error: "Price must be divisible by tick size." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "tick",
          message: "Price must be divisible by tick size.",
        },
      ],
    ],
    [
      "min-notional",
      [{ error: "Order must have minimum value of $10." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "min-notional",
          message: "Order must have minimum value of $10.",
        },
      ],
    ],
    [
      "margin",
      [{ error: "Insufficient margin to place order." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "margin",
          message: "Insufficient margin to place order.",
        },
      ],
    ],
    [
      "reduce-only",
      [{ error: "Reduce only order would increase position." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "reduce-only",
          message: "Reduce only order would increase position.",
        },
      ],
    ],
    [
      "post-only",
      [{ error: "Post only order would have immediately matched, bbo was x." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "post-only-would-match",
          message: "Post only order would have immediately matched, bbo was x.",
        },
      ],
    ],
    [
      "ioc",
      [{ error: "Order could not immediately match against any resting orders." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "ioc-no-match",
          message: "Order could not immediately match against any resting orders.",
        },
      ],
    ],
    [
      "trigger",
      [{ error: "Invalid TP/SL price." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "bad-trigger",
          message: "Invalid TP/SL price.",
        },
      ],
    ],
    [
      "liquidity",
      [{ error: "No liquidity available for market order." }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "no-liquidity",
          message: "No liquidity available for market order.",
        },
      ],
    ],
    [
      "oi cap",
      [{ error: "Order would increase open interest while open interest is capped" }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "open-interest-cap",
          message: "Order would increase open interest while open interest is capped",
        },
      ],
    ],
    [
      "spot balance",
      [{ error: "(Spot-only) Order has insufficient spot balance to trade" }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "insufficient-spot-balance",
          message: "(Spot-only) Order has insufficient spot balance to trade",
        },
      ],
    ],
    [
      "oracle",
      [{ error: "Order price too far from oracle" }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "oracle",
          message: "Order price too far from oracle",
        },
      ],
    ],
    [
      "max position",
      [{ error: "Order would cause position to exceed margin tier limit at current leverage" }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "max-position",
          message: "Order would cause position to exceed margin tier limit at current leverage",
        },
      ],
    ],
    [
      "other",
      [{ error: "something unexpected" }],
      [
        {
          kind: "rejected",
          cloid: CLOID,
          reason: "other",
          message: "something unexpected",
        },
      ],
    ],
    ["waiting", ["waitingForTrigger"], [{ kind: "resting", cloid: CLOID }]],
  ] as const)("%s statuses map to typed outcomes", async (_name, entries, expected) => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => statuses(entries),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await provider.trade.place(group, ORDER);
    expect(result.outcomes).toStrictEqual(expected);
  });

  it("a single pre-validation error applies to the whole batch", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => statuses([{ error: "Insufficient margin to place order." }]),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await provider.trade.place(group, {
      ...ORDER,
      takeProfit: { triggerPx: "60000", price: "60000" },
      stopLoss: { triggerPx: "55000", price: "54000" },
    });
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toMatchObject({ kind: "rejected", reason: "margin" });
    expect(result.outcomes[2]).toMatchObject({ kind: "rejected", reason: "margin" });
  });

  it("cancel statuses map per element", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: {
          type: "cancel",
          data: {
            statuses: [
              "success",
              { error: "Order was never placed, already canceled, or filled." },
            ],
          },
        },
      }),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await provider.trade.cancel(group, [
      { coin: "BTC", oid: 1 },
      { coin: "BTC", oid: 2 },
    ]);
    expect(result).toStrictEqual([
      { kind: "cancelled" },
      { kind: "rejected", message: "Order was never placed, already canceled, or filled." },
    ]);
  });
});

describe("hyperliquid trade — wire actions", () => {
  const actionOf = (posted: Posted[]): Record<string, unknown> => {
    const post = posted.find((entry) => entry.endpoint === "exchange");
    if (post === undefined) {
      throw new Error("no exchange post");
    }
    return post.body["action"] as Record<string, unknown>;
  };

  const wire = async (
    run: (
      provider: Omit<HyperliquidProvider, "approveBuilder"> & HyperliquidProviderInternals,
      group: { walletId: string; groupIndex: number },
    ) => Promise<unknown>,
    answers: Parameters<typeof serve>[2] = {},
  ): Promise<Record<string, unknown>> => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, answers);
    const { group } = await enable(provider, wallet, walletId);
    await run(provider, group);
    return actionOf(posted);
  };

  it("modify replaces by oid and keeps the kernel's key order", async () => {
    const action = await wire(async (provider, group) =>
      provider.trade.modify(group, {
        oid: 5000000003,
        coin: "ETH",
        side: "buy",
        size: "0.25",
        reduceOnly: true,
        order: { kind: "limit", price: "1600" },
      }),
    );
    // ETH is index 4 in the recorded testnet meta.
    expect(action).toStrictEqual({
      type: "modify",
      oid: 5000000003,
      order: { a: 4, b: true, p: "1600", s: "0.25", r: true, t: { limit: { tif: "Gtc" } } },
    });
  });

  it("batchModify wraps several modifies", async () => {
    const action = await wire(async (provider, group) =>
      provider.trade.batchModify(group, [
        {
          oid: 1,
          coin: "BTC",
          side: "buy",
          size: "0.1",
          order: { kind: "limit", price: "30000", tif: "Alo" },
        },
      ]),
    );
    expect(action).toStrictEqual({
      type: "batchModify",
      modifies: [
        {
          oid: 1,
          order: { a: 3, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Alo" } } },
        },
      ],
    });
  });

  it("cancel and cancelByCloid use the cancel wire shapes", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      exchange: () => ({
        status: "ok",
        response: { type: "cancel", data: { statuses: ["success"] } },
      }),
    });
    const { group } = await enable(provider, wallet, walletId);
    await provider.trade.cancel(group, [{ coin: "BTC", oid: 5000000001 }]);
    expect(actionOf(posted)).toStrictEqual({
      type: "cancel",
      cancels: [{ a: 3, o: 5000000001 }],
    });
    await provider.trade.cancelByCloid(group, [
      { coin: "ETH", cloid: "0x0000000000000000000000000000000f" },
    ]);
    const posts = posted.filter((entry) => entry.endpoint === "exchange");
    expect(posts[1]?.body["action"]).toStrictEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 4, cloid: "0x0000000000000000000000000000000f" }],
    });
  });

  it("cancelAll batches every open order into ≤64-entry cancel actions", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const opens = Array.from({ length: 70 }, (_, i) => ({ coin: "BTC", oid: i + 1 }));
    const { provider, wallet, walletId } = await rig(posted, timers, {
      info: whenType("frontendOpenOrders", opens),
      exchange: (body) => {
        const action = body["action"] as { cancels: ReadonlyArray<unknown> };
        return {
          status: "ok",
          response: {
            type: "cancel",
            data: { statuses: Array.from({ length: action.cancels.length }, () => "success") },
          },
        };
      },
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await provider.trade.cancelAll(group);
    expect(result).toHaveLength(70);
    const posts = posted.filter((entry) => entry.endpoint === "exchange");
    expect(posts).toHaveLength(2);
    const first = posts[0]?.body["action"] as { cancels: ReadonlyArray<unknown> };
    const second = posts[1]?.body["action"] as { cancels: ReadonlyArray<unknown> };
    expect(first.cancels).toHaveLength(64);
    expect(second.cancels).toHaveLength(6);
    expect(first.cancels[0]).toStrictEqual({ a: 3, o: 1 });
  });

  it("twapCancel uses the twap wire shape", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers);
    const { group } = await enable(provider, wallet, walletId);

    await provider.trade.twapCancel(group, { coin: "BTC", twapId: 42 });
    expect(actionOf(posted)).toStrictEqual({ type: "twapCancel", a: 3, t: 42 });
  });

  it("setLeverage and adjustMargin post the account wire actions", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers);
    const { group } = await enable(provider, wallet, walletId);

    await provider.trade.setLeverage(group, { coin: "BTC", leverage: 10, marginMode: "cross" });
    expect(actionOf(posted)).toStrictEqual({
      type: "updateLeverage",
      asset: 3,
      isCross: true,
      leverage: 10,
    });
    await provider.trade.adjustMargin(group, { coin: "BTC", amount: "-1" });
    const posts = posted.filter((entry) => entry.endpoint === "exchange");
    expect(posts[1]?.body["action"]).toStrictEqual({
      type: "updateIsolatedMargin",
      asset: 3,
      isBuy: true,
      ntli: -1_000_000,
    });
  });

  it("close places a reduce-only market order for the whole position", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers, {
      info: whenType("clearinghouseState", STATE),
      exchange: () => ({
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ filled: { totalSz: "0.5", avgPx: "57000", oid: 9 } }] },
        },
      }),
    });
    const { group } = await enable(provider, wallet, walletId);

    const result = await provider.trade.close(group, { coin: "BTC", slippageBps: 100 });
    const action = actionOf(posted) as {
      orders: Array<Record<string, unknown>>;
      grouping: string;
    };
    expect(action.orders[0]).toMatchObject({ a: 3, b: true, s: "0.5", r: true });
    expect(action.orders[0]?.["t"]).toStrictEqual({ limit: { tif: "Ioc" } });
    expect(result.outcomes[0]?.kind).toBe("filled");
  });

  it("min notional and rounding rules hold on the wire", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    const { provider, wallet, walletId } = await rig(posted, timers);
    const { group } = await enable(provider, wallet, walletId);

    await expect(
      category(
        provider.trade.place(group, {
          coin: "BTC",
          side: "buy",
          size: "0.0001",
          order: { kind: "limit", price: "10" },
        }),
      ),
    ).resolves.toBe("invalid-input");

    // Buy rounds down / sell rounds up; 58000.5x would be 6 significant figures.
    const down = await provider.trade.place(group, {
      coin: "BTC",
      side: "buy",
      size: "0.01",
      order: { kind: "limit", price: "58000.55" },
    });
    expect(down.price).toBe("58000");
    const up = await provider.trade.place(group, {
      coin: "BTC",
      side: "sell",
      size: "0.01",
      order: { kind: "limit", price: "58000.55" },
    });
    expect(up.price).toBe("58001");
  });
});

describe("hyperliquid trade — agents and vectors", () => {
  it("an owner-mismatched agent is logged and never usable", async () => {
    const warnings: string[] = [];
    const walletGroup = { walletId: "w1", groupIndex: 0 };
    const agent = {
      address: "0xagent",
      scheme: "hyperliquid-l1-agent" as const,
      supported: true,
      owner: "0xSomeoneElse",
      walletId: "w1",
      groupIndex: 0,
      scope: "Testnet" as const,
      name: "forged",
      validUntil: NOW + DAY,
      createdAt: NOW,
      limits: null,
      spent: null,
    };
    const registry = createHyperliquidAgentRegistry({
      agents: { list: async () => Promise.resolve([agent]) },
      evmAddress: async () => Promise.resolve("0xGroupOwner"),
      network: "Testnet",
      now: () => NOW,
      logger: { warn: (m) => warnings.push(m) },
    });
    await registry.refresh();
    registry.markEnabled("0xagent");
    expect(warnings).toHaveLength(1);
    expect(() => registry.require(walletGroup)).toThrow(/no Hyperliquid agent/u);
  });

  it("the registry picks the qualifying agent with the latest validUntil", async () => {
    const mk = (address: string, validUntil: number) => ({
      address,
      scheme: "hyperliquid-l1-agent" as const,
      supported: true,
      owner: "0xGroupOwner",
      walletId: "w1",
      groupIndex: 0,
      scope: "Testnet" as const,
      name: address,
      validUntil,
      createdAt: NOW,
      limits: null,
      spent: null,
    });
    const registry = createHyperliquidAgentRegistry({
      agents: {
        list: async () =>
          Promise.resolve([
            mk("0xaaa", NOW + 10_000),
            mk("0xbbb", NOW + 20_000),
            mk("0xccc", NOW + 30_000),
          ]),
      },
      evmAddress: async () => Promise.resolve("0xgroupowner"),
      network: "Testnet",
      now: () => NOW,
      logger: { warn: () => undefined },
    });
    await registry.refresh();
    registry.markEnabled("0xaaa");
    registry.markEnabled("0xbbb");
    registry.markRejected("0xccc");
    const found = registry.require({ walletId: "w1", groupIndex: 0 });
    expect(found.address).toBe("0xbbb");
  });

  it("rejects network-filtered agents of another network", async () => {
    const registry = createHyperliquidAgentRegistry({
      agents: {
        list: async () =>
          Promise.resolve([
            {
              address: "0xother",
              scheme: "hyperliquid-l1-agent" as const,
              supported: true,
              owner: "0xGroupOwner",
              walletId: "w1",
              groupIndex: 0,
              scope: "Mainnet" as const,
              name: "main",
              validUntil: NOW + DAY,
              createdAt: NOW,
              limits: null,
              spent: null,
            },
          ]),
      },
      evmAddress: async () => Promise.resolve("0xgroupowner"),
      network: "Testnet",
      now: () => NOW,
      logger: { warn: () => undefined },
    });
    await registry.refresh();
    registry.markEnabled("0xother");
    expect(() => registry.require({ walletId: "w1", groupIndex: 0 })).toThrow(
      /no Hyperliquid agent/u,
    );
  });
});
