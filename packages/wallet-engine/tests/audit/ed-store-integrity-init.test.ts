/**
 * ED-PoC-11 — an `EngineStoreError("integrity")` from the real (encrypted/IndexedDB) store
 * propagates out of `init()` for every controller that scans a collection: one tampered or
 * wrong-key record wedges unlock for that controller. The F-054 fix only made JSON DECODING
 * tolerant (readJson after `get`), so this path — the store throwing before a byte is returned — is
 * what tests/store-rows.test.ts's unencrypted memory store never exercises.
 *
 * Real Web store: src/idb/indexeddb.ts:72-79 throws `EngineStoreError("integrity", ...)` when the
 * record MAC fails. Every controller init here does `collection.list()` + `Promise.all(get)`
 * (transactions/controller.ts:242-244, addresses/controller.ts:52-54,
 * connect/controller.ts:261-263, accounts/watch.ts init ≈89-91) or a direct `get`
 * (networks/controller.ts:231, assets/controller.ts:121) — no try/catch anywhere.
 *
 * Plus src/spark/store.ts:19,35 — raw `JSON.parse` on the exit-chain index, so a torn record throws
 * SyntaxError rather than being skipped.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { WatchController } from "../../src/accounts/watch.ts";
import { AddressBookController } from "../../src/addresses/controller.ts";
import { AssetsController } from "../../src/assets/controller.ts";
import { ConnectionController } from "../../src/connect/controller.ts";
import { EngineStoreError } from "../../src/errors.ts";
import type { EngineLogger } from "../../src/events.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { sparkStore } from "../../src/spark/store.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { EngineCollection, EngineStore } from "../../src/store/port.ts";
import { TransactionController } from "../../src/transactions/controller.ts";

const LOGGER: EngineLogger = { warn: () => {} };

const isWallet = (_v: unknown): _v is Wallet => true;
const stub = <T>(v: unknown, guard: (v: unknown) => v is T): T => {
  if (guard(v)) {
    return v;
  }
  throw new Error("unreachable");
};

/**
 * A memory store with exactly one poisoned record: `list()` exposes the key (so scan-inits reach
 * for it) and `get` throws `integrity` — the same failure the MAC-checked IndexedDB store produces
 * for a tampered or wrong-key record.
 */
const poisonedStore = (collection: string, key: string): EngineStore => {
  const inner = createMemoryEngineStore();
  return {
    collection(name: string): EngineCollection {
      const col = inner.collection(name);
      return {
        get: async (k) => {
          if (name === collection && k === key) {
            throw new EngineStoreError("integrity", "engine record failed integrity");
          }
          return col.get(k);
        },
        put: async (k, bytes) => col.put(k, bytes),
        delete: async (k) => col.delete(k),
        list: async () => {
          const keys = await col.list();
          return name === collection ? [key, ...keys.filter((k) => k !== key)] : keys;
        },
      };
    },
    close: async () => inner.close(),
  };
};

const openStore = (store: EngineStore) => async (): Promise<EngineStore> => {
  await Promise.resolve();
  return store;
};

const isIntegrityError = (e: unknown): boolean =>
  e instanceof EngineStoreError && e.code === "integrity";

describe("ED-PoC-11 a store integrity error wedges controller init", () => {
  it("ED-PoC-11a: TransactionController init rejects on a corrupt 'transactions' record", async () => {
    const ctl = new TransactionController({
      wallet: stub({}, isWallet),
      networks: stub(
        { info: () => ({ family: "bitcoin" }) },
        (_v): _v is ConstructorParameters<typeof TransactionController>[0]["networks"] => true,
      ),
      openStore: openStore(poisonedStore("transactions", "victim")),
      random: (n) => new Uint8Array(n).fill(1),
      setTimer: () => () => undefined,
      now: () => 0,
      logger: LOGGER,
    });
    await expect(ctl.init()).rejects.toSatisfy(isIntegrityError);
  });

  it("ED-PoC-11b: AddressBookController init rejects on a corrupt 'contacts' record", async () => {
    const ctl = new AddressBookController({
      openStore: openStore(poisonedStore("contacts", "victim")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: LOGGER,
    });
    await expect(ctl.init()).rejects.toSatisfy(isIntegrityError);
  });

  it("ED-PoC-11c: NetworkController init rejects on a corrupt 'networks' customRpc record", async () => {
    const ctl = new NetworkController({
      fetch: async () => Promise.reject(new Error("offline")),
      rpc: {},
      openStore: openStore(poisonedStore("networks", "customRpc")),
      logger: LOGGER,
      setTimer: () => () => undefined,
      random: (n) => new Uint8Array(n).fill(1),
    });
    await expect(ctl.init()).rejects.toSatisfy(isIntegrityError);
  });

  it("ED-PoC-11d: AssetsController init rejects on a corrupt 'assets-custom-tokens' record", async () => {
    const ctl = new AssetsController({
      networks: stub({ info: () => ({ family: "evm" }) }, (_v): _v is NetworkController => true),
      openStore: openStore(poisonedStore("assets-custom-tokens", "customTokens")),
      setTimer: () => () => undefined,
      logger: LOGGER,
    });
    await expect(ctl.init()).rejects.toSatisfy(isIntegrityError);
  });

  it("ED-PoC-11e: WatchController init rejects on a corrupt 'watch' record", async () => {
    const ctl = new WatchController({
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: LOGGER,
      ownAddresses: async () => Promise.resolve([]),
    });
    ctl.setStore(poisonedStore("watch", "victim"));
    await expect(ctl.init()).rejects.toSatisfy(isIntegrityError);
  });

  it("ED-PoC-11f: ConnectionController init rejects on a corrupt 'connections' record", async () => {
    const ctl = new ConnectionController({
      openStore: openStore(poisonedStore("connections", "victim")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: LOGGER,
      allowLocalhost: false,
      selectedGroup: () => undefined,
      evmAddress: async () => Promise.resolve("0x0"),
      solanaAddress: async () => Promise.resolve(""),
      bitcoinAddress: async () => Promise.resolve(""),
      enabledNetworks: () => [],
      nostrPubkey: async () => Promise.resolve(""),
      invalidate: () => undefined,
      phishing: { check: () => "clear" },
      setTimer: () => () => undefined,
    });
    await expect(ctl.init()).rejects.toSatisfy(isIntegrityError);
  });

  it("ED-PoC-11g: a torn spark exit-chain index throws raw SyntaxError, not a guarded error", async () => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    const store = createMemoryEngineStore(backing);
    // A torn write: the index record is malformed JSON — raw JSON.parse in spark/store.ts:19.
    await store.collection("spark-exit-chains:w1:0:regtest").put("__all__", new Uint8Array([0x7b]));
    await expect(
      sparkStore(store.collection("spark-exit-chains:w1:0:regtest")).exitChains(),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});
