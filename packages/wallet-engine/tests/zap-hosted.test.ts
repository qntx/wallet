/**
 * Hosted regtest end to end for zaps — opt-in (WALLET_E2E_HOSTED=1, SPARK_HOSTED_SEED). Runs the
 *
 * @qntx/spark/server lightning-address service in-process behind an injected fetch (the https
 * requirement is satisfied by the URL shape; no real listener is needed). Account A registers a
 * lightning address, B zaps it through engine.zap with a real password verify — the approve
 * intent matches the invoice through the real kernel, which the unit tests cannot reach without
 * a valid BOLT11 for a dynamic description hash. The server does not publish a 9735 itself, so
 * the test builds one from the settled zapRequest and runs validateZapReceipt. Do not run
 * 04:30–05:30 UTC — the nightly regtest workflow spends from the same seed.
 */
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { Keys, finalizeEvent } from "@qntx/nostr";
import { validateZapReceipt } from "@qntx/nostr/nips/nip57";
import { createMemorySparkStore, createSparkClient, encodeSparkAddress } from "@qntx/spark";
import { loadSparkWasm } from "@qntx/spark-wasm/browser";
import {
  createLightningAddressServer,
  createMemoryLightningAddressStore,
} from "@qntx/spark/server";
import type { LightningAddressResult, LightningAddressServer } from "@qntx/spark/server";
import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import { createWalletEngine } from "../src/engine.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const HOSTED = process.env["WALLET_E2E_HOSTED"] === "1";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password", password: PASSWORD } as never;
const DEADLINE_MS = 5 * 60_000;
const DOMAIN = "example.com";

function warnText(_m: string, e: unknown): string {
  return e instanceof Error ? `${e.name}:${e.message}` : String(e ?? "");
}

function hostedSeed(): Uint8Array {
  const hex = process.env["SPARK_HOSTED_SEED"]?.trim();
  if (hex === undefined || !/^[0-9a-f]{128}$/i.test(hex)) {
    throw new Error("expected SPARK_HOSTED_SEED (64-byte hex) in the environment");
  }
  return hexToBytes(hex);
}

type Engine = ReturnType<typeof createWalletEngine>;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `done` until truthy or the deadline passes; returns whether it fired. */
async function poll(done: () => boolean, deadline: number, intervalMs = 3000): Promise<boolean> {
  if (done() || Date.now() > deadline) {
    return done();
  }
  await sleep(intervalMs);
  return poll(done, deadline, intervalMs);
}

/** Polls `server.settlePending` until an invoice settles or the deadline passes. */
async function pollSettled(
  server: LightningAddressServer,
  deadline: number,
): Promise<ReadonlyArray<{ zapRequest?: string | undefined; preimageHex?: string }>> {
  const settled = await server.settlePending();
  if (settled.length > 0 || Date.now() > deadline) {
    return settled;
  }
  await sleep(5000);
  return pollSettled(server, deadline);
}

/** Server-side zap-request check: kind 9734 with an amount tag covering the invoice. */
function validateZapRequest(json: string, amountMsat: number): void {
  const ev = JSON.parse(json) as { kind: number; tags: string[][] };
  if (ev.kind !== 9734) {
    throw new Error("not a zap request");
  }
  const amount = ev.tags.find((x) => x[0] === "amount");
  if (amount === undefined || Number(amount[1]) < amountMsat) {
    throw new Error("amount mismatch");
  }
}

/** Reads the controller's balance for an engine account key, or 0 while it is not visible. */
function balanceOf(engine: Engine, key: string): number {
  return engine.spark.getState().accounts[key]?.balanceSats ?? 0;
}

/** The controller's account key for a wallet group. */
function accountKey(walletId: string, gi: number): string {
  return `${walletId}:${gi}:regtest`;
}

/** Dispatches {DOMAIN} URLs at the in-process server; everything else goes to real fetch. */
function serverFetch(server: LightningAddressServer): typeof globalThis.fetch {
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
    } else {
      out = { status: 404, body: { status: "ERROR", reason: "unknown path" } };
    }
    return Response.json(out.body, { status: out.status });
  };
}

/** Sweeps leftovers back to the funder through the approval path; best-effort. */
async function sweep(
  engine: Engine,
  ref: never,
  funderIdentity: Uint8Array,
  key: string,
): Promise<void> {
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

/** Returns the server wallet's leftovers to the funder; best-effort. */
async function sweepServer(
  client: ReturnType<typeof createSparkClient>,
  funderIdentity: Uint8Array,
): Promise<void> {
  const balance = await client.balance();
  if (balance === 0) {
    return;
  }
  await client.transfers.send({
    receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: funderIdentity }),
    amountSats: balance,
  });
}

