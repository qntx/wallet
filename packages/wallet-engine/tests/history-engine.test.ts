/**
 * Engine wiring: `WalletEngine.history` exists, initializes with the unlock transition and clears
 * on vault lock.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { createWalletEngine } from "../src/engine.ts";
import { HistoryController } from "../src/history/controller.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("WalletEngine.history", () => {
  it("exists and clears its groups on vault lock", async () => {
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
      authenticator: createSoftwarePasskey(randomBytes(32)),
      kernelUrl: KERNEL_URL,
    });
    try {
      const engine = createWalletEngine({
        publicStore: createMemoryPublicStore(),
        verifyEvent,
        weblnAlias: "test",
        lightningMaxFee: () => 0,
        wallet,
        sparkNetwork: "regtest",
        fetch: async () => Promise.reject(new Error("offline")),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: { warn: () => undefined },
        showCallsStatus: () => undefined,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
      });
      expect(engine.history).toBeInstanceOf(HistoryController);

      await wallet.wallets.importMnemonic({
        mnemonic: MNEMONIC,
        factor: { kind: "password", password: PASSWORD },
      });
      await sleep(100);
      (engine.history as HistoryController).store.setState({
        groups: {
          "w:0": { status: "ready", entries: [], hasMore: false, stale: false, errors: {} },
        },
      });

      await wallet.vault.lock();
      await sleep(200);
      expect(engine.history.getState().groups).toStrictEqual({});
    } finally {
      await wallet.destroy();
    }
  });
});
