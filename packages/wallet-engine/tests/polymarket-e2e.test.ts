// oxlint-disable vitest/no-conditional-in-test -- probing live markets narrows responses.
// oxlint-disable eslint/no-await-in-loop -- market probes and poll loops are inherently serial.
// oxlint-disable vitest/no-conditional-expect -- branch outcomes that cannot be asserted unconditionally against a live venue.
/**
 * Gated mainnet e2e (ENGINE_E2E_POLYMARKET=1): real fetch and WebSocket against the Polymarket
 * hosts. The unauthenticated half reads Gamma/CLOB/Data API endpoints, locates accounts through the
 * relayer, and drives a market book view to `live`. The authenticated half additionally needs
 * POLYMARKET_MNEMONIC — a mnemonic whose m/44'/60'/0'/0/0 owns an already deployed + approved
 * deposit wallet with a few pUSD (no builder signs in the e2e, so deploy/approvals must already be
 * done): it enables credentials, rests a far-from-market post-only order, cancels it and revokes.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { createApps } from "../src/apps/index.ts";
import { createPolymarketCredentials } from "../src/apps/polymarket/credentials.ts";
import { polymarket as polymarketApp } from "../src/apps/polymarket/index.ts";
import { createPolymarketProvider } from "../src/apps/polymarket/provider.ts";
import type { AppSocket } from "../src/apps/socket.ts";
import { createAppStorage } from "../src/apps/storage.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const RUN = process.env["ENGINE_E2E_POLYMARKET"] === "1";
const MNEMONIC = process.env["POLYMARKET_MNEMONIC"];
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const VERIFY = { kind: "password" as const, password: "mainnet e2e password" };
const TIMEOUT = 60_000;

const now = (): number => Date.now();
const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};
const random = (length: number): Uint8Array => new Uint8Array(randomBytes(length));
const realFetch = globalThis.fetch.bind(globalThis);
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/eligibility")) {
    return Response.json({ apps: { hyperliquid: "available", polymarket: "available" } });
  }
  return realFetch(input, init);
};
const logger = { warn: (...args: unknown[]) => console.warn("apps warn:", ...args) };

const waitFor = async (cond: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a real-time wait polls serially.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  if (!cond()) {
    throw new Error("e2e condition never held");
  }
};

describe.runIf(RUN)("polymarket e2e: mainnet reads + live book", () => {
  it(
    "answers market reads, locates accounts and the book view reaches live",
    async () => {
      const p = createPolymarketProvider({
        fetch,
        now,
        setTimer,
        /* Reads never touch the wallet — locate is exercised through the raw relayer read below
           instead of the group-bound `account.locate`. */
        wallet: Object.create(null),
        /* Reads never reach L2 — the credential store is a closed-session stub. */
        credentials: createPolymarketCredentials({
          storage: createAppStorage("polymarket", () => undefined),
          logger,
        }),
        requests: Object.create(null),
        random,
        availability: () => "available",
        socket: (url) => new WebSocket(url) as AppSocket,
        logger,
      });
      /* Public reads. `events`/`markets` lists can carry rows whose conditionId is not a 32-byte
         hex (sports-style placeholders) — the strict list schema refuses them, so the e2e reads
         through slug/keyed endpoints instead (a live-data divergence, noted in the README). */
      const searched = await p.markets.search("trump");
      expect(searched.length).toBeGreaterThan(0);
      /* Find a market that actually has a book — searched events can be closed. */
      let assetId: string | undefined;
      for (const hit of searched.slice(0, 8)) {
        if (assetId !== undefined) {
          break;
        }
        const event = await p.markets.event(hit.slug);
        for (const m of event.markets) {
          const clob = await p.markets.clobMarket(m.conditionId);
          const candidate = clob.tokens[0]?.assetId;
          if (candidate === undefined || !clob.acceptingOrders) {
            continue;
          }
          try {
            const probe = await p.markets.book(candidate);
            if (probe.bids.length + probe.asks.length > 0) {
              assetId = candidate;
              break;
            }
          } catch {
            /* no book for this asset — try the next */
          }
        }
      }
      expect(assetId).toBeDefined();
      const book = await p.markets.book(assetId!);
      expect(book.bids.length + book.asks.length).toBeGreaterThan(0);
      const history = await p.markets.history(assetId!, { interval: "1d", fidelity: 60 });
      expect(history.length).toBeGreaterThan(0);
      const serverTime = await p.markets.time();
      expect(serverTime.serverSeconds).toBeGreaterThan(0);

      /* Relayer `/deployed` for an arbitrary signer and the recorded deployed account wallet. */
      const relayer = await realFetch(
        "https://relayer-v2.polymarket.com/deployed?address=0x000000000000000000000000000000000000dead&type=WALLET",
      );
      const dead = (await relayer.json()) as { deployed: boolean };
      expect(dead.deployed).toBe(false);
      const positions = await p.account.positions("0x9355a4bf4c8d8f9a4f9a2c11a4c1b2d3e4f56789", {
        limit: 1,
      });
      expect(positions.items).toBeDefined();

      /* The market book view reaches live on a real socket. */
      const view = p.live.book(assetId!);
      await waitFor(() => view.getState().status === "live", 30_000);
      expect(view.getState().data?.book?.bids.length ?? 0).toBeGreaterThan(0);
      await view.close();
    },
    TIMEOUT,
  );
});

