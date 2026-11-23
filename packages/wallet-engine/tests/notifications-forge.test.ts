/* oxlint-disable vitest/no-conditional-in-test */
/**
 * A valid push hint can only trigger a history reload — it must never inject an entry into the
 * activity list. On a full `createWalletEngine` with a stubbed gateway history and chain RPC:
 * `receive` of a sealed push for a hash the provider does not know returns the hint and reloads
 * history, and the activity list still has no entry for that hash; the entry appears only after the
 * provider starts serving it.
 */
import { randomBytes } from "node:crypto";

import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import vectors from "../../../vectors/push.json" with { type: "json" };
import { createWalletEngine } from "../src/engine.ts";
import { pushAad, PUSH_ID_DOMAIN, pushEventInput } from "../src/gateway/contract/push-message.ts";
import type { PushEventKind } from "../src/gateway/contract/push-message.ts";
import type { PushKeyStore } from "../src/notifications/controller.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GATEWAY = "http://gw.test";
const RPC = "http://127.0.0.1:9";
const EVM = "eip155:1";
const FOREIGN = "0x00000000000000000000000000000000deadbeef";
const HASH = `0x${"ab".repeat(32)}`;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const subscriptionIdOf = (secret: Uint8Array): string => {
  const domain = utf8(PUSH_ID_DOMAIN);
  const input = new Uint8Array(domain.length + secret.length);
  input.set(domain);
  input.set(secret, domain.length);
  return bytesToHex(sha256(input)).slice(0, 32);
};

const seal = (
  key: Uint8Array,
  network: string,
  hash: string,
  kind: PushEventKind,
  address: string,
): { v: string; e: string; c: string } => {
  const eventId = bytesToHex(hmac(sha256, key, utf8(pushEventInput(network, hash, kind, 0)))).slice(
    0,
    32,
  );
  const plaintext = JSON.stringify({
    v: 1,
    k: kind,
    n: network,
    h: hash,
    a: address,
    t: Date.now(),
  });
  const nonce = randomBytes(12);
  const sealed = gcm(key, nonce, utf8(pushAad(eventId))).encrypt(utf8(plaintext));
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return { v: "1", e: eventId, c: base64urlnopad.encode(out) };
};

/* The sealer is proven against the wire vectors once here — this file's assertions all rest on it. */
it("the test sealer reproduces the wire vectors", () => {
  for (const m of vectors.messages) {
    const sealed = gcm(hexToBytes(m.key), hexToBytes(m.nonce), utf8(pushAad(m.eventId))).encrypt(
      utf8(m.plaintext),
    );
    const out = new Uint8Array(12 + sealed.length);
    out.set(hexToBytes(m.nonce), 0);
    out.set(sealed, 12);
    expect(base64urlnopad.encode(out)).toBe(m.message.c);
    expect(m.message.e).toBe(m.eventId);
  }
});

