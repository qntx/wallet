// oxlint-disable vitest/no-conditional-in-test -- narrowing captured payloads is inherent to
// asserting on them.
/**
 * The whole push path in one process: the real `createGateway` routes (subscription + Alchemy
 * webhook) backed by a real `PushCore` on `node:sqlite`, the real `evmVerifier` through a real
 * forwarder over a scripted upstream, and the real `apnsSender`/`fcmSender` over a capturing fake
 * fetch. The wallet side uses only `subscriptionIdOf` and `openPush`. Ends with the privacy sweep:
 * no provider request or log line may carry an address, hash, network id, amount, symbol, token,
 * key or subscription id.
 */
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { PUSH_TTL_MS } from "@qntx/wallet-engine/gateway/contract";
import { openPush } from "@qntx/wallet-engine/push";

import { GatewayHttpError } from "../src/middleware/errors.ts";
import { indexNetworks } from "../src/middleware/network.ts";
import { createForwarder } from "../src/providers/forward.ts";
import type { PushResult } from "../src/push/backend.ts";
import { PushCore } from "../src/push/core.ts";
import { base64urlOf, utf8 } from "../src/push/encoding.ts";
import { subscriptionIdOf, importSealKey } from "../src/push/seal.ts";
import { apnsSender, fcmSender } from "../src/push/senders.ts";
import { pushStore } from "../src/push/store.ts";
import { evmVerifier } from "../src/push/verify-evm.ts";
import { alchemyConfig, alchemySync } from "../src/push/watch-alchemy.ts";
import { CLIENT_ID, TEST_ACCOUNTS, allowAll, fakeFetch, gateway, openBudget } from "./helpers.ts";
import { SEAL_KEY_B64, p8Pem } from "./push/helpers.ts";
import { nodeSql } from "./push/sql.ts";

const EVM = "eip155:1";
const SIGNING_KEY = "e2e-signing-key";
const WEBHOOK_ID = "wh_e2e";
const ADDRESS = `0x${"1".repeat(40)}`;
const FOREIGN = `0x${"9".repeat(40)}`;
const HASH_IN = `0x${"a".repeat(64)}`;
const HASH_OUT = `0x${"b".repeat(64)}`;
const HASH_FOREIGN = `0x${"c".repeat(64)}`;
const DEVICE_TOKEN = "ab".repeat(32);
const UPSTREAM_URL = "https://evm.upstream.test/rpc";

const hmac = async (body: string, key: string): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", imported, utf8(body));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const pem = (der: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(der)) {
    binary += String.fromCodePoint(byte);
  }
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
};

const pkcs8 = async (key: CryptoKey): Promise<ArrayBuffer> => {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  if (!(der instanceof ArrayBuffer)) {
    throw new TypeError("expected DER bytes");
  }
  return der;
};

const rsaPem = async (): Promise<string> => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign"],
  );
  if (!("privateKey" in pair)) {
    throw new TypeError("expected a key pair");
  }
  return pem(await pkcs8(pair.privateKey));
};

const webhook = (activity: ReadonlyArray<Record<string, unknown>>, id = "evt-1"): string =>
  JSON.stringify({
    webhookId: WEBHOOK_ID,
    id,
    createdAt: "2025-01-01T00:00:00.000Z",
    type: "ADDRESS_ACTIVITY",
    event: { network: "ETH_MAINNET", activity },
  });

const externalIn = (hash: string, to = ADDRESS): Record<string, unknown> => ({
  blockNum: "0x64",
  hash,
  fromAddress: FOREIGN,
  toAddress: to,
  value: 1.5,
  asset: "ETH",
  category: "external",
  rawContract: { rawValue: "0x14d1120d7b160000" },
});

