/**
 * Hosted regtest end to end for engine.payments — opt-in (WALLET_E2E_HOSTED=1, SPARK_HOSTED_SEED).
 * Runs the @qntx/spark/server lightning-address service in-process behind an injected fetch plus a
 * minimal LNURL-withdraw endpoint whose callback pays the submitted `pr` with a real client.
 * Covers: spark-address pay, BIP-21 lightning= pay, lightning-address resolve+pay, and
 * lnurl-withdraw which must not consume an approval. Do not run 04:30–05:30 UTC — the nightly
 * regtest workflow spends from the same seed.
 */
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { createMemorySparkStore, createSparkClient, encodeSparkAddress, uuidv7 } from "@qntx/spark";
import type { SparkClient } from "@qntx/spark";
import { loadSparkWasm } from "@qntx/spark-wasm/browser";
import {
  createLightningAddressServer,
  createMemoryLightningAddressStore,
} from "@qntx/spark/server";
import type { LightningAddressResult, LightningAddressServer } from "@qntx/spark/server";
import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { spark } from "@qntx/wallet/spark";

import { createWalletEngine } from "../src/engine.ts";
import type { PaymentParse } from "../src/payments/parse.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const HOSTED = process.env["WALLET_E2E_HOSTED"] === "1";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password", password: PASSWORD } as never;
const DEADLINE_MS = 5 * 60_000;
const DOMAIN = "example.com";

