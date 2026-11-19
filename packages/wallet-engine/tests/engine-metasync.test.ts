/**
 * Engine start order: meta sync pulls run in the background — a relay fetch that never answers
 * must not delay transaction recovery or the request pipeline after unlock.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAINNET = "eip155:1";

describe("WalletEngine meta sync start", () => {
  it("reaches requests-ready while a relay pull is still in flight", async () => {
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
    // Import before the engine exists so its first transition already sees the wallet — a pull
    // started from a later snapshot event would run off the critical path on its own.
    await wallet.wallets.importMnemonic({
      mnemonic: MNEMONIC,
      factor: { kind: "password", password: PASSWORD },
    });
    const walletId = wallet.getSnapshot().wallets[0]?.walletId;
    if (walletId === undefined) {
      throw new Error("no wallet in snapshot");
    }
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
      metaSync: {
        tag: "qntx-test",
        relays: {
          // A relay that never answers — the pull stays "syncing" forever.
          fetch: async () => new Promise<never>(() => {}),
          publish: async () => Promise.resolve(),
        },
      },
    });
    try {
      const account = {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "evm.bip44" as const,
      };
      const input = {
        method: "evm-sign" as const,
        origin: { kind: "browser" as const, origin: "https://dapp.test" },
        account,
        network: MAINNET,
        request: {
          kind: "evm.personal-message" as const,
          network: MAINNET,
          account,
          message: new Uint8Array([1, 2, 3]),
        },
      };

      // requests.init is the last step of the start sequence: a prepare that stops failing with
      // "unlocked vault" proves the sequence completed even though the relay pull still hangs.
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const request = await engine.requests.prepare(input);
          expect(request.stage).toBe("awaiting-approval");
          engine.requests.reject(request.id);
          break;
        } catch (error) {
          if (Date.now() > deadline || !String(error).includes("unlocked vault")) {
            throw error;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- polling for pipeline readiness
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      // The pull that would have blocked the old start order is still unfinished.
      expect(engine.metaSync.getState().wallets[walletId]?.status).toBe("syncing");

      await wallet.vault.lock();
    } finally {
      engine.unsubscribe();
      await wallet.destroy();
    }
  }, 60_000);
});
