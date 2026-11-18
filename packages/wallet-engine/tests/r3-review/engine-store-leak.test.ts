/**
 * PoC for r3-review: several controllers call `options.openStore()` themselves in `init`
 * (transactions, history, prices, assets, networks, the requests sign log, the address book,
 * connections) but engine.ts `stop()` closes only the one store the engine itself opened.
 * Every other store — on Web each holds subkeys derived from the data key — is leaked per
 * unlock/lock cycle.
 * Correct behaviour: every store opened is closed on lock (the controllers should own and close
 * the store they opened, or the engine should hand them the one store it closes).
 * This test ASSERTS THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { createWalletEngine } from "../../src/engine.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../../src/store/memory.ts";

const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

async function until(read: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reads until the value has not changed for `ms`; returns the settled value. */
async function stable(read: () => number, ms = 500): Promise<number> {
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
}

describe("PoC: per-unlock engine stores are opened but never closed", () => {
  it("PoC: lock closes only the engine's own store — one close for every N opens, growing per cycle", async () => {
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
      const opensAfterUnlock = await stable(() => opens);
      const closesAfterUnlock = await stable(() => closes, 200);
      expect(closesAfterUnlock).toBe(0);

      await wallet.vault.lock();
      const closesAfterLock = await stable(() => closes);
      const opensAfterLock = await stable(() => opens, 200);
      console.log(
        `cycle 1: opens=${String(opensAfterUnlock)} closes=${String(closesAfterLock)}`,
      );
      // The engine opened N stores this unlock (its own + every controller's init), yet lock
      // closed only the single engine store.
      expect(opensAfterUnlock).toBeGreaterThan(1);
      expect(closesAfterLock).toBeLessThan(opensAfterUnlock);
      expect(opensAfterLock).toBe(opensAfterUnlock);

      // A second cycle leaks the same number again — growth per unlock/lock round trip.
      await wallet.vault.unlock({ kind: "password", password: PASSWORD });
      await until(() => engine.accounts.getState().selected !== null);
      const opensAfterUnlock2 = await stable(() => opens);
      await wallet.vault.lock();
      const closesAfterLock2 = await stable(() => closes);
      console.log(
        `cycle 2: opens=${String(opensAfterUnlock2)} closesAfterLock=${String(closesAfterLock2)}`,
      );
      expect(opensAfterUnlock2).toBeGreaterThan(opensAfterUnlock);
      expect(closesAfterLock2).toBeLessThan(opensAfterUnlock2);
      expect(closesAfterLock2 - closesAfterLock).toBeLessThan(
        opensAfterUnlock2 - opensAfterUnlock,
      );
    } finally {
      engine.unsubscribe();
      await wallet.destroy();
    }
  }, 60_000);
});