function hostedSeed(): Uint8Array {
  const hex = process.env["SPARK_HOSTED_SEED"]?.trim();
  if (hex === undefined || !/^[0-9a-f]{128}$/i.test(hex)) {
    throw new Error("expected SPARK_HOSTED_SEED (64-byte hex) in the environment");
  }
  return hexToBytes(hex);
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function poll(done: () => boolean, deadline: number): Promise<boolean> {
  if (done() || Date.now() > deadline) {
    return done();
  }
  await sleep(3000);
  return poll(done, deadline);
}

function balanceOf(engine: ReturnType<typeof createWalletEngine>, key: string): number {
  return engine.spark.getState().accounts[key]?.balanceSats ?? 0;
}

const keyFor = (walletId: string, gi: number): string => `${walletId}:${gi}:regtest`;

/** Narrows a parse to `request` — throws (fails the test) otherwise. */
function requestOf(parse: PaymentParse) {
  if (parse.kind !== "request") {
    throw new Error(`expected a payment request, got ${parse.kind}`);
  }
  return parse.request;
}

/** First option of `kind`, throwing when absent. */
function optionOf(
  request: ReturnType<typeof requestOf>,
  kind: string,
): (typeof request.options)[number] {
  const option = request.options.find((o) => o.kind === kind);
  if (option === undefined) {
    throw new Error(`no ${kind} option`);
  }
  return option;
}

/** Dispatches {DOMAIN}: LNURL-pay server paths + the test withdraw endpoint; real fetch else. */
function testFetch(
  server: LightningAddressServer,
  withdrawPayer: () => SparkClient,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== DOMAIN) {
      return globalThis.fetch(String(input), init);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    let out: LightningAddressResult;
    if (parts[0] === ".well-known" && parts[1] === "lnurlp") {
      out = await server.payRequest(parts[2]!);
    } else if (parts[0] === "lnurlpay") {
      out =
        init?.method === "DELETE"
          ? await server.unregister(parts[1]!, body)
          : await server.register(parts[1]!, body);
    } else if (parts[0] === "lnurlp" && parts[2] === "invoice") {
      const comment = url.searchParams.get("comment");
      const nostrParam = url.searchParams.get("nostr");
      out = await server.invoice(parts[1]!, {
        amount: Number(url.searchParams.get("amount")),
        ...(comment === null ? {} : { comment }),
        ...(nostrParam === null ? {} : { nostr: nostrParam }),
      });
    } else if (parts[0] === ".well-known" && parts[1] === "lnurlw") {
      out = {
        status: 200,
        body: {
          tag: "withdrawRequest",
          callback: `https://${DOMAIN}/lnurlw/callback`,
          k1: "k1test",
          defaultDescription: "hosted withdraw",
          minWithdrawable: 1000,
          maxWithdrawable: 100_000_000,
        },
      };
    } else if (parts[0] === "lnurlw" && parts[1] === "callback") {
      const pr = url.searchParams.get("pr");
      if (pr === null) {
        out = { status: 400, body: { status: "ERROR", reason: "missing pr" } };
      } else {
        try {
          // A raw client claims incoming transfers explicitly — the engine does it via events.
          await withdrawPayer().transfers.claimPending();
          await withdrawPayer().lightning.pay({
            invoice: pr,
            maxFeeSats: 1000,
            transferId: uuidv7(randomBytes, () => Date.now()),
          });
          out = { status: 200, body: { status: "OK" } };
        } catch (error) {
          appendFileSync(
            "/tmp/payments-withdraw.log",
            `${Date.now()} PAY-FAIL ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
          );
          out = {
            status: 500,
            body: { status: "ERROR", reason: error instanceof Error ? error.name : "pay" },
          };
        }
      }
    } else {
      out = { status: 404, body: { status: "ERROR", reason: "unknown path" } };
    }
    return Response.json(out.body, { status: out.status });
  };
}

async function sweep(
  engine: ReturnType<typeof createWalletEngine>,
  ref: never,
  funderIdentity: Uint8Array,
  key: string,
): Promise<void> {
  const balance = balanceOf(engine, key);
  if (balance === 0) {
    return;
  }
  await engine.spark.send(ref, {
    receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: funderIdentity }),
    amountSats: balance,
    verify: VERIFY,
  });
}

async function sweepClient(client: SparkClient, funderIdentity: Uint8Array): Promise<void> {
  const balance = await client.balance();
  if (balance === 0) {
    return;
  }
  await client.transfers.send({
    receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: funderIdentity }),
    amountSats: balance,
  });
}

describe.skipIf(!HOSTED)("hosted payments e2e", () => {
  it(
    "parses and pays every supported input kind through engine.payments",
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
      const signerFor = (group: number) =>
        createSparkSigner({
          crypto,
          accountKey: sparkAccountKey(seed, "regtest", group),
          network: "regtest",
          random,
        });
      const funder = createSparkClient({
        network: "regtest",
        signer: signerFor(0),
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const serverClient = createSparkClient({
        network: "regtest",
        signer: signerFor(3),
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const withdrawPayerClient = createSparkClient({
        network: "regtest",
        signer: signerFor(4),
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const funderIdentity = await signerFor(0).identityPublicKey();
      const server = createLightningAddressServer({
        client: serverClient,
        domain: DOMAIN,
        store: createMemoryLightningAddressStore(),
        minSendableMsat: 1000,
        maxSendableMsat: 100_000_000,
        commentAllowed: 255,
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

      const approvals: unknown[] = [];
      const realSparkApis = spark(wallet);
      const engine = createWalletEngine({
        wallet,
        fetch: testFetch(server, () => withdrawPayerClient),
        random,
        now: () => Date.now(),
        logger: { warn: () => {} },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        sparkApis: {
          ...realSparkApis,
          approve: async (params) => {
            approvals.push(params);
            return realSparkApis.approve(params);
          },
        },
      });
      const refA = { walletId: created.walletId, groupIndex: 0, network: "regtest" } as never;
      const refB = { walletId: created.walletId, groupIndex: 1, network: "regtest" } as never;
      engine.spark.addAccount(refA);
      engine.spark.addAccount(refB);
      await wallet.vault.unlock(VERIFY);

      const deadline = Date.now() + DEADLINE_MS;
      try {
        // Fund A, B, and the withdraw payer.
        for (const group of [0, 1]) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sends by design
          const id = await spark(wallet)
            .signer({ walletId: created.walletId, groupIndex: group, network: "regtest" } as never)
            .identityPublicKey();
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sends by design
          await funder.transfers.send({
            receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: id }),
            amountSats: 5000,
          });
        }
        const wpIdentity = await signerFor(4).identityPublicKey();
        await funder.transfers.send({
          receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: wpIdentity }),
          amountSats: 5000,
        });
        await expect(
          poll(
            () =>
              Math.min(
                balanceOf(engine, keyFor(created.walletId, 0)),
                balanceOf(engine, keyFor(created.walletId, 1)),
              ) >= 5000,
            deadline,
          ),
        ).resolves.toBe(true);

        // 1) spark address → spark option → B pays A 500 sats.
        const aAddress = encodeSparkAddress({
          network: "regtest",
          identityPublicKey: await spark(wallet).signer(refA).identityPublicKey(),
        });
        const sparkOption = requestOf(engine.payments.parse(aAddress, "regtest")).options[0]!;
        expect(sparkOption.kind).toBe("spark");
        await engine.payments.pay({
          account: refB,
          option: sparkOption,
          amountSats: 500,
          verify: VERIFY,
        });
        await expect(
          poll(() => balanceOf(engine, keyFor(created.walletId, 0)) >= 5500, deadline),
        ).resolves.toBe(true);
        const sparkApprovals = approvals.length;
        expect(sparkApprovals).toBe(1);

        // 2) BIP-21 bitcoin:?lightning=<bolt11> → lightning option pays A's invoice.
        const invoice = await engine.spark.createInvoice(refA, {
          amountSats: 300,
          memo: "bip21 pay",
        });
        const uri = `bitcoin:?lightning=${invoice.invoice}`;
        const lightningOption = optionOf(
          requestOf(engine.payments.parse(uri, "regtest")),
          "lightning",
        );
        await engine.payments.pay({
          account: refB,
          option: lightningOption,
          maxFeeSats: 100,
          verify: VERIFY,
        });
        await expect(
          poll(() => balanceOf(engine, keyFor(created.walletId, 0)) >= 5800, deadline),
        ).resolves.toBe(true);
        expect(approvals).toHaveLength(2);

        // 3) lightning address → resolve → lnurl-pay → pay.
        const username = `pay${Date.now().toString(36)}`;
        await engine.spark.registerLightningAddress(refA, {
          serverUrl: `https://${DOMAIN}`,
          domain: DOMAIN,
          username,
          description: "hosted payments e2e",
        });
        const resolved = await engine.payments.resolve(`${username}@${DOMAIN}`, "regtest");
        const lnurlPay = optionOf(requestOf(resolved), "lnurl-pay");
        await engine.payments.pay({
          account: refB,
          option: lnurlPay,
          amountSats: 200,
          maxFeeSats: 100,
          verify: VERIFY,
        });
        await expect(
          poll(() => balanceOf(engine, keyFor(created.walletId, 0)) >= 6000, deadline),
        ).resolves.toBe(true);
        expect(approvals).toHaveLength(3);

        // 4) lnurl-withdraw → A creates the invoice, the in-process service pays it — no approval.
        const resolvedW = await engine.payments.resolve(
          `lnurlw://example.com/.well-known/lnurlw`,
          "regtest",
        );
        const withdrawOption = optionOf(requestOf(resolvedW), "lnurl-withdraw");
        const beforeA = balanceOf(engine, keyFor(created.walletId, 0));
        const approvalsBefore = approvals.length;
        await engine.payments.pay({
          account: refA,
          option: withdrawOption,
          amountSats: 400,
          verify: VERIFY,
        });
        await expect(
          poll(() => balanceOf(engine, keyFor(created.walletId, 0)) >= beforeA + 400, deadline),
        ).resolves.toBe(true);
        expect(approvals).toHaveLength(approvalsBefore);
      } finally {
        await sweep(engine, refA, funderIdentity, keyFor(created.walletId, 0));
        await sweep(engine, refB, funderIdentity, keyFor(created.walletId, 1));
        await sweepClient(serverClient, funderIdentity);
        await sweepClient(withdrawPayerClient, funderIdentity);
      }
    },
    8 * 60_000,
  );
});
