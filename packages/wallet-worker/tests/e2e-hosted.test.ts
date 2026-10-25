/**
 * Hosted regtest end to end — opt-in only (WALLET_E2E_HOSTED=1, seed from SPARK_HOSTED_SEED,
 * never printed). The funded funder is a LOCAL signer on account 0; wallet A is a fresh
 * enclave wallet (random mnemonic per run) whose SparkClient runs through the
 * @qntx/wallet/spark proxy signer — every signature below happens inside the enclave.
 *
 * Flow: funder → A 1,000 sats (A claims); A invoices 500 sats, funder pays (A claims); A sends
 * its whole balance back (funder claims). Mirrors the spark repo's hosted wiring
 * (packages/spark/tests/support/hosted.ts). Do not run 04:30–05:30 UTC — the nightly regtest
 * workflow spends from the same seed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { createMemorySparkStore, createSparkClient } from "@qntx/spark";
import type { SparkLeaf } from "@qntx/spark";
import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import { loadSparkWasm } from "@qntx/spark-wasm/browser";
import { spark } from "@qntx/wallet/spark";

import { createNodeWallet, createSoftwarePasskey } from "../src/node/index.ts";

const HOSTED = process.env["WALLET_E2E_HOSTED"] === "1";
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  vaultSalt: "qntx/vault",
};
const PASSWORD = "correct horse battery staple";
const DEADLINE_MS = 5 * 60_000;

function hostedSeed(): Uint8Array {
  const hex = process.env["SPARK_HOSTED_SEED"]?.trim();
  if (hex === undefined || !/^[0-9a-f]{128}$/i.test(hex)) {
    throw new Error("expected SPARK_HOSTED_SEED (64-byte hex) in the environment");
  }
  return hexToBytes(hex);
}

async function localCrypto() {
  const wasm = await readFile(
    join(import.meta.dirname, "..", "node_modules", "@qntx", "spark-wasm", "dist", "spark.wasm"),
  );
  return loadSparkWasm({ module: wasm });
}

type Client = ReturnType<typeof createSparkClient>;

function failureText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Claims what is claimable; a non-empty `failures` is a real error, not an empty round. */
async function claimPendingUntil(client: Client, deadline: number): Promise<readonly SparkLeaf[]> {
  const claimed = await client.transfers.claimPending();
  if (claimed.failures.length > 0) {
    const detail = claimed.failures
      .map((f) => `${f.transferId}: ${failureText(f.error)}`)
      .join("; ");
    throw new Error(`claim failed for ${claimed.failures.length} transfer(s): ${detail}`);
  }
  if (claimed.leaves.length > 0 || Date.now() > deadline) {
    return claimed.leaves;
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return claimPendingUntil(client, deadline);
}

describe.skipIf(!HOSTED)("hosted regtest e2e", () => {
  it("funds, receives over lightning and returns the balance through the enclave signer", async () => {
    const seed = hostedSeed();
    const crypto = await localCrypto();
    const random = (length: number): Uint8Array => randomBytes(length);

    // The funder: a real local signer on the shared seed's account 0.
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
    const funderBalance0 = await funder.balance();

    // Wallet A: a fresh enclave wallet with a random mnemonic; the proxy signer is its
    // SparkSigner.
    const wallet = await createNodeWallet({
      passkey: PASSKEY_CONFIG,
      autoLock: { platform: "web", idleMinutes: 15 },
      authenticator: createSoftwarePasskey(randomBytes(32)),
      kernelUrl: new URL("../dist/kernel.node.js", import.meta.url),
    });
    const draft = await wallet.wallets.createMnemonic({
      words: 12,
      factor: { kind: "password", password: PASSWORD },
    });
    const words = new TextDecoder().decode(draft.words.read()).split(" ");
    const created = await draft.confirm(draft.quiz.map((position) => words[position]!));
    const proxy = spark(wallet).signer({
      walletId: created.walletId,
      groupIndex: 0,
      network: "regtest",
    });
    const clientA = createSparkClient({
      network: "regtest",
      signer: proxy,
      fetch: globalThis.fetch,
      store: createMemorySparkStore(),
    });
    const identityA = await proxy.identityPublicKey();

    try {
      // Funder → A: 1,000 sats over spark transfer; A claims inside the enclave.
      const sent = await funder.transfers.send({ receiver: identityA, amountSats: 1_000 });
      console.log("funder sent:", sent.id, sent.status, "amount: 1000 sats");
      const claimed1 = await claimPendingUntil(clientA, Date.now() + DEADLINE_MS);
      expect(claimed1.length).toBeGreaterThan(0);
      await expect(clientA.balance()).resolves.toBeGreaterThanOrEqual(1_000);

      // A invoices 500 sats; the funder pays; A claims the lightning receive.
      const invoice = await clientA.lightning.createInvoice({ amountSats: 500, memo: "e2e" });
      const paid = await funder.lightning.pay({ invoice: invoice.invoice, maxFeeSats: 200 });
      console.log("funder paid:", paid.requestId, paid.transferId, "fee:", paid.feeSats);
      const claimed2 = await claimPendingUntil(clientA, Date.now() + DEADLINE_MS);
      expect(claimed2.length).toBeGreaterThan(0);
      const balanceA = await clientA.balance();
      console.log("A balance:", balanceA);

      // A returns its whole balance to the funder; the funder claims.
      const back = await clientA.transfers.send({
        receiver: funderIdentity,
        amountSats: balanceA,
      });
      console.log("A sent back:", back.id, back.status, "amount:", balanceA);
      const reclaimed = await claimPendingUntil(funder, Date.now() + DEADLINE_MS);
      expect(reclaimed.length).toBeGreaterThan(0);
      await expect(funder.balance()).resolves.toBeGreaterThanOrEqual(
        funderBalance0 - 1_000 - paid.feeSats,
      );
      await expect(clientA.balance()).resolves.toBe(0);
    } finally {
      // Best-effort sweep back to the funder so a failed run never strands sats.
      try {
        await claimPendingUntil(clientA, Date.now() + 120_000);
        const leftover = await clientA.balance();
        if (leftover > 0) {
          const swept = await clientA.transfers.send({
            receiver: funderIdentity,
            amountSats: leftover,
          });
          console.log("swept leftover:", swept.id, "amount:", leftover);
          await claimPendingUntil(funder, Date.now() + 120_000);
        }
      } catch (error) {
        console.log("leftover sweep failed:", failureText(error));
      }
      clientA.close();
      funder.close();
      await wallet.destroy();
    }
  }, 15 * 60_000);
});
