/**
 * One record a writer without the data key tampered with reads exactly like a deleted one: every
 * controller `init` that lists a collection and reads each row must resolve and surface the good
 * records only. These run against the real IndexedDB EngineStore over fake-indexeddb; the poisoned
 * row is corrupted at the raw level so its MAC fails.
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { WatchController } from "../../src/accounts/watch.ts";
import { AddressBookController } from "../../src/addresses/controller.ts";
import type { EngineLogger } from "../../src/events.ts";
import { openIndexedDbEngineStore } from "../../src/idb/indexeddb.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import type { EngineStore } from "../../src/store/port.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { corruptByte, oracleId, rawGet, rawPut } from "./raw.ts";

const DATA_KEY = new Uint8Array(32).fill(7);
const random = (n: number) => new Uint8Array(n).fill(3);
const LOGGER: EngineLogger = { warn: () => {} };
const EVM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function useFakeIdb(): void {
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
}

const open = async (): Promise<EngineStore> =>
  openIndexedDbEngineStore({ name: "t", dataKey: DATA_KEY, random });

/** Seeds `collection` with `records` and corrupts the raw body and index header under `badKey`. */
async function seedWithPoison(
  store: EngineStore,
  collection: string,
  records: ReadonlyArray<readonly [string, Uint8Array]>,
  badKey: string,
): Promise<void> {
  for (const [key, bytes] of records) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- writes are few; ordering keeps it simple
    await store.collection(collection).put(key, bytes);
  }
  const recId = await oracleId(DATA_KEY, collection, badKey);
  const body = await rawGet("records", recId);
  corruptByte(body, 30);
  await rawPut("records", recId, body);
  const header = await rawGet("index", recId);
  corruptByte(header, 30);
  await rawPut("index", recId, header);
}

describe("a poisoned engine-store row", () => {
  it("is skipped by the address book init", async () => {
    useFakeIdb();
    const store = await open();
    const entry = (id: string, name: string) =>
      json({ id, name, family: "evm", address: EVM, createdAt: 1, updatedAt: 1 });
    await seedWithPoison(
      store,
      "contacts",
      [
        ["a", entry("a", "Alice")],
        ["b", entry("b", "Bob")],
        ["c", entry("c", "Carol")],
      ],
      "c",
    );
    const book = new AddressBookController({
      openStore: async () => Promise.resolve(store),
      random,
      now: () => 0,
      logger: LOGGER,
    });
    await book.init();
    expect(new Set(Object.keys(book.getState().entries))).toStrictEqual(new Set(["a", "b"]));
    await store.close();
  });

  it("is skipped by the watch-account init", async () => {
    useFakeIdb();
    const store = await open();
    const record = (id: string) => json({ id, family: "evm", address: EVM, createdAt: 1 });
    await seedWithPoison(
      store,
      "watch",
      [
        ["w1", record("w1")],
        ["w2", record("w2")],
        ["w3", record("w3")],
      ],
      "w3",
    );
    const watch = new WatchController({
      random,
      now: () => 0,
      logger: LOGGER,
      ownAddresses: async () => Promise.resolve([]),
    });
    watch.setStore(store);
    await watch.init();
    expect(new Set(Object.keys(watch.getState().accounts))).toStrictEqual(new Set(["w1", "w2"]));
    await store.close();
  });

  it("is skipped by the networks custom-rpc load", async () => {
    useFakeIdb();
    const store = await open();
    // A second fetch-backed endpoint proves the surviving record still loads; the networks
    // collection holds a single `customRpc` record, so it is the poisoned one here.
    const networks = new NetworkController({
      fetch: async () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })),
      rpc: {},
      openStore: async () => Promise.resolve(store),
      logger: LOGGER,
      setTimer: () => () => {},
      random,
      now: () => Date.now(),
    });
    await store.collection("networks").put("customRpc", json({ "eip155:1": ["http://rpc.good"] }));
    const recId = await oracleId(DATA_KEY, "networks", "customRpc");
    const body = await rawGet("records", recId);
    corruptByte(body, 30);
    await rawPut("records", recId, body);
    const header = await rawGet("index", recId);
    corruptByte(header, 30);
    await rawPut("index", recId, header);
    await networks.init();
    expect(networks.getState().customRpc).toStrictEqual({});
    await store.close();
  });

  it("is skipped by the transactions init", async () => {
    useFakeIdb();
    const store = await open();
    const tx = (id: string) =>
      json({
        id,
        family: "evm",
        network: "eip155:1",
        account: EVM,
        state: "confirmed",
        nonce: 0,
        submittedAt: 1,
      });
    await seedWithPoison(
      store,
      "transactions",
      [
        ["t1", tx("t1")],
        ["t2", tx("t2")],
        ["t3", tx("t3")],
      ],
      "t3",
    );
    const transactions = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        fetch: async () => Promise.reject(new Error("offline")),
        rpc: {},
        openStore: async () => Promise.resolve(store),
        logger: LOGGER,
        setTimer: () => () => {},
        random,
        now: () => Date.now(),
      }),
      openStore: async () => Promise.resolve(store),
      random,
      setTimer: () => () => {},
      now: () => 0,
      logger: LOGGER,
      pollMs: 1,
      chains: {} as never,
    });
    await transactions.init();
    expect(new Set(Object.keys(transactions.getState().txs))).toStrictEqual(new Set(["t1", "t2"]));
    await store.close();
  });
});
