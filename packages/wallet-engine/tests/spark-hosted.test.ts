/**
 * Hosted regtest end to end for the engine — opt-in (WALLET_E2E_HOSTED=1, SPARK_HOSTED_SEED). Two
 * engine-managed accounts (fresh mnemonic, enclave-backed signers) funded by the hosted funder. Do
 * not run 04:30–05:30 UTC — the nightly regtest workflow spends from the same seed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { createMemorySparkStore, createSparkClient, encodeSparkAddress } from "@qntx/spark";
import { loadSparkWasm } from "@qntx/spark-wasm/browser";
import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { spark } from "@qntx/wallet/spark";

import { createWalletEngine } from "../src/engine.ts";
import { sparkStore } from "../src/spark/store.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const HOSTED = process.env["WALLET_E2E_HOSTED"] === "1";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password", password: PASSWORD } as never;
const DEADLINE_MS = 5 * 60_000;
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};

function hostedSeed(): Uint8Array {
  const hex = process.env["SPARK_HOSTED_SEED"]?.trim();
  if (hex === undefined || !/^[0-9a-f]{128}$/i.test(hex)) {
    throw new Error("expected SPARK_HOSTED_SEED (64-byte hex) in the environment");
  }
  return hexToBytes(hex);
}

type Engine = ReturnType<typeof createWalletEngine>;

/** Polls the controller state until the account's balance reaches `min` or the deadline. */
async function waitForBalance(engine: Engine, key: string, min: number, deadline: number) {
  const balance = engine.spark.getState().accounts[key]?.balanceSats ?? 0;
  if (balance >= min || Date.now() > deadline) {
    return balance;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return waitForBalance(engine, key, min, deadline);
}

/** Waits until the account tree reconciled and drove its first setAccounts. */
async function waitForTreeReady(engine: Engine, deadline: number): Promise<void> {
  if (engine.accounts.getState().status === "ready" || Date.now() > deadline) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return waitForTreeReady(engine, deadline);
}

/** Waits until the account entry is dropped (declarative setAccounts([]) on lock). */
async function waitForAbsent(engine: Engine, key: string, deadline: number): Promise<void> {
  if (engine.spark.getState().accounts[key] === undefined || Date.now() > deadline) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return waitForAbsent(engine, key, deadline);
}

/** Sweeps leftovers back to the funder through the approval path; best-effort. */
async function sweepEngine(engine: Engine, ref: never, funderIdentity: Uint8Array, key: string) {
  const balance = engine.spark.getState().accounts[key]?.balanceSats ?? 0;
  if (balance === 0) {
    return;
  }
  await engine.spark.send(ref, {
    receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: funderIdentity }),
    amountSats: balance,
    verify: VERIFY,
  });
}