describe.skipIf(!HOSTED)("hosted zap e2e", () => {
  it(
    "A registers a lightning address and B zaps it through the engine",
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
      const funderSigner = signerFor(0);
      const funder = createSparkClient({
        network: "regtest",
        signer: funderSigner,
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const serverClient = createSparkClient({
        network: "regtest",
        signer: signerFor(3),
        fetch: globalThis.fetch,
        store: createMemorySparkStore(),
      });
      const funderIdentity = await funderSigner.identityPublicKey();

      const receiptKeys = Keys.generate();
      const receiptPubkey = receiptKeys.publicKey;
      const server = createLightningAddressServer({
        client: serverClient,
        domain: DOMAIN,
        store: createMemoryLightningAddressStore(),
        minSendableMsat: 1000,
        maxSendableMsat: 100_000_000,
        commentAllowed: 255,
        zap: {
          receiptPublicKey: receiptPubkey,
          validateRequest: validateZapRequest,
        },
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

      const engine = createWalletEngine({
        wallet,
        fetch: serverFetch(server),
        random,
        now: () => Date.now(),
        logger: {
          warn: (m, e) => {
            appendFileSync(
              "/tmp/zap-engine-warns.log",
              `${Date.now()} WARN ${m} ${warnText(m, e)}\n`,
            );
          },
        },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
      });
      const refA = { walletId: created.walletId, groupIndex: 0, network: "regtest" } as never;
      const refB = { walletId: created.walletId, groupIndex: 1, network: "regtest" } as never;
      engine.spark.addAccount(refA);
      engine.spark.addAccount(refB);
      await wallet.vault.unlock(VERIFY);

      const deadline = Date.now() + DEADLINE_MS;
      const username = `zap${Date.now().toString(36)}`;
      try {
        // Fund B from the hosted funder so the zap has a real budget.
        const funded = 5000;
        const idB = await spark(wallet).signer(refB).identityPublicKey();
        await funder.transfers.send({
          receiver: encodeSparkAddress({ network: "regtest", identityPublicKey: idB }),
          amountSats: funded,
        });

        // A registers the address through the engine — no approval needed.
        const registration = await engine.spark.registerLightningAddress(refA, {
          serverUrl: `https://${DOMAIN}`,
          domain: DOMAIN,
          username,
          description: "hosted zap e2e",
        });
        expect(registration.lightningAddress).toBe(`${username}@${DOMAIN}`);

        // B waits for the funding claim, then zaps through the real approval path.
        await expect(
          poll(() => balanceOf(engine, accountKey(created.walletId, 1)) >= funded, deadline),
        ).resolves.toBe(true);

        const aKey = await nostr(wallet).deriveKey(created.walletId, 0);
        const bKey = await nostr(wallet).deriveKey(created.walletId, 1);
        const aNostrPub = await nostr(wallet).signer(aKey.ref).getPublicKey();
        const zap = await engine.zap({
          account: refB,
          nostrKey: bKey.ref,
          recipient: { pubkey: aNostrPub, lightning: `${username}@${DOMAIN}` },
          amountSats: 700,
          relays: ["wss://nostr.example.com"],
          maxFeeSats: 50,
          verify: VERIFY,
        });
        expect(zap.payment.amountSats).toBe(700);

        // The server settles once the SSP verifies the preimage; A sees the credit.
        const settled = await pollSettled(server, deadline);
        expect(settled).toHaveLength(1);
        // A receives: the engine's event loop claims the lightning-settled transfer by id
        // and refreshes account state — no side client, no manual claim.
        await expect(
          poll(() => balanceOf(engine, accountKey(created.walletId, 0)) >= 700, deadline),
        ).resolves.toBe(true);

        // The server does not publish a 9735 itself — build one from the settled zapRequest and
        // run it through validateZapReceipt.
        const zapRequestJson = String(settled[0]!.zapRequest);
        const requestEvent = JSON.parse(zapRequestJson) as { pubkey: string; tags: string[][] };
        const receipt = finalizeEvent(
          {
            kind: 9735,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", requestEvent.tags.find((x) => x[0] === "p")![1]!],
              ["P", requestEvent.pubkey],
              ["bolt11", zap.invoice],
              ["description", zapRequestJson],
              ["amount", "700000"],
              ["preimage", String(settled[0]!.preimageHex)],
            ],
            content: "",
          },
          receiptKeys,
        );
        expect(validateZapReceipt(receipt, { nostrPubkey: zap.receiptPubkey }).valid).toBe(true);
      } finally {
        await sweep(engine, refA, funderIdentity, accountKey(created.walletId, 0));
        await sweep(engine, refB, funderIdentity, accountKey(created.walletId, 1));
        await sweepServer(serverClient, funderIdentity);
      }
    },
    10 * 60_000,
  );
});