describe("push end to end", () => {
  it("runs subscribe → webhook → receipt → APNs → reverted → failed → replay, staying opaque", async () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const logs: string[] = [];

    // Scripted upstream: answers the finalized head plus a receipt per requested hash.
    const receipts = new Map<string, unknown>();
    const receipt = (hash: string, status: string, from: string, block = "0x64") => ({
      transactionHash: hash,
      status,
      blockNumber: block,
      from,
      to: ADDRESS,
    });

    const { fetch, calls } = fakeFetch({
      [`${UPSTREAM_URL.slice(0, "https://".length)}evm.upstream.test/`]: (call) => {
        const batch = JSON.parse(call.body) as Array<{
          id: number;
          method: string;
          params: unknown[];
        }>;
        return Response.json(
          batch.map((entry) => ({
            jsonrpc: "2.0",
            id: entry.id,
            result:
              entry.method === "eth_getBlockByNumber"
                ? { number: "0x63", hash: `0x${"f".repeat(64)}` }
                : (receipts.get(entry.params[0] as string) ?? null),
          })),
        );
      },
      "https://apns.test/": () => new Response("{}"),
      "https://fcm.googleapis.com/": () => new Response("{}"),
      "https://oauth2.googleapis.com/": () =>
        Response.json({ access_token: "e2e-token", expires_in: 3600 }),
      "https://dashboard.alchemy.com/": () => new Response("{}"),
    });

    const served = indexNetworks(
      [{ id: EVM, providers: [{ id: "alchemy", url: UPSTREAM_URL }] }],
      {},
      TEST_ACCOUNTS,
    );
    const forwarder = createForwarder(fetch, () => undefined, { budget: openBudget });
    const alchemy = alchemyConfig(
      {
        ALCHEMY_NOTIFY_TOKEN: "e2e-notify-token",
        ALCHEMY_WEBHOOKS: `{"${EVM}": {"id":"${WEBHOOK_ID}","signingKey":"${SIGNING_KEY}"}}`,
      },
      new Set([EVM]),
    );
    if (alchemy === undefined) {
      throw new TypeError("alchemy config");
    }
    const sql = nodeSql(new DatabaseSync(":memory:"));
    pushStore(sql); // create the schema before the first RPC
    const core = new PushCore({
      sql,
      family: "evm",
      config: {
        networks: new Set([EVM]),
        normalizeAddress: (address) =>
          /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : undefined,
        verify: evmVerifier({ forwarder, served }),
        syncAddresses: alchemySync(alchemy, fetch),
      },
      sealKey: await importSealKey(SEAL_KEY_B64),
      senders: {
        apns: await apnsSender(
          {
            keyPem: await p8Pem(),
            keyId: "E2EKEYID12",
            teamId: "E2ETEAMID1",
            topic: "sh.qntx.wallet.test",
            host: "apns.test",
          },
          fetch,
          now,
        ),
        fcm: await fcmSender(
          {
            projectId: "e2e-project",
            clientEmail: "e2e@example.test",
            privateKeyPem: await rsaPem(),
          },
          fetch,
          now,
        ),
      },
      now,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      wake: () => undefined,
      log: (line) => {
        logs.push(line);
      },
    });
    const result = async <T>(call: () => Promise<T>): Promise<PushResult<T>> => {
      try {
        return { ok: true, value: await call() };
      } catch (error) {
        if (error instanceof GatewayHttpError) {
          return { ok: false, status: error.status, code: error.code };
        }
        throw error;
      }
    };
    const app = gateway({
      fetch,
      now,
      log: (line) => {
        logs.push(line);
      },
      push: {
        platforms: ["apns", "fcm"],
        families: ["evm"],
        backend: () => ({
          subscribe: async (request) => result(async () => core.subscribe(request)),
          unsubscribe: async (id) => result(async () => core.unsubscribe(id)),
          watch: async (request) => result(async () => core.watch(request)),
          ingest: async (items) => result(async () => core.ingest(items)),
        }),
        alchemy: alchemy.hooks,
        limiter: allowAll,
      },
    });

    // The wallet: a random secret → subscription id + payload key; opens every captured push.
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const secretB64 = base64urlOf(secret);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const keyB64 = base64urlOf(key);
    const subscriptionId = await subscriptionIdOf(secret);

    const sub = await app.request("/v1/push/evm/subscription", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secretB64}`,
        "cf-connecting-ip": "203.0.113.7",
        "x-client-id": CLIENT_ID,
      },
      body: JSON.stringify({
        platform: "apns",
        token: DEVICE_TOKEN,
        key: keyB64,
        networks: [EVM],
        addresses: [ADDRESS],
      }),
    });
    expect(sub.status).toBe(200);
    await expect(sub.json()).resolves.toStrictEqual({
      id: subscriptionId,
      networks: [EVM],
      expiresAt: clock + PUSH_TTL_MS,
    });

    const postHook = async (body: string, signature?: string) =>
      app.request("/hooks/alchemy", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature === undefined ? {} : { "x-alchemy-signature": signature }),
        },
        body,
      });
    const postSigned = async (body: string) => postHook(body, await hmac(body, SIGNING_KEY));

    const apnsPushes = (): Array<{ e: string; c: string }> =>
      calls
        .filter((call) => call.url.startsWith(`https://apns.test/3/device/`))
        .map((call) => (JSON.parse(call.body) as { qntx: { e: string; c: string } }).qntx);

    // Incoming ETH activity → receipt success → "received" push the wallet opens.
    const incoming = webhook([externalIn(HASH_IN)]);
    const hookRes = await postSigned(incoming);
    expect(hookRes.status).toBe(200);
    receipts.set(HASH_IN, receipt(HASH_IN, "0x1", FOREIGN));
    await core.alarm();
    expect(apnsPushes()).toHaveLength(1);
    const first = openPush(apnsPushes()[0], [key]);
    expect(first?.keyIndex).toBe(0);
    expect(first?.event).toStrictEqual({
      v: 1,
      k: "received",
      n: EVM,
      h: HASH_IN,
      a: ADDRESS,
      t: clock,
      x: { q: "1500000000000000000", d: 18, s: "ETH" },
    });
    const firstEventId = apnsPushes()[0]?.e;

    // Two absent checks past their delays → "reverted" under a fresh event id.
    receipts.delete(HASH_IN);
    clock += 15_000;
    await core.alarm(); // absence one of two — nothing sent
    expect(apnsPushes()).toHaveLength(1);
    clock += 60_000;
    await core.alarm();
    expect(apnsPushes()).toHaveLength(2);
    const second = openPush(apnsPushes()[1], [key]);
    expect(second?.event.k).toBe("reverted");
    expect(second?.event.h).toBe(HASH_IN);
    expect(apnsPushes()[1]?.e).not.toBe(firstEventId);

    // An engine-registered outgoing watch whose receipt failed → "failed".
    receipts.set(HASH_OUT, receipt(HASH_OUT, "0x0", ADDRESS));
    const watchRes = await app.request("/v1/push/evm/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secretB64}`,
        "cf-connecting-ip": "203.0.113.7",
        "x-client-id": CLIENT_ID,
      },
      body: JSON.stringify({ network: EVM, hash: HASH_OUT }),
    });
    expect(watchRes.status).toBe(200);
    await core.alarm();
    const failed = openPush(apnsPushes().at(-1), [key]);
    expect(apnsPushes()).toHaveLength(3);
    expect(failed?.event).toStrictEqual({
      v: 1,
      k: "failed",
      n: EVM,
      h: HASH_OUT,
      a: ADDRESS,
      t: clock,
    });

    // A watch whose receipt names a foreign sender is discarded without a push.
    receipts.set(HASH_FOREIGN, receipt(HASH_FOREIGN, "0x1", FOREIGN));
    const foreignWatch = await app.request("/v1/push/evm/transactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secretB64}`,
        "cf-connecting-ip": "203.0.113.7",
        "x-client-id": CLIENT_ID,
      },
      body: JSON.stringify({ network: EVM, hash: HASH_FOREIGN }),
    });
    expect(foreignWatch.status).toBe(200);
    await core.alarm();
    expect(apnsPushes()).toHaveLength(3);
    expect(
      sql.exec(`select count(*) as n from records where hash = '${HASH_FOREIGN}'`).toArray()[0]?.[
        "n"
      ],
    ).toBe(0);

    // A bad signature is rejected before anything is ingested.
    const bad = await postHook(webhook([externalIn(HASH_FOREIGN)], "evt-bad"), "00".repeat(32));
    expect(bad.status).toBe(400);
    await core.alarm();
    expect(apnsPushes()).toHaveLength(3);

    // A replayed webhook never produces a second "received" for the same transaction.
    const replayed = webhook([externalIn(HASH_IN)], "evt-2");
    const replayRes = await postSigned(replayed);
    expect(replayRes.status).toBe(200);
    receipts.set(HASH_IN, receipt(HASH_IN, "0x1", FOREIGN));
    await core.alarm();
    const received = apnsPushes().filter((push) => openPush(push, [key])?.event.k === "received");
    expect(received).toHaveLength(1);

    // The address-sync pass reached the dashboard with the watched address.
    const patches = calls.filter((call) =>
      call.url.startsWith("https://dashboard.alchemy.com/api/update-webhook-addresses"),
    );
    expect(patches.length).toBeGreaterThan(0);
    const patchBody = JSON.parse(patches[0]?.body ?? "{}") as { addresses_to_add: string[] };
    expect(patchBody.addresses_to_add).toContain(ADDRESS);

    // Privacy: strip the opaque fields the providers legitimately carry (device token, ciphertext,
    // event id, OAuth tokens/JWTs), then no provider request or log line may contain anything else
    // the push must hide.
    const opaque = new Set<string>([
      DEVICE_TOKEN,
      "e2e-token",
      ...apnsPushes().flatMap((push) => [push.e, push.c]),
    ]);
    let visible = calls
      .filter((call) =>
        [
          "https://apns.test/",
          "https://fcm.googleapis.com/",
          "https://oauth2.googleapis.com/",
        ].some((prefix) => call.url.startsWith(prefix)),
      )
      .map((call) => `${call.url}\n${call.body}`)
      .join("\n");
    for (const value of opaque) {
      visible = visible.split(value).join("");
    }
    visible = visible.replaceAll(/assertion=[^&\s]+/g, "assertion=");
    const secrets = [
      ADDRESS,
      `0X${ADDRESS.slice(2)}`,
      HASH_IN,
      HASH_OUT,
      HASH_FOREIGN,
      EVM,
      "ETH",
      "1500000000000000000",
      subscriptionId,
      keyB64,
      secretB64,
    ];
    for (const needle of secrets) {
      expect(visible).not.toContain(needle);
    }
    const apnsBodies = calls
      .filter((call) => call.url.startsWith("https://apns.test/"))
      .map((call) => call.body)
      .join("\n");
    expect(apnsBodies).not.toContain(DEVICE_TOKEN); // APNs sees the token only in the URL path
    const logText = logs.join("\n");
    for (const needle of [...secrets, DEVICE_TOKEN]) {
      expect(logText).not.toContain(needle);
    }
  });
});
