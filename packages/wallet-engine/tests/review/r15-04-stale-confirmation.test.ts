/**
 * Review PoC R15-04: confirmation is observed once and never again. `resolveOwn` re-reads
 * `chains.account` on every history load, but `own.unconfirmed` is a Set that only ever grows — an
 * address recorded while the entry was unconfirmed stays excluded from the known set even after the
 * owner verifies it on the device. The same staleness blinds push: `pushAddresses` filters on the
 * entry's `confirmed` flag, yet `NotificationsController` only re-runs when the accounts or
 * networks stores change — and `signers.verifyAddress` touches neither (it is a device operation
 * against the kernel), so an address confirmed after the first reconcile is never subscribed.
 *
 * Each test asserts today's behaviour — it passes now and fails once a later confirmation is
 * honoured without a store bump.
 */
/* oxlint-disable vitest/no-conditional-in-test -- rig responses and typed reads vary per scripted case */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";

import type { AccountTreeState } from "../../src/accounts/controller.ts";
import { pushAddresses } from "../../src/engine.ts";
import { parseWith } from "../../src/gateway/contract/endpoint.ts";
import { PUSH_ID_DOMAIN } from "../../src/gateway/contract/push-message.ts";
import { pushSubscriptionRequest } from "../../src/gateway/contract/push.ts";
import type { NetworkControllerState } from "../../src/networks/controller.ts";
import { NotificationsController } from "../../src/notifications/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { TransactionControllerState } from "../../src/transactions/controller.ts";
import { EVM, flagsOf, GROUP2, historyRig } from "./history-rig.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("R15-04a: an unconfirmed-then-confirmed address never enters the known set", () => {
  it("the second load still skips it — own.unconfirmed only grows", async () => {
    const confirmed = { current: false };
    const { controller } = historyRig(confirmed);
    await controller.init();
    await controller.load(GROUP2);
    // While the entry is unconfirmed the address is excluded — the flag is withheld.
    expect(flagsOf(controller)).not.toContain("lookalike-counterparty");

    // The owner verifies the address on the device: chains.account now reports confirmed, the
    // same controller reloads — and the stale unconfirmed mark still excludes it.
    confirmed.current = true;
    await controller.load(GROUP2);
    expect(flagsOf(controller)).not.toContain("lookalike-counterparty");
    controller.lock();
  });

  it("control: a controller that first reads the entry confirmed flags the lookalike", async () => {
    const { controller } = historyRig({ current: true });
    await controller.init();
    await controller.load(GROUP2);
    expect(flagsOf(controller)).toContain("lookalike-counterparty");
    controller.lock();
  });
});

const TOKEN = "device-token-abc";
const ADDRESS = "0x00000000000000000000000000000000aaBBccdd";
const NOW0 = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const subscriptionIdOf = (secret: Uint8Array): string => {
  const domain = utf8(PUSH_ID_DOMAIN);
  const input = new Uint8Array(domain.length + secret.length);
  input.set(domain);
  input.set(secret, domain.length);
  return bytesToHex(sha256(input)).slice(0, 32);
};

type Request = {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: unknown;
};

