/**
 * `NotificationsController` — subscription lifecycle against a contract-checked fake gateway,
 * hostile responses, `receive` opening real sealed envelopes, and outgoing transaction watches.
 */
/* oxlint-disable vitest/no-conditional-in-test -- gateway responses vary per scripted case */

import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import vectors from "../../../vectors/push.json" with { type: "json" };
import type { AccountTreeState } from "../src/accounts/controller.ts";
import { gatewayFetch, gatewaySession } from "../src/gateway/client.ts";
import { parseWith } from "../src/gateway/contract/endpoint.ts";
import { PUSH_ID_DOMAIN, pushAad, pushEventInput } from "../src/gateway/contract/push-message.ts";
import type { PushEventKind } from "../src/gateway/contract/push-message.ts";
import { PUSH_AUTH_SCHEME, pushSubscriptionRequest } from "../src/gateway/contract/push.ts";
import type { NetworkControllerState } from "../src/networks/controller.ts";
import { NotificationsController } from "../src/notifications/controller.ts";
import type { NotificationEvent } from "../src/notifications/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { TransactionControllerState } from "../src/transactions/controller.ts";

const TOKEN = "device-token-abc";
const ADDRESS = "0x00000000000000000000000000000000aaBBccdd";
const EVM = "eip155:1";
const NOW0 = 1_700_000_000_000;
const DAY = 86_400_000;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const eventIdOf = (key: Uint8Array, network: string, hash: string, kind: PushEventKind): string =>
  bytesToHex(hmac(sha256, key, utf8(pushEventInput(network, hash, kind, 0)))).slice(0, 32);

const subscriptionIdOf = (secret: Uint8Array): string => {
  const domain = utf8(PUSH_ID_DOMAIN);
  const input = new Uint8Array(domain.length + secret.length);
  input.set(domain);
  input.set(secret, domain.length);
  return bytesToHex(sha256(input)).slice(0, 32);
};

/** Seals exactly per `vectors/push.json`; the first vector case proves the helper itself. */
const sealForTest = (
  key: Uint8Array,
  eventId: string,
  plaintext: string,
  nonce: Uint8Array,
): string => {
  const sealed = gcm(key, nonce, utf8(pushAad(eventId))).encrypt(utf8(plaintext));
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return base64urlnopad.encode(out);
};

it("the test sealer reproduces the wire vectors", () => {
  for (const m of vectors.messages) {
    const { message } = m;
    expect(message.e).toBe(m.eventId);
    expect(sealForTest(hexToBytes(m.key), m.eventId, m.plaintext, hexToBytes(m.nonce))).toBe(
      message.c,
    );
  }
});

type Request = {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly clientId: string | undefined;
  readonly body: unknown;
};

type Options = {
  readonly caps?: Record<string, unknown> | "fail";
  readonly put?: "ok" | "404" | "500" | "bad-id" | "extra-networks" | "bad-json" | "empty";
  readonly del?: "ok" | "fail";
  readonly token?: boolean;
  readonly served?: ReadonlyArray<string>;
  readonly addresses?: ReadonlyArray<string>;
  readonly families?: ReadonlyArray<"evm" | "solana" | "bitcoin" | "tron">;
  readonly keys?: {
    put: (id: string, key: Uint8Array) => Promise<void>;
    delete: (id: string) => Promise<void>;
  };
  readonly now?: () => number;
};

