/**
 * The real `NotificationsController` against the real gateway: its PUT lands in a live `PushCore`,
 * a signed Alchemy webhook and a receipt later produce an APNs delivery the controller's `receive`
 * opens back into a `NotificationEvent`, and a submitted transaction flows through `POST
 * /v1/push/evm/transactions` into a `sent` push.
 */
/* oxlint-disable vitest/no-conditional-in-test -- scripted gateway and clock vary per step */

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  createMemoryEngineStore,
  gatewayFetch,
  gatewaySession,
  NotificationsController,
} from "@qntx/wallet-engine";
import type {
  AccountTreeState,
  NetworkControllerState,
  NotificationEvent,
  TransactionControllerState,
} from "@qntx/wallet-engine";
import { openPush } from "@qntx/wallet-engine/push";

import { GatewayHttpError } from "../src/middleware/errors.ts";
import { indexNetworks } from "../src/middleware/network.ts";
import { createForwarder } from "../src/providers/forward.ts";
import type { PushResult } from "../src/push/backend.ts";
import { PushCore } from "../src/push/core.ts";
import { utf8 } from "../src/push/encoding.ts";
import { importSealKey } from "../src/push/seal.ts";
import { apnsSender } from "../src/push/senders.ts";
import { pushStore } from "../src/push/store.ts";
import { evmVerifier } from "../src/push/verify-evm.ts";
import { alchemyConfig, alchemySync } from "../src/push/watch-alchemy.ts";
import { TEST_ACCOUNTS, allowAll, fakeFetch, gateway, openBudget } from "./helpers.ts";
import { SEAL_KEY_B64, p8Pem } from "./push/helpers.ts";
import { nodeSql } from "./push/sql.ts";

const SIGNING_KEY = "e2e-engine-signing-key";
const WEBHOOK_ID = "wh_engine_e2e";
const ADDRESS = `0x${"3".repeat(40)}`;
const HASH_IN = `0x${"b".repeat(64)}`;
const HASH_OUT = `0x${"c".repeat(64)}`;
const DEVICE_TOKEN = "cd".repeat(32);
const UPSTREAM_URL = "https://evm.upstream.test/rpc";
const EVM = "eip155:1";

