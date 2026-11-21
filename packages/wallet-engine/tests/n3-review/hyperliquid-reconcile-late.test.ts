/**
 * An /exchange POST that times out is reconciled by polling `orderStatus` by cloid until the signed
 * action's expiry plus slack. A fill that lands one beat after the last poll cannot be reported:
 * the call already returned `not-placed`, and nothing walks the outcome back once the endpoint
 * starts answering the order exists.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import { createHyperliquidProvider } from "../../src/apps/hyperliquid/provider.ts";
import type {
  HyperliquidProvider,
  HyperliquidProviderInternals,
} from "../../src/apps/hyperliquid/provider.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const NOW = Date.now();
const DAY = 86_400_000;
const CLOID = "0x07070707070707070707070707070707";
const MASTER = "0x000000000000000000000000000000000000dead";

const MIDS = { BTC: "57957.5", ETH: "4000", "PURR/USDC": "0.5" };

const fixture = (name: string): { response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/hyperliquid/testnet/${name}.json`, import.meta.url), "utf8"),
  ) as { response: unknown };

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
    timers.step();
    if (settled) {
      break;
    }
  }
  if (!settled) {
    throw new Error("the call never settled");
  }
  return outcome;
};

const serve = (
  posted: Posted[],
  timers: Timers,
  answers: {
    readonly info?: (body: Record<string, unknown>) => unknown;
    readonly exchange?: (body: Record<string, unknown>) => unknown;
  },
) => {
  const produce = async (
    endpoint: "info" | "exchange",
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const headers = { date: new Date(timers.time).toUTCString() };
    if (endpoint === "exchange") {
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

const rig = async (
  posted: Posted[],
  timers: Timers,
  answers: Parameters<typeof serve>[2] = {},
): Promise<{
  provider: HyperliquidProvider & HyperliquidProviderInternals;
  wallet: Wallet;
  walletId: string;
}> => {
  const { wallet, walletId } = await nodeWallet();
  const provider = createHyperliquidProvider({
    network: "Testnet",
    fetch: serve(posted, timers, answers),
    now: timers.now,
    setTimer: timers.setTimer,
    wallet,
    random: (length) => new Uint8Array(length).fill(7),
    logger: { warn: () => undefined },
  });
  return { provider, wallet, walletId };
};

const ORDER = {
  coin: "BTC",
  side: "buy" as const,
  size: "0.05",
  order: { kind: "limit" as const, price: "58000" },
};

/** OrderStatus answers filled once the flag flips — the endpoint catching up after the call. */
const filledOrderStatus =
  (orderExists: () => boolean) =>
  (body: Record<string, unknown>): unknown => {
    if (body["type"] !== "orderStatus" || !orderExists()) {
      return undefined;
    }
    return {
      status: "order",
      order: {
        order: { oid: 424242, origSz: "0.05", sz: "0", limitPx: "58000" },
        status: "filled",
        statusTimestamp: NOW + 30_000,
      },
    };
  };

describe("an /exchange timeout whose cloid fills just past the reconcile deadline", () => {
  it("returns not-placed — the endpoint proving the fill answers only after the call returned", async () => {
    const posted: Posted[] = [];
    const timers = manualTimer();
    // unknownOid for every poll the reconcile makes; the order exists only after the call ended.
    let orderExists = false;
    const { provider, wallet, walletId } = await rig(posted, timers, {
      // Never answers: the transport's own deadline fires the abort.
      exchange: async () => new Promise<never>(() => {}),
      info: filledOrderStatus(() => orderExists),
    });
    const agentAddress = await hyperliquid(wallet).createAgent({
      owner: { walletId, groupIndex: 0 },
      network: "Testnet",
      name: "reconcile",
      validUntil: NOW + DAY,
    });
    await provider.agents.refresh();
    provider.agents.markEnabled(agentAddress);
    const group = { walletId, groupIndex: 0 };

    const result = await drive(timers, provider.trade.place(group, ORDER));

    expect(result.outcomes).toStrictEqual([{ kind: "not-placed", cloid: CLOID }]);
    // expiresAfter + 5 s skew + 2 s slack — the last poll ran past now+22 s.
    expect(timers.time).toBeGreaterThan(NOW + 22_000);

    // The order was committed all along: once the endpoint knows it, it answers filled — but the
    // already-returned outcome is never corrected.
    orderExists = true;
    const late = await provider.account.orderStatus({ user: MASTER, oid: CLOID });
    expect(late).toMatchObject({ status: "order", order: { status: "filled" } });
    expect(result.outcomes).toStrictEqual([{ kind: "not-placed", cloid: CLOID }]);
  });
});