/** The notifications rig, with `addresses` wired through the real `pushAddresses`. */
const pushRig = (confirmed: { current: boolean }) => {
  const requests: Request[] = [];
  const timers: Array<() => void> = [];
  let now = NOW0;
  const store = createMemoryEngineStore();
  const tree: AccountTreeState = {
    status: "ready",
    wallets: [{ walletId: "w1", updatedAt: 0, custody: "vault" as const, state: "ready" as const }],
    groups: {
      w1: [{ walletId: "w1", index: 0, hidden: false, updatedAt: 0 }],
    },
    selected: null,
    totals: {},
  };
  const accountsStore = createStore<AccountTreeState>(() => tree);
  const networksStore = createStore<NetworkControllerState>(() => ({ customRpc: {} }));
  const txStore = createStore<TransactionControllerState>(() => ({ txs: {} }));
  const gatewayFetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: headers.get("authorization") ?? undefined,
      body,
    });
    if (url.pathname === "/v1/push") {
      return Promise.resolve(Response.json({ platforms: ["apns"], families: ["evm"] }));
    }
    const subscriptionPath = /^\/v1\/push\/(evm|solana|tron|bitcoin)\/subscription$/.test(
      url.pathname,
    );
    if (subscriptionPath && init?.method === "PUT") {
      const parsed = parseWith(pushSubscriptionRequest, body);
      if (parsed === undefined) {
        return Promise.resolve(new Response("bad body", { status: 400 }));
      }
      const secret = base64urlnopad.decode((headers.get("authorization") ?? "").slice(7));
      const networks = parsed.networks.filter((n) => n === EVM);
      return Promise.resolve(
        Response.json({ id: subscriptionIdOf(secret), networks, expiresAt: now + 30 * DAY }),
      );
    }
    if (subscriptionPath && init?.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const groupAddresses = async (
    _group: { readonly walletId: string; readonly groupIndex: number },
    _family: "evm" | "solana" | "tron",
  ): Promise<ReadonlyArray<{ network: string; address: string; confirmed: boolean }>> =>
    Promise.resolve([{ network: EVM, address: ADDRESS, confirmed: confirmed.current }]);
  const controller = new NotificationsController({
    gateway: { url: "https://gateway.test", fetch: gatewayFetchImpl },
    openStore: async () => Promise.resolve(store),
    random: (n) => {
      const out = new Uint8Array(n);
      crypto.getRandomValues(out);
      return out;
    },
    now: () => now,
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => undefined;
    },
    logger: { warn: () => undefined },
    keys: {
      put: async () => Promise.resolve(),
      delete: async () => Promise.resolve(),
      ids: async () => Promise.resolve([]),
    },
    accounts: { getState: accountsStore.getState, store: accountsStore },
    networks: {
      enabled: (family: string) => (family === "evm" ? [EVM] : []),
      store: networksStore,
    },
    transactions: { store: txStore },
    addresses: async (walletId, family) =>
      pushAddresses(
        { accounts: { getState: accountsStore.getState }, groupAddresses },
        walletId,
        family,
      ),
    reconcile: async () => Promise.resolve(),
  });
  const flush = async (): Promise<void> => {
    while (timers.length > 0) {
      const batch = timers.splice(0);
      for (const fn of batch) {
        fn();
      }
      // Let the serialized reconcile chain settle.
      // oxlint-disable-next-line eslint/no-await-in-loop -- drain until no timer re-arms
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  };
  return {
    controller,
    requests,
    flush,
    setNow: (t: number) => {
      now = t;
    },
    emitAccounts: () => {
      // A fresh `wallets` array is the change signal the controller watches for.
      accountsStore.setState({ wallets: [...tree.wallets] });
    },
  };
};

const puts = (h: ReturnType<typeof pushRig>): Request[] =>
  h.requests.filter((r) => r.method === "PUT");

describe("R15-04b: an address confirmed after the first reconcile is never subscribed", () => {
  it("verifyAddress touches no store, so nothing re-runs pushAddresses", async () => {
    const confirmed = { current: false };
    const h = pushRig(confirmed);
    await h.controller.init();
    await h.controller.enable("w1");
    await h.controller.setToken("apns", TOKEN);
    await h.flush();
    // Unconfirmed at reconcile: pushAddresses returns [] — no desired subscription, no PUT.
    expect(puts(h)).toHaveLength(0);

    // `engine.signers.verifyAddress` is a device operation on the kernel — it flips the
    // entry's confirmed flag and touches neither the accounts nor the networks store. Mirror
    // that: flip the flag and let two hours of timers drain.
    confirmed.current = true;
    h.setNow(NOW0 + 2 * HOUR);
    await h.flush();
    await h.flush();
    expect(puts(h)).toHaveLength(0);

    // Control: only an accounts-store change re-runs the reconcile — then the PUT appears.
    h.emitAccounts();
    await h.flush();
    expect(puts(h)).toHaveLength(1);
    const body = (puts(h)[0]?.body ?? {}) as { addresses?: string[] };
    expect(body.addresses).toStrictEqual([ADDRESS]);
  });
});