/** A `StoreApi`-shaped minimal store — gateway tests have no zustand dependency. */
const miniStore = <S>(initial: S) => {
  let state = initial;
  const subs = new Set<(next: S, previous: S) => void>();
  return {
    getState: () => state,
    getInitialState: () => initial,
    setState: (partial: S | Partial<S> | ((s: S) => S | Partial<S>)) => {
      const previous = state;
      const patch =
        typeof partial === "function" ? (partial as (s: S) => S | Partial<S>)(state) : partial;
      state = { ...state, ...patch };
      for (const fn of subs) {
        fn(state, previous);
      }
    },
    subscribe: (fn: (next: S, previous: S) => void) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
};

const hmac = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const webhook = (hash: string): string =>
  JSON.stringify({
    webhookId: WEBHOOK_ID,
    id: "evt-1",
    createdAt: "2025-01-01T00:00:00.000Z",
    type: "ADDRESS_ACTIVITY",
    event: {
      network: "ETH_MAINNET",
      activity: [
        {
          blockNum: "0x64",
          hash,
          fromAddress: `0x${"9".repeat(40)}`,
          toAddress: ADDRESS,
          value: 1.5,
          asset: "ETH",
          category: "external",
          rawContract: { rawValue: "0x14d1120d7b160000" },
        },
      ],
    },
  });

describe("push engine end to end", () => {
  it("drives the engine's NotificationsController against the real gateway", async () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const logs: string[] = [];
    const receipts = new Map<string, unknown>([
      [
        HASH_IN,
        {
          transactionHash: HASH_IN,
          status: "0x1",
          blockNumber: "0x64",
          from: `0x${"9".repeat(40)}`,
          to: ADDRESS,
        },
      ],
      [
        HASH_OUT,
        {
          transactionHash: HASH_OUT,
          status: "0x1",
          blockNumber: "0x65",
          from: ADDRESS,
          to: `0x${"8".repeat(40)}`,
        },
      ],
    ]);
    const { fetch, calls } = fakeFetch({
      "https://evm.upstream.test/": (call) => {
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
        ALCHEMY_NOTIFY_TOKEN: "tok",
        ALCHEMY_WEBHOOKS: `{"${EVM}": {"id":"${WEBHOOK_ID}","signingKey":"${SIGNING_KEY}"}}`,
      },
      new Set([EVM]),
    );
    if (alchemy === undefined) {
      throw new TypeError("alchemy config");
    }
    const sql = nodeSql(new DatabaseSync(":memory:"));
    pushStore(sql);
    const core = new PushCore({
      sql,
      family: "evm",
      config: {
        networks: new Set([EVM]),
        normalizeAddress: (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : undefined),
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
            topic: "t",
            host: "apns.test",
          },
          fetch,
          now,
        ),
      },
      now,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      wake: () => undefined,
      log: (line) => logs.push(line),
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
      log: (line) => logs.push(line),
      push: {
        platforms: ["apns"],
        families: ["evm"],
        backend: () => ({
          subscribe: async (r) => result(async () => core.subscribe(r)),
          unsubscribe: async (id) => result(async () => core.unsubscribe(id)),
          watch: async (r) => result(async () => core.watch(r)),
          ingest: async (items) => result(async () => core.ingest(items)),
        }),
        alchemy: alchemy.hooks,
        limiter: allowAll,
      },
    });

    // The engine side: a real controller whose gateway fetch goes through the app's request
    // pipeline with the session's per-scope client ids attached.
    const session = gatewaySession("https://gw.test", (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const seen: string[] = [];
    const viaApp: typeof globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = await app.request(url, init);
      seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname} → ${res.status}`);
      return res;
    };
    const timers: Array<() => void> = [];
    const keys = new Map<string, Uint8Array>();
    const reconciled: NotificationEvent[] = [];
    const tree: AccountTreeState = {
      status: "ready",
      wallets: [{ walletId: "w1", updatedAt: 0 }],
      groups: {},
      selected: null,
      totals: {},
    };
    const accountsStore = miniStore<AccountTreeState>(tree);
    const networksStore = miniStore<NetworkControllerState>({ customRpc: {} });
    const txStore = miniStore<TransactionControllerState>({ txs: {} });
    const controller = new NotificationsController({
      gateway: { url: "https://gw.test", fetch: gatewayFetch(viaApp, session) },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      now,
      setTimer: (_ms, fn) => {
        timers.push(fn);
        return () => undefined;
      },
      logger: { warn: () => undefined },
      keys: {
        put: async (id, key) => {
          keys.set(id, key);
          await Promise.resolve();
        },
        delete: async (id) => {
          keys.delete(id);
          await Promise.resolve();
        },
      },
      accounts: { getState: accountsStore.getState, store: accountsStore },
      networks: { enabled: (f) => (f === "evm" ? [EVM] : []), store: networksStore },
      transactions: { store: txStore },
      addresses: async () => Promise.resolve([ADDRESS]),
      reconcile: async (event) => {
        reconciled.push(event);
        await Promise.resolve();
      },
    });
    const flush = async (): Promise<void> => {
      // Drain the reconcile timer, then let the floating request chain settle over a few rounds.
      for (let round = 0; round < 6; round += 1) {
        for (const fn of timers.splice(0)) {
          fn();
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- bounded drain rounds
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await controller.init();
    await controller.setToken("apns", DEVICE_TOKEN);
    await controller.enable("w1");
    await flush();
    expect(controller.getState().wallets["w1"]?.families["evm"]).toBe("active");

    // Incoming activity → receipt success → the APNs body opens through the controller.
    const body = webhook(HASH_IN);
    const hook = await app.request("/hooks/alchemy", {
      method: "POST",
      headers: { "content-type": "application/json", "x-alchemy-signature": await hmac(body) },
      body,
    });
    expect(hook.status).toBe(200);
    await core.alarm();
    const apns = calls
      .filter((c) => c.url.startsWith("https://apns.test/3/device/"))
      .map((c) => (JSON.parse(c.body) as { qntx: { e: string; c: string } }).qntx);
    expect(apns).toHaveLength(1);
    const event = await controller.receive(apns[0]);
    expect(event).toStrictEqual({
      walletId: "w1",
      family: "evm",
      kind: "received",
      network: EVM,
      hash: HASH_IN,
      address: ADDRESS,
      observedAt: clock,
      transfer: { amount: "1500000000000000000", decimals: 18, symbol: "ETH" },
    });
    expect(reconciled).toHaveLength(1);

    // A submitted transaction → POST /transactions → the watch reaches the core → `sent`.
    txStore.setState({
      txs: {
        out1: {
          id: "out1",
          family: "evm",
          network: EVM,
          account: "w1",
          hash: HASH_OUT,
          state: "submitted",
          intent: undefined,
          nonce: 0,
          submittedAt: 0,
          error: undefined,
        },
      },
    });
    await flush();
    // The store-subscribe POST is fire-and-forget; let it land before the check.
    await new Promise((resolve) => setTimeout(resolve, 100));
    clock += 1000;
    await core.alarm();
    const sent = calls
      .filter((c) => c.url.startsWith("https://apns.test/3/device/"))
      .map((c) => (JSON.parse(c.body) as { qntx: { e: string; c: string } }).qntx);
    expect(sent).toHaveLength(2);
    const [key] = keys.values();
    const [, second] = sent;
    const opened = key === undefined ? undefined : openPush(second, [key]);
    expect(opened?.event.k).toBe("sent");
    expect(logs.join("\n")).not.toContain(ADDRESS);
    expect(logs.join("\n")).not.toContain(DEVICE_TOKEN);
  });
});