describe("createWalletEngine notifications forge", () => {
  it("a push hint never injects history entries; the list only changes via reload", async () => {
    let historyItems: ReadonlyArray<unknown> = [];
    let historyQueries = 0;
    let capturedPut: { secret: string; body: Record<string, unknown> } | undefined;
    const exported = new Map<string, Uint8Array>();
    const keys: PushKeyStore = {
      // oxlint-disable-next-line typescript/require-await -- the port returns a promise
      put: async (id, key) => {
        exported.set(id, key);
      },
      // oxlint-disable-next-line typescript/require-await -- the port returns a promise
      delete: async (id) => {
        exported.delete(id);
      },
      // oxlint-disable-next-line typescript/require-await -- the port returns a promise
      ids: async () => [...exported.keys()],
    };

    // oxlint-disable-next-line typescript/require-await -- the fetch signature requires a promise
    const fetchStub: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url.startsWith(RPC)) {
        const request = JSON.parse(String(init?.body)) as { id: unknown };
        return Response.json({ jsonrpc: "2.0", id: request.id, result: null });
      }
      const path = url.slice(GATEWAY.length);
      if (method === "GET" && path === "/v1/push") {
        return Response.json({ platforms: ["apns"], families: ["evm"] });
      }
      if (method === "GET" && path === "/v1/networks") {
        return Response.json({ networks: [EVM] });
      }
      if (method === "PUT" && path === "/v1/push/evm/subscription") {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        const secret = base64urlnopad.decode(auth.replace(/^Bearer /, ""));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedPut = { secret: auth.replace(/^Bearer /, ""), body };
        return Response.json({
          id: subscriptionIdOf(secret),
          networks: body["networks"],
          expiresAt: Date.now() + 30 * 86_400_000,
        });
      }
      if (method === "DELETE" && path === "/v1/push/evm/subscription") {
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === `/v1/history/${EVM}`) {
        historyQueries += 1;
        return Response.json({ items: historyItems, cursor: null, truncated: false });
      }
      return Response.json({ error: "unsupported" }, { status: 404 });
    };

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
    try {
      const engine = createWalletEngine({
        publicStore: createMemoryPublicStore(),
        verifyEvent,
        weblnAlias: "test",
        lightningMaxFee: () => 0,
        wallet,
        sparkNetwork: "regtest",
        fetch: fetchStub,
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        logger: { warn: () => undefined },
        showCallsStatus: () => undefined,
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        gateway: { url: GATEWAY },
        rpc: { [EVM]: [RPC] },
        pushKeys: keys,
      });
      await wallet.wallets.importMnemonic({
        mnemonic: MNEMONIC,
        factor: { kind: "password", password: PASSWORD },
      });
      await sleep(300);
      const { walletId } = engine.accounts.getState().wallets[0]!;
      const group = { walletId, groupIndex: 0 };

      await engine.notifications.setToken("apns", "device-token");
      await engine.notifications.enable(walletId);
      await sleep(300);
      if (capturedPut === undefined) {
        throw new Error("no subscription PUT");
      }
      const key = base64urlnopad.decode(String(capturedPut.body["key"]));
      const address = String((capturedPut.body["addresses"] as string[])[0]);
      expect(exported.size).toBe(1);

      /* Warm the group so reconcile has a loaded history to reload. */
      await engine.history.load(group);
      await sleep(300);
      const beforePushQueries = historyQueries;
      expect(beforePushQueries).toBeGreaterThan(0);

      /* A valid hint for a hash the provider does not serve: hint returned, reload ran, no entry. */
      const event = await engine.notifications.receive(seal(key, EVM, HASH, "received", address));
      expect(event).toBeDefined();
      expect(event!.kind).toBe("received");
      expect(event!.hash).toBe(HASH);
      await sleep(300);
      expect(historyQueries).toBeGreaterThan(beforePushQueries);
      let entries = engine.history.getState().groups[`${walletId}:0`]?.entries ?? [];
      expect(entries.some((entry) => entry.hash === HASH)).toBe(false);

      /* Once the provider serves the hash, the entry appears — via the reload only. */
      historyItems = [
        {
          hash: HASH,
          block: "100",
          timestamp: Date.now(),
          transfers: [
            {
              kind: "native",
              from: FOREIGN,
              to: address,
              contract: null,
              tokenId: null,
              amount: "1",
              decimals: null,
              symbol: null,
              logIndex: null,
            },
          ],
        },
      ];
      const beforeKnownQueries = historyQueries;
      const second = await engine.notifications.receive(seal(key, EVM, HASH, "received", address));
      expect(second?.kind).toBe("received");
      await sleep(300);
      expect(historyQueries).toBeGreaterThan(beforeKnownQueries);
      entries = engine.history.getState().groups[`${walletId}:0`]?.entries ?? [];
      expect(entries.some((entry) => entry.hash === HASH)).toBe(true);

      /* A hint for another wallet's address or an unserved network does not even reload. */
      const beforeBadQueries = historyQueries;
      await expect(
        engine.notifications.receive(seal(key, EVM, HASH, "received", FOREIGN)),
      ).resolves.toBeUndefined();
      await expect(
        engine.notifications.receive(seal(key, "eip155:999", HASH, "received", address)),
      ).resolves.toBeUndefined();
      await sleep(300);
      expect(historyQueries).toBe(beforeBadQueries);
    } finally {
      await wallet.vault.lock();
    }
  });
});
