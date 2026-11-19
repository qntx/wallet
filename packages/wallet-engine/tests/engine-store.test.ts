/**
 * Engine store lifecycle: every controller reads the one session EngineStore the engine opens at
 * unlock, so each unlock/lock round trip performs exactly one open and one close — nothing leaks
 * subkeys or connections per cycle.
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
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const until = async (read: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Reads until the value has not changed for `ms`; returns the settled value. */
const stable = async (read: () => number, ms = 400): Promise<number> => {
  let last = read();
  let since = Date.now();
  while (Date.now() - since < ms) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 50));
    const v = read();
    if (v !== last) {
      last = v;
      since = Date.now();
    }
  }
  return last;
};

describe("WalletEngine session store", () => {
  it("opens and closes exactly one EngineStore per unlock/lock cycle", async () => {
    let opens = 0;
    let closes = 0;
    const backing = new Map<string, Map<string, Uint8Array>>();
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
    const engine = createWalletEngine({
      publicStore: createMemoryPublicStore(),
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      wallet,
      sparkNetwork: "regtest",
      fetch: async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url !== "https://solana.invalid" || init?.method !== "POST") {
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve(
          Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32_601, message: "unmocked" } }),
        );
      },
      random: (n) => randomBytes(n),
      now: () => Date.now(),
      logger: { warn: () => undefined },
      showCallsStatus: () => undefined,
      openStore: async () => {
        opens += 1;
        const s = createMemoryEngineStore({ collections: backing });
        return {
          ...s,
          close: async () => {
            closes += 1;
            await s.close();
          },
        };
      },
      rpc: { [SOL_NET]: ["https://solana.invalid"] },
    });
    try {
      await wallet.wallets.importMnemonic({
        mnemonic: MNEMONIC,
        factor: { kind: "password", password: PASSWORD },
      });
      await until(() => engine.accounts.getState().selected !== null);
      expect(await stable(() => opens)).toBe(1);
      expect(await stable(() => closes, 200)).toBe(0);

      await wallet.vault.lock();
      await until(() => closes === 1);
      expect(await stable(() => opens, 200)).toBe(1);

      await wallet.vault.unlock({ kind: "password", password: PASSWORD });
      await until(() => engine.accounts.getState().selected !== null);
      await wallet.vault.lock();
      await until(() => closes === 2);
      expect(await stable(() => opens, 200)).toBe(2);
    } finally {
      engine.unsubscribe();
      await wallet.destroy();
    }
  }, 60_000);
});
