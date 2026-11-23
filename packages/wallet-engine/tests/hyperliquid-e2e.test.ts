/**
 * Gated testnet e2e (ENGINE_E2E_HYPERLIQUID=1): real fetch and WebSocket against
 * api.hyperliquid-testnet.xyz. The unauthenticated half reads markets and drives live views to
 * `live`; the authenticated half additionally needs HYPERLIQUID_TESTNET_MNEMONIC — a mnemonic whose
 * m/44'/60'/0'/0/0 has a funded testnet account (the faucet requires a mainnet deposit by the same
 * address). It enables through a real kernel + real RequestController (auto-approved with the
 * password factor), rests a far-from-market post-only order, cancels it and disables with revoke —
 * the ApproveAgent acceptance is the signature-acceptance proof.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { hyperliquid as hyperliquidApp } from "../src/apps/hyperliquid/index.ts";
import { createHyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";
import type { AppSocket } from "../src/apps/hyperliquid/socket.ts";
import { createHyperliquidSocket } from "../src/apps/hyperliquid/socket.ts";
import { createApps } from "../src/apps/index.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { AcknowledgementRequiredError, RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const RUN = process.env["ENGINE_E2E_HYPERLIQUID"] === "1";
const MNEMONIC = process.env["HYPERLIQUID_TESTNET_MNEMONIC"];
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const VERIFY = { kind: "password" as const, password: "testnet e2e password" };
const TIMEOUT = 60_000;

const now = (): number => Date.now();
const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};
const random = (length: number): Uint8Array => new Uint8Array(randomBytes(length));
const realFetch = globalThis.fetch.bind(globalThis);
/* No gateway in the e2e environment — eligibility answers "available" so the flows run. */
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/v1/eligibility")) {
    return Response.json({
      country: null,
      region: null,
      apps: { hyperliquid: "available", polymarket: "available" },
    });
  }
  return realFetch(input, init);
};
const logger = { warn: (...args: unknown[]) => console.warn("apps warn:", ...args) };

/** Wait until `cond` holds — real time, throws after `ms`. */
const waitFor = async (cond: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !cond()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a real-time wait polls serially.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  throw new Error("e2e condition never held");
};

describe.runIf(RUN)("hyperliquid e2e: testnet reads + live", () => {
  it(
    "answers market reads and live views reach live",
    async () => {
      const socket = createHyperliquidSocket({
        network: "Testnet",
        socket: (url) => new WebSocket(url) as AppSocket,
        setTimer,
        random,
      });
      const p = createHyperliquidProvider({
        network: "Testnet",
        fetch,
        now,
        setTimer,
        wallet: Object.create(null) as Wallet, // reads never touch the wallet
        random,
        logger,
        socket,
      });
      const [meta] = await p.markets.perps();
      expect(meta.universe.length).toBeGreaterThan(0);
      const mids = await p.markets.mids();
      expect(mids["BTC"]).toBeTypeOf("string");
      const book = await p.markets.book({ coin: "BTC" });
      expect(book?.levels[0]?.length).toBeGreaterThan(0);

      const bookView = p.live?.book("BTC");
      const tradesView = p.live?.trades("BTC");
      expect(bookView).toBeDefined();
      expect(tradesView).toBeDefined();
      await waitFor(() => bookView?.getState().status === "live");
      await waitFor(() => tradesView?.getState().status === "live");
      expect(bookView?.getState().data?.coin).toBe("BTC");
      expect(tradesView?.getState().data?.length).toBeGreaterThan(0);
      await bookView?.close();
      await tradesView?.close();
      socket.close();
    },
    TIMEOUT,
  );
});

describe.runIf(RUN && MNEMONIC !== undefined)("hyperliquid e2e: testnet enable + order", () => {
  it("enables, rests a post-only order, cancels and revokes", async () => {
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
      spark: Object.create(null) as SparkController,
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
    const { controller, hyperliquid, destroy } = createApps({
      networks,
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
      apps: [hyperliquidApp({ network: "Testnet", agentName: "qntx-e2e" })],
    });
    await networks.init();
    await transactions.init();
    await requests.init();
    const group = { walletId, groupIndex: 0 };
    const groupState = (): { status?: string; requestId?: string } | undefined =>
      controller.getState().groups[`${walletId}/0`]?.["hyperliquid"];
    const approve = async (id: string): Promise<void> => {
      try {
        await requests.approve(id, "evm-sign", { verify: VERIFY });
      } catch (error) {
        // oxlint-disable-next-line vitest/no-conditional-in-test -- error narrowing.
        if (!(error instanceof AcknowledgementRequiredError)) {
          throw error;
        }
        await requests.approve(id, "evm-sign", {
          verify: VERIFY,
          acknowledged: error.required,
        });
      }
    };
    /* Auto-approve every request the flows publish — the password factor stands in for the
       approval UI. */
    const unsub = controller.store.subscribe((s) => {
      const id = s.groups[`${walletId}/0`]?.["hyperliquid"]?.requestId;
      // oxlint-disable-next-line vitest/no-conditional-in-test -- a reactive callback, not a branch.
      if (id !== undefined) {
        void approve(id).catch(() => undefined);
      }
    });
    try {
      await waitFor(() => controller.getState().eligibility.status === "ready");
      await controller.acknowledgeTerms(group, "hyperliquid");
      const enabling = controller.enable(group, "hyperliquid");
      await waitFor(() => groupState()?.status === "enabled");
      await enabling;

      const ownerAccount = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:421614",
      });
      // oxlint-disable-next-line vitest/no-conditional-in-test -- union narrowing.
      if (!("address" in ownerAccount)) {
        throw new Error("no EVM address for the group");
      }
      const owner = ownerAccount.address;

      /* A post-only order far under the market rests without filling — it proves the agent
         signature is accepted while never executing. */
      const mids = await hyperliquid.markets.mids();
      const mark = Number(mids["BTC"]);
      const resting = await hyperliquid.trade.place(group, {
        coin: "BTC",
        side: "buy",
        size: "0.001",
        order: { kind: "limit", price: String(Math.floor(mark * 0.01)), tif: "Alo" },
      });
      const [placed] = resting.outcomes;
      expect(placed?.kind).toBe("resting");
      const open = await hyperliquid.account.openOrders({ user: owner });
      expect(open.some((o) => o.coin === "BTC")).toBe(true);
      const cancelled = await hyperliquid.trade.cancelAll(group);
      expect(cancelled.length).toBeGreaterThan(0);

      const disabling = controller.disable(group, "hyperliquid", { revoke: true });
      await waitFor(() => !["enabled", "enabling"].includes(String(groupState()?.status)));
      await disabling;
      expect(groupState()?.status).toBe("disabled");
    } finally {
      unsub();
      await destroy();
    }
  }, 120_000);
});