describe.skipIf(!HOSTED)("hosted engine e2e", () => {
  it(
    "transfers, invoices and lifecycle through the engine",
    async () => {
      const seed = hostedSeed();
      const random = (length: number): Uint8Array => randomBytes(length);
      const crypto = await loadSparkWasm({
        module: await readFile(
          join(
            import.meta.dirname,
            "..",
            "node_modules",
            "@qntx",
            "spark-wasm",
            "dist",
            "spark.wasm",
          ),
        ),
      });
      const funderSigner = createSparkSigner({
        crypto,
        accountKey: sparkAccountKey(seed, "regtest", 0),
        network: "regtest",
        random,
      });
      const funder = createSparkClient({
        network: "regtest",
        signer: funderSigner,
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const funderIdentity = await funderSigner.identityPublicKey();

      const wallet = await createNodeWallet({
        passkey: PASSKEY_CONFIG,
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url),
      });
      const draft = await wallet.wallets.createMnemonic({
        words: 12,
        factor: { kind: "password", password: PASSWORD },
      });
      const words = new TextDecoder().decode(draft.words.read()).split(" ");
      const created = await draft.confirm(draft.quiz.map((p) => words[p]!));

      const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
      const engine = createWalletEngine({
        wallet,
        sparkNetwork: "regtest",
        fetch: globalThis.fetch,
        random,
        now: () => Date.now(),
        logger: { warn: () => {} },
        openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      });
      const refA = { walletId: created.walletId, groupIndex: 0, network: "regtest" } as never;
      const refB = { walletId: created.walletId, groupIndex: 1, network: "regtest" } as never;
      const keyB = `${created.walletId}:1:regtest`;
      // The account tree drives setAccounts([selected]) on unlock reconcile — wait for that
      // drive to land before declaring both accounts, or the reconcile would drop refB.
      await waitForTreeReady(engine, Date.now() + 30_000);
      engine.spark.setAccounts([refA, refB]);

      const clientA = createSparkClient({
        network: "regtest",
        signer: spark(wallet).signer(refA),
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const clientB = createSparkClient({
        network: "regtest",
        signer: spark(wallet).signer(refB),
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });

      try {
        // Funder → B: the engine's events() loop claims and updates the balance.
        const identityB = await spark(wallet).signer(refB).identityPublicKey();
        await funder.transfers.send({ receiver: identityB, amountSats: 1000 });
        const balanceB = await waitForBalance(engine, keyB, 1000, Date.now() + DEADLINE_MS);
        expect(balanceB).toBeGreaterThanOrEqual(1000);

        // A direct client call without approval fails inside the enclave.
        await expect(
          clientB.transfers.send({ receiver: funderIdentity, amountSats: 100 }),
        ).rejects.toThrow(/approval/);

        // E1-e-2: the funding receive populated the first history page.
        expect(engine.spark.getState().accounts[keyB]?.recent?.length).toBeGreaterThan(0);

        // B pays a Lightning invoice created by A — the engine approves before the client.
        const createdInvoice = await clientA.lightning.createInvoice({ amountSats: 300 });
        await engine.spark.payInvoice(refB, {
          invoice: createdInvoice.invoice,
          maxFeeSats: 100,
          verify: VERIFY,
        });

        // Exit chains survive a store reopen (the same backing collections).
        const colName = `spark-exit-chains:${keyB}`;
        const reopened = sparkStore(createMemoryEngineStore(backing).collection(colName));
        await expect(reopened.exitChains()).resolves.toStrictEqual(
          await sparkStore(createMemoryEngineStore(backing).collection(colName)).exitChains(),
        );

        // Lock clears state; unlock restores B's real balance (funded minus the paid
        // invoice and its fee — the controller state can lag events, so compare with the
        // client-reported truth, not the cached state).
        await wallet.vault.lock();
        // Declarative lock: setAccounts([]) drops every account entry — keyB disappears.
        await waitForAbsent(engine, keyB, Date.now() + 30_000);
        expect(engine.spark.getState().accounts[keyB]).toBeUndefined();
        await wallet.vault.unlock({ kind: "password", password: PASSWORD });
        // The tree drives only the selected group on unlock; group 1 must be adopted into the
        // tree (it was declared manually, never via addGroups) before it can be selected.
        await waitForTreeReady(engine, Date.now() + 30_000);
        engine.accounts.addGroups(created.walletId, [1]);
        engine.accounts.select(created.walletId, 1);
        const restored = await waitForBalance(engine, keyB, 1, Date.now() + DEADLINE_MS);
        const realBalance = await clientB.balance();
        expect(restored).toBeGreaterThan(0);
        expect(restored).toBeLessThan(balanceB);
        expect(restored).toBe(realBalance);

        // E1-g: discovery walks indices from 0 — 0 (A's invoice) and 1 (B's activity) are used,
        // so the stop rule yields [0, 1]. refreshTotals fills the other visible groups — group 0
        // is not selected so it counts as "other".
        const discovered = await engine.accounts.discoverSpark(created.walletId);
        expect(discovered).toStrictEqual([0, 1]);
        await engine.accounts.refreshTotals();
        expect(engine.accounts.getState().totals[`${created.walletId}:1`]).toBe(realBalance);

        // Group 1 is selected (drove setAccounts above) — group 0's client stays closed.
        expect(engine.accounts.getState().selected?.groupIndex).toBe(1);
        expect(engine.spark.getState().accounts[`${created.walletId}:0:regtest`]).toBeUndefined();
        expect(engine.spark.getState().accounts[keyB]?.balanceSats).toBe(realBalance);
        expect(engine.spark.getState().accounts[keyB]?.recent?.length).toBeGreaterThan(0);
      } finally {
        try {
          await sweepEngine(engine, refB, funderIdentity, keyB);
        } catch {
          // leftover sweep is best-effort
        }
        engine.unsubscribe();
        await wallet.destroy();
        funder.close();
      }
    },
    DEADLINE_MS * 2,
  );
});