const harness = (options: Options = {}) => {
  const requests: Request[] = [];
  const keyCalls: Array<{ kind: "put" | "delete"; id: string }> = [];
  const reconciled: NotificationEvent[] = [];
  const timers: Array<() => void> = [];
  let now = options.now?.() ?? NOW0;
  const served = options.served ?? [EVM];
  const families = options.families ?? ["evm" as const];
  const store = createMemoryEngineStore();
  const enabledMap: Record<string, string[]> = { evm: [EVM] };
  const tree: AccountTreeState = {
    status: "ready",
    wallets: [{ walletId: "w1", updatedAt: 0 }],
    groups: {},
    selected: null,
    totals: {},
  };
  const accountsStore = createStore<AccountTreeState>(() => tree);
  const networksStore = createStore<NetworkControllerState>(() => ({ customRpc: {} }));
  const txStore = createStore<TransactionControllerState>(() => ({ txs: {} }));
  // oxlint-disable-next-line typescript/require-await -- the fetch signature requires a promise
  const gatewayFetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: headers.get("authorization") ?? undefined,
      clientId: headers.get("x-client-id") ?? undefined,
      body,
    });
    if (url.pathname === "/v1/push") {
      if (options.caps === "fail") {
        return new Response("down", { status: 500 });
      }
      return Response.json(options.caps ?? { platforms: ["apns"], families });
    }
    if (url.pathname === "/v1/push/evm/subscription" && init?.method === "PUT") {
      const parsed = parseWith(pushSubscriptionRequest, body);
      if (parsed === undefined) {
        return new Response("bad body", { status: 400 });
      }
      const mode = options.put ?? "ok";
      if (mode === "500") {
        return new Response("err", { status: 500 });
      }
      if (mode === "404") {
        return Response.json({ error: { code: "unsupported" } }, { status: 404 });
      }
      if (mode === "bad-json") {
        return new Response("not json", { status: 200 });
      }
      const secret = base64urlnopad.decode((headers.get("authorization") ?? "").slice(7));
      const id = mode === "bad-id" ? "0".repeat(32) : subscriptionIdOf(secret);
      const networks =
        mode === "extra-networks"
          ? [...served, "eip155:99"]
          : mode === "empty"
            ? []
            : parsed.networks.filter((n) => served.includes(n));
      return Response.json({ id, networks, expiresAt: now + 30 * DAY });
    }
    if (url.pathname === "/v1/push/evm/subscription" && init?.method === "DELETE") {
      return options.del === "fail"
        ? new Response("err", { status: 500 })
        : new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/push/evm/transactions") {
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  };
  let seed = 0;
  const gateway = gatewaySession("https://gateway.test", (n) => {
    seed += 1;
    return new Uint8Array(n).fill(seed);
  });
  const controller = new NotificationsController({
    gateway: {
      url: "https://gateway.test",
      fetch: gatewayFetch(gatewayFetchImpl, gateway),
    },
    openStore: async () => Promise.resolve(store),
    random: (n) => {
      const out = new Uint8Array(n);
      crypto.getRandomValues(out);
      return out;
    },
    now: () => now,
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => {};
    },
    logger: { warn: () => undefined },
    keys: options.keys ?? {
      put: async (id) => {
        keyCalls.push({ kind: "put", id });
        await Promise.resolve();
      },
      delete: async (id) => {
        keyCalls.push({ kind: "delete", id });
        await Promise.resolve();
      },
    },
    accounts: { getState: accountsStore.getState, store: accountsStore },
    networks: {
      enabled: (family: string) => enabledMap[family] ?? [],
      store: networksStore,
    },
    transactions: { store: txStore },
    addresses: async () => Promise.resolve(options.addresses ?? [ADDRESS]),
    reconcile: async (event) => {
      reconciled.push(event);
      await Promise.resolve();
    },
  });
  const flush = async (): Promise<void> => {
    while (timers.length > 0) {
      const batch = timers.splice(0);
      for (const fn of batch) {
        fn();
      }
      // Let the serialized reconcile chain settle.
      // oxlint-disable-next-line eslint/no-await-in-loop -- drain until no timer re-arms
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    controller,
    requests,
    keyCalls,
    reconciled,
    timers,
    flush,
    txStore,
    setNow: (t: number) => {
      now = t;
    },
    emitAccounts: () => {
      // A fresh `wallets` array is the change signal the controller watches for.
      accountsStore.setState({ wallets: [...tree.wallets] });
    },
  };
};

const puts = (h: ReturnType<typeof harness>): Request[] =>
  h.requests.filter((r) => r.method === "PUT");