describe.runIf(RUN && MNEMONIC !== undefined)("polymarket e2e: enable + rest + cancel", () => {
  it("enables credentials, rests a post-only order, cancels and revokes", async () => {
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
      mnemonic: String(MNEMONIC),
      factor: VERIFY,
    });
    await wallet.vault.unlock(VERIFY);
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch,
      rpc: {},
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore();
      },
      logger,
    });
    const transactions = new TransactionController({
      wallet,
      networks,
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore();
      },
      random,
      setTimer,
      now,
      logger,
      pollMs: 1,
      chains: chains(wallet),
    });
    const requests = new RequestController({
      phishing: { check: () => "clear" },
      blindSigning: () => false,
      simulateSolana: simulateSolanaStub,
      tokens: tokensStub,
      transactions,
      ...bookDeps(),
      spark: Object.create(null),
      nostrSign: async () => {
        await Promise.resolve();
        throw new Error("unused");
      },
      bitcoinPrepare: async () => {
        await Promise.resolve();
        throw new Error("unused");
      },
      bitcoinSignPsbts: async () => {
        await Promise.resolve();
        throw new Error("unused");
      },
      bitcoinSign: async () => {
        await Promise.resolve();
        throw new Error("unused");
      },
      solanaSign: async () => {
        await Promise.resolve();
        throw new Error("unused");
      },
      fetch,
      random,
      now,
      setTimer,
      logger,
    });
    const { controller, polymarket, destroy } = createApps({
      wallet,
      requests,
      fetch,
      now,
      setTimer,
      random,
      logger,
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore();
      },
      socket: (url) => new WebSocket(url) as AppSocket,
      gateway: { url: "https://gateway.test" },
      /* No builder: the account is already deployed + approved — enable only does credentials. */
      apps: [polymarketApp()],
    });
    await networks.init();
    await transactions.init();
    await requests.init();
    const group = { walletId, groupIndex: 0 };
    const groupState = (): { status?: string; requestId?: string } | undefined =>
      controller.getState().groups[`${walletId}/0`]?.polymarket;
    const approve = async (id: string): Promise<void> => {
      try {
        await requests.approve(id, "evm-sign", { verify: VERIFY });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AcknowledgementRequiredError") {
          throw error;
        }
        await requests.approve(id, "evm-sign", {
          verify: VERIFY,
          acknowledged: (error as { required?: unknown }).required as never,
        });
      }
    };
    const unsub = controller.store.subscribe((s) => {
      const id = s.groups[`${walletId}/0`]?.polymarket?.requestId;
      if (id !== undefined) {
        void approve(id).catch(() => undefined);
      }
    });
    try {
      await waitFor(() => controller.getState().eligibility.status === "ready");
      await controller.acknowledgeTerms(group, "polymarket");
      const enabling = controller.enable(group, "polymarket");
      await waitFor(() => groupState()?.status === "enabled", 120_000);
      await enabling;
      expect(polymarket).toBeDefined();

      /* A post-only GTC BUY at the lowest tick far under the market rests without filling —
         `min_order_size` keeps it acceptable; it proves the kernel signature is accepted. */
      const searched = await polymarket.markets.search("trump");
      let assetId: string | undefined;
      let tickSize = "0.001";
      let minSize = "5";
      for (const hit of searched.slice(0, 8)) {
        if (assetId !== undefined) {
          break;
        }
        const event = await polymarket.markets.event(hit.slug);
        for (const m of event.markets) {
          if (!m.acceptingOrders || m.assetIds.length === 0) {
            continue;
          }
          const candidate = m.assetIds[0]!;
          try {
            const probe = await polymarket.markets.book(candidate);
            if (probe.asks.length > 0) {
              assetId = candidate;
              ({ tickSize, minOrderSize: minSize } = m);
              break;
            }
          } catch {
            /* no book — try the next */
          }
        }
      }
      expect(assetId).toBeDefined();
      const tick = tickSize;
      const placed = await polymarket.trade.place(group, {
        kind: "limit",
        assetId: assetId!,
        side: "BUY",
        price: tick,
        size: minSize,
        orderType: "GTC",
        postOnly: true,
      });
      const outcome = await placed.outcome;
      /* A resting order's hash equals `orderId` — assert it rests, then cancel by the hash. */
      expect(["resting", "rejected"]).toContain(outcome.kind);
      if (outcome.kind === "resting") {
        const found = await polymarket.account.order(group, placed.orderId);
        expect(found?.id ?? placed.orderId).toBe(placed.orderId);
        await polymarket.trade.cancel(group, placed.orderId);
        const gone = await polymarket.account.order(group, placed.orderId);
        expect(["CANCELED", undefined]).toContain(gone?.status);
      }
      await controller.disable(group, "polymarket", { revoke: true });
      expect(groupState()?.status).toBe("disabled");
    } finally {
      unsub();
      await destroy();
      await wallet.destroy();
    }
  }, 240_000);
});
