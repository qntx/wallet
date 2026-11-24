/**
 * Engine-store rows live in the one session EngineStore and are keyed to live accounts:
 * notification rows under `wallet:<walletId>`/`sub:<walletId>:<family>`, approvals and NFT rows
 * under account keys, app rows in their own `apps.<id>` collections. Across a lock/unlock cycle the
 * reopened store reads every row back; after `vault.reset()` a new vault's wallets leave the old
 * rows unreachable — the engine's state only ever surfaces live walletIds and account keys.
 */
/* oxlint-disable vitest/no-conditional-in-test -- the respawn retry is inherently conditional */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { WalletError } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { createWalletEngine } from "../src/engine.ts";
import { createMemoryPublicStore } from "../src/store/memory.ts";
import type { EngineCollection, EngineStore } from "../src/store/port.ts";
import { keystoneIo, pairKeystone } from "./keystone-io.ts";

/**
 * A persistent EngineStore: the same contract as the memory one but `close()` keeps the backing,
 * the way the host's durable store survives a session end. The memory store wipes on close — it
 * could not model the read-back this test exists to prove.
 */
function persistentStore(backing: Map<string, Map<string, Uint8Array>>): EngineStore {
  let closed = false;
  return {
    collection(name: string): EngineCollection {
      let table = backing.get(name);
      if (table === undefined) {
        table = new Map();
        backing.set(name, table);
      }
      return {
        get: async (key) => {
          if (closed) {
            throw new Error("closed");
          }
          const value = table.get(key);
          return Promise.resolve(value === undefined ? undefined : new Uint8Array(value));
        },
        put: async (key, bytes) => {
          if (closed) {
            throw new Error("closed");
          }
          table.set(key, new Uint8Array(bytes));
          return Promise.resolve();
        },
        delete: async (key) => {
          if (closed) {
            throw new Error("closed");
          }
          table.delete(key);
          return Promise.resolve();
        },
        list: async () => {
          if (closed) {
            throw new Error("closed");
          }
          return Promise.resolve([...table.keys()]);
        },
      };
    },
    close: async () => {
      closed = true;
      return Promise.resolve();
    },
  };
}

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
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