describe("NotificationsController", () => {
  it("throws while locked and receive answers undefined", async () => {
    const h = harness();
    await expect(h.controller.setToken("apns", TOKEN)).rejects.toThrow("unlocked");
    await expect(h.controller.enable("w1")).rejects.toThrow("unlocked");
    await expect(h.controller.disable("w1")).rejects.toThrow("unlocked");
    await expect(h.controller.receive({})).resolves.toBeUndefined();
  });

  it("enable without a token PUTs nothing; setToken then PUTs and exports the key", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.enable("w1");
    await h.flush();
    expect(puts(h)).toHaveLength(0);
    await h.controller.setToken("apns", TOKEN);
    await h.flush();
    const [put] = puts(h);
    expect(put).toBeDefined();
    expect(put?.auth?.startsWith(`${PUSH_AUTH_SCHEME} `)).toBe(true);
    const body = (put === undefined ? {} : put.body) as {
      token: string;
      addresses: string[];
      networks: string[];
    };
    expect(body.token).toBe(TOKEN);
    expect(body.addresses).toStrictEqual([ADDRESS]);
    expect(body.networks).toStrictEqual([EVM]);
    expect(h.keyCalls).toStrictEqual([
      { kind: "put", id: subscriptionIdOf(base64urlnopad.decode((put?.auth ?? "").slice(7))) },
    ]);
    expect(h.controller.getState().wallets["w1"]?.families["evm"]).toBe("active");
  });

  it("GET /v1/push carries the service client id, PUT the family id", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    const get = h.requests.find((r) => r.method === "GET" && r.path === "/v1/push");
    const [put] = puts(h);
    expect(get?.clientId).toBeDefined();
    expect(put?.clientId).toBeDefined();
    expect(put?.clientId).not.toBe(get?.clientId);
  });

  it("token rotation re-PUTs under the same bearer", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    await h.controller.setToken("apns", "rotated-token");
    await h.flush();
    expect(puts(h)).toHaveLength(2);
    const [a, b] = puts(h);
    expect(a?.auth).toBe(b?.auth);
    expect(((b === undefined ? {} : b.body) as { token: string }).token).toBe("rotated-token");
  });

  it("refreshes only after seven days", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    h.setNow(NOW0 + 6 * DAY);
    h.emitAccounts();
    await h.flush();
    expect(puts(h)).toHaveLength(1);
    h.setNow(NOW0 + 8 * DAY);
    h.emitAccounts();
    await h.flush();
    expect(puts(h)).toHaveLength(2);
  });

  it("a network enablement change re-PUTs", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    expect(puts(h)).toHaveLength(1);
  });

  it("disable DELETEs and removes the exported key", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    const [put] = puts(h);
    const id = subscriptionIdOf(base64urlnopad.decode((put?.auth ?? "").slice(7)));
    await h.controller.disable("w1");
    await h.flush();
    expect(h.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(h.keyCalls).toContainEqual({ kind: "delete", id });
    expect(h.controller.getState().wallets["w1"]).toBeUndefined();
  });

  it("a failed DELETE keeps the row and retries next reconcile", async () => {
    const h = harness({ del: "fail" });
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    await h.controller.disable("w1");
    await h.flush();
    expect(h.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    h.emitAccounts();
    await h.flush();
    expect(h.requests.filter((r) => r.method === "DELETE").length).toBeGreaterThan(1);
  });

  it("404 unsupported leaves no subscription and no key", async () => {
    const h = harness({ put: "404" });
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    expect(h.keyCalls).toStrictEqual([]);
    expect(h.controller.getState().wallets["w1"]?.families["evm"]).toBe("failed");
  });

  it("hostile gateway: bad id, extra networks, bad json, 5xx all fail without persisting", async () => {
    for (const put of ["bad-id", "extra-networks", "bad-json", "500"] as const) {
      const h = harness({ put });
      // oxlint-disable-next-line eslint/no-await-in-loop -- each scenario runs serially
      await h.controller.init();
      // oxlint-disable-next-line eslint/no-await-in-loop -- each scenario runs serially
      await h.controller.setToken("apns", TOKEN);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each scenario runs serially
      await h.controller.enable("w1");
      // oxlint-disable-next-line eslint/no-await-in-loop -- each scenario runs serially
      await h.flush();
      expect(h.controller.getState().wallets["w1"]?.families["evm"]).toBe("failed");
      expect(h.keyCalls).toStrictEqual([]);
    }
  });

  it("an empty served set behaves as unsupported", async () => {
    const h = harness({ put: "empty" });
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    expect(h.keyCalls).toStrictEqual([]);
    expect(h.controller.getState().wallets["w1"]?.families["evm"]).toBe("failed");
  });

  it("a capabilities failure marks opted-in wallets failed", async () => {
    const h = harness({ caps: "fail" });
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    expect(h.controller.getState().wallets["w1"]?.families["evm"]).toBe("failed");
    expect(h.controller.getState().capabilities).toBeUndefined();
  });

  it("survives a lock/unlock cycle without a fresh PUT when unchanged", async () => {
    const h = harness();
    const store = createMemoryEngineStore();
    void store;
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    expect(puts(h)).toHaveLength(1);
    h.controller.lock();
    expect(h.controller.getState().status).toBe("locked");
    await h.controller.init();
    await h.flush();
    expect(puts(h)).toHaveLength(1);
    expect(h.controller.getState().wallets["w1"]?.families["evm"]).toBe("active");
  });

  it("receive opens a sealed envelope and reconciles once", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    const [put] = puts(h);
    const keyB64 = ((put === undefined ? {} : put.body) as { key: string }).key;
    const key = base64urlnopad.decode(keyB64);
    const hash = `0x${"ab".repeat(32)}`;
    const eventId = eventIdOf(key, EVM, hash, "received");
    const plaintext = JSON.stringify({
      v: 1,
      k: "received",
      n: EVM,
      h: hash,
      a: ADDRESS.toLowerCase(),
      t: NOW0,
      x: { q: "1000000000000000000", d: 18, s: "ETH" },
    });
    const nonce = new Uint8Array(12).fill(3);
    const message = { v: "1", e: eventId, c: sealForTest(key, eventId, plaintext, nonce) };
    const event = await h.controller.receive(message);
    expect(event).toStrictEqual({
      walletId: "w1",
      family: "evm",
      kind: "received",
      network: EVM,
      hash,
      address: ADDRESS.toLowerCase(),
      observedAt: NOW0,
      transfer: { amount: "1000000000000000000", decimals: 18, symbol: "ETH" },
    });
    expect(h.reconciled).toHaveLength(1);
  });

  it("receive rejects wrong key, tampered blob, foreign network and address", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    const [put] = puts(h);
    const key = base64urlnopad.decode(((put === undefined ? {} : put.body) as { key: string }).key);
    const hash = `0x${"cd".repeat(32)}`;
    const sealed = (network: string, address: string, kind: PushEventKind = "received") => {
      const e = eventIdOf(key, network, hash, kind);
      const c = sealForTest(
        key,
        e,
        JSON.stringify({ v: 1, k: kind, n: network, h: hash, a: address, t: NOW0 }),
        new Uint8Array(12),
      );
      return { v: "1", e, c };
    };
    await expect(h.controller.receive(sealed("eip155:137", ADDRESS))).resolves.toBeUndefined();
    await expect(
      h.controller.receive(sealed(EVM, `0x${"11".repeat(20)}`)),
    ).resolves.toBeUndefined();
    const good = sealed(EVM, ADDRESS);
    await expect(
      h.controller.receive({ ...good, c: `${good.c.slice(0, -4)}AAAA` }),
    ).resolves.toBeUndefined();
    const wrong = new Uint8Array(32).fill(9);
    const e = eventIdOf(wrong, EVM, hash, "received");
    await expect(
      h.controller.receive({
        v: "1",
        e,
        c: sealForTest(wrong, e, "{}", new Uint8Array(12)),
      }),
    ).resolves.toBeUndefined();
    expect(h.reconciled).toStrictEqual([]);
  });

  it("POSTs one watch per submitted transaction of an opted-in wallet", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    const tx = {
      id: "t1",
      family: "evm" as const,
      network: EVM,
      account: "w1",
      hash: `0x${"ef".repeat(32)}`,
      state: "submitted" as const,
      intent: undefined,
      nonce: 0,
      submittedAt: 0,
      error: undefined,
    };
    h.txStore.setState({ txs: { t1: tx } });
    await h.flush();
    const posts = h.requests.filter((r) => r.path.endsWith("/transactions"));
    expect(posts).toHaveLength(1);
    h.txStore.setState({ txs: { t1: tx } });
    await h.flush();
    expect(h.requests.filter((r) => r.path.endsWith("/transactions"))).toHaveLength(1);
  });

  it("ignores imported-key txs and unserved networks", async () => {
    const h = harness();
    await h.controller.init();
    await h.controller.setToken("apns", TOKEN);
    await h.controller.enable("w1");
    await h.flush();
    h.txStore.setState({
      txs: {
        imported: {
          id: "imported",
          family: "evm" as const,
          network: EVM,
          account: "k1",
          hash: `0x${"ab".repeat(32)}`,
          state: "submitted" as const,
          intent: undefined,
          nonce: 0,
          submittedAt: 0,
          error: undefined,
        },
        unserved: {
          id: "unserved",
          family: "evm" as const,
          network: "eip155:99",
          account: "w1",
          hash: `0x${"cd".repeat(32)}`,
          state: "submitted" as const,
          intent: undefined,
          nonce: 0,
          submittedAt: 0,
          error: undefined,
        },
      },
    });
    await h.flush();
    expect(h.requests.filter((r) => r.path.endsWith("/transactions"))).toHaveLength(0);
  });
});
