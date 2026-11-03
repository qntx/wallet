/**
 * Hosted regtest end to end for Spark → L1 — opt-in (WALLET_E2E_HOSTED=1, SPARK_HOSTED_SEED, and
 * WALLET_E2E_ESPLORA for a regtest Esplora whose chain the hosted SO watches). A funded Spark
 * account exits to the group's own bitcoin receive address through `spark-exit`. The deposit
 * direction needs regtest L1 funds and is covered by the fake-client tests. Do not run 04:30–05:30
 * UTC — the nightly regtest workflow spends from the same seed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { createMemorySparkStore, createSparkClient } from "@qntx/spark";
import { loadSparkWasm } from "@qntx/spark-wasm/browser";
import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { spark } from "@qntx/wallet/spark";

import { createWalletEngine } from "../src/engine.ts";
import { SPARK_L1_NETWORK } from "../src/spark/l1.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const HOSTED = process.env["WALLET_E2E_HOSTED"] === "1";
const ESPLORA = process.env["WALLET_E2E_ESPLORA"];
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password", password: PASSWORD } as never;
const DEADLINE_MS = 10 * 60_000;

const balanceOf = (engine: ReturnType<typeof createWalletEngine>, key: string): number =>
  engine.spark.getState().accounts[key]?.balanceSats ?? 0;

const hostedSeed = (): Uint8Array => {
  const hex = process.env["SPARK_HOSTED_SEED"]?.trim();
  if (hex === undefined || !/^[0-9a-f]{128}$/i.test(hex)) {
    throw new Error("expected SPARK_HOSTED_SEED (64-byte hex) in the environment");
  }
  return hexToBytes(hex);
};

const until = async (done: () => boolean, deadline: number): Promise<boolean> => {
  if (done() || Date.now() > deadline) {
    return done();
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 3000);
  });
  return until(done, deadline);
};

const esplora = ESPLORA ?? "";

describe.skipIf(!HOSTED || esplora === "")("hosted spark exit", () => {
  it(
    "exits to the group's own bitcoin receive address",
    async () => {
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
        accountKey: sparkAccountKey(hostedSeed(), "regtest", 0),
        network: "regtest",
        random,
      });
      const funder = createSparkClient({
        network: "regtest",
        signer: funderSigner,
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const wallet = await createNodeWallet({
        passkey: {
          rpId: "qntx.test",
          rpName: "qntx",
          walletSalt: "qntx/wallet",
          backupSalt: "qntx/backup",
          vaultSalt: "qntx/vault",
        },
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
      const l1 = SPARK_L1_NETWORK.regtest;
      const engine = createWalletEngine({
        weblnAlias: "test",
        lightningMaxFee: () => 0,
        wallet,
        sparkNetwork: "regtest",
        fetch: globalThis.fetch,
        random,
        now: () => Date.now(),
        logger: { warn: () => {} },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        rpc: { [l1]: [esplora] },
      });
      const ref = { walletId: created.walletId, groupIndex: 0, network: "regtest" } as const;
      await until(() => engine.accounts.getState().status === "ready", Date.now() + 30_000);
      const key = `${created.walletId}:0:regtest`;

      const identity = await spark(wallet).signer(ref).identityPublicKey();
      await funder.transfers.send({ receiver: identity, amountSats: 5000 });
      await until(() => balanceOf(engine, key) >= 5000, Date.now() + DEADLINE_MS);

      const exit = await engine.requests.prepare({
        method: "spark-exit",
        account: ref,
        amountSats: 4000,
        maxFeeSats: 2000,
      });
      expect(exit.display).toMatchObject({ family: "spark", kind: "exit" });
      const result = await engine.requests.approve(exit.id, "spark-exit", VERIFY);
      expect(result.kind).toBe("withdraw");
      await wallet.destroy();
    },
    DEADLINE_MS + 60_000,
  );
});