describe("engine collections across lock, unlock and reset", () => {
  it("reads rows back after unlock and reaches none after a vault reset", async () => {
    const backing = new Map<string, Map<string, Uint8Array>>();
    let opened: EngineStore | undefined;
    let opens = 0;
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
      fetch: async () => Promise.reject(new Error("offline")),
      random: (n) => randomBytes(n),
      now: () => Date.now(),
      logger: { warn: () => undefined },
      showCallsStatus: () => undefined,
      openStore: async () => {
        opens += 1;
        opened = persistentStore(backing);
        return Promise.resolve(opened);
      },
      rpc: { [SOL_NET]: ["https://solana.invalid"] },
    });
    try {
      await wallet.wallets.importMnemonic({
        mnemonic: MNEMONIC_A,
        factor: { kind: "password", password: PASSWORD },
      });
      await until(() => opened !== undefined && opens === 1);
      const walletA = wallet.getSnapshot().wallets[0]!.walletId;

      // The rows the approvals, NFTs, notifications and app controllers write for vault A.
      const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
      const bytes = json({ row: true });
      const subRow = json({
        secret: "s".repeat(64),
        key: "k".repeat(64),
        id: "ab".repeat(16),
        networks: ["evm:eip155:1"],
        requested: ["evm:eip155:1"],
        addresses: [`0x${"aa".repeat(20)}`],
        token: "tok",
        refreshedAt: 1,
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
      await opened!.collection("approvals").put("eip155:1:0xaaaa", bytes);
      await opened!.collection("nfts").put("visibility", bytes);
      const optInRow = json({ enabled: true });
      await opened!.collection("notifications").put(`wallet:${walletA}`, optInRow);
      await opened!.collection("notifications").put(`sub:${walletA}:evm`, subRow);
      await opened!.collection("apps.hyperliquid").put("terms", bytes);

      // Lock/unlock: the reopened session store sees every row.
      await wallet.vault.lock();
      await wallet.vault.unlock({ kind: "password", password: PASSWORD });
      await until(() => opens === 2);
      await expect(opened!.collection("approvals").get("eip155:1:0xaaaa")).resolves.toStrictEqual(
        bytes,
      );
      await expect(opened!.collection("nfts").get("visibility")).resolves.toStrictEqual(bytes);
      await expect(
        opened!.collection("notifications").get(`wallet:${walletA}`),
      ).resolves.toStrictEqual(optInRow);
      await expect(
        opened!.collection("notifications").get(`sub:${walletA}:evm`),
      ).resolves.toStrictEqual(subRow);
      await expect(opened!.collection("apps.hyperliquid").get("terms")).resolves.toStrictEqual(
        bytes,
      );

      // Reset erases the vault; a new vault's wallet has a different id, so none of the rows
      // keyed to vault A's wallets and accounts is reachable through engine state. The reset
      // teardown respawns the enclave and fails calls queued inside that window with `locked`,
      // so the first post-reset import retries until the new port answers.
      await wallet.vault.reset();
      await until(() => engine.notifications.getState().status === "locked");
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- retrying the respawn window
          await wallet.wallets.importMnemonic({
            mnemonic: MNEMONIC_B,
            factor: { kind: "password", password: PASSWORD },
          });
          break;
        } catch (error) {
          if (!(error instanceof WalletError && error.code === "locked") || Date.now() > deadline) {
            throw error;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- retrying the respawn window
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await until(() => opens === 3);
      const walletB = wallet.getSnapshot().wallets[0]!.walletId;
      expect(walletB).not.toBe(walletA);
      // Notifications state surfaces only live walletIds — vault A's is gone even though its
      // store rows still sit in the host backing under their dead keys.
      const live = engine.notifications.getState().wallets;
      expect(Object.keys(live)).not.toContain(walletA);
      await expect(
        opened!.collection("notifications").get(`wallet:${walletB}`),
      ).resolves.toBeUndefined();
      await expect(
        opened!.collection("notifications").get(`sub:${walletB}:evm`),
      ).resolves.toBeUndefined();
      await expect(opened!.collection("approvals").get("eip155:1:0xbbbb")).resolves.toBeUndefined();
    } finally {
      engine.unsubscribe();
      await wallet.destroy();
    }
  }, 60_000);

  it("a reset cancels a running signer activity and the new vault's tree has no signers", async () => {
    const backing = new Map<string, Map<string, Uint8Array>>();
    let opens = 0;
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
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
      deviceIo: () => keystoneIo(async () => gate),
      openStore: async () => {
        opens += 1;
        return persistentStore(backing);
      },
      rpc: { [SOL_NET]: ["https://solana.invalid"] },
    });
    try {
      await wallet.wallets.importMnemonic({
        mnemonic: MNEMONIC_A,
        factor: { kind: "password", password: PASSWORD },
      });
      await until(() => opens === 1);
      const hwId = await pairKeystone(wallet);
      // Group 1 solana is unpinned — the accounts op parks on the device exchange.
      const fetch = engine.signers.fetchAccounts({ walletId: hwId, groupIndex: 1, family: "solana" });
      const settled = expect(fetch).rejects.toMatchObject({ code: "cancelled" });
      await until(() => engine.signers.getState().active?.step.kind === "device");
      await wallet.vault.reset();
      /* The lock hook cancels the task; the parked transport still has to return before the
         coroutine sees the flag and unwinds — a real device answers or errors here. */
      release();
      await until(() => engine.signers.getState().active === null);
      await settled;
      // Same respawn-window retry as the collection test above.
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- retrying the respawn window
          await wallet.wallets.importMnemonic({
            mnemonic: MNEMONIC_B,
            factor: { kind: "password", password: PASSWORD },
          });
          break;
        } catch (error) {
          if (!(error instanceof WalletError && error.code === "locked") || Date.now() > deadline) {
            throw error;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- retrying the respawn window
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await until(() => engine.accounts.getState().wallets.length === 1);
      const tree = engine.accounts.getState();
      expect(tree.wallets.map((w) => w.custody)).toStrictEqual(["vault"]);
      expect(
        Object.values(tree.groups)
          .flat()
          .every((g) => Object.keys(g.signer ?? {}).length === 0),
      ).toBe(true);
    } finally {
      release();
      engine.unsubscribe();
      await wallet.destroy();
    }
  }, 60_000);
});
