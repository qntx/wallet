/**
 * A stored row that is not JSON (a torn write, a format another build wrote) is skipped like any
 * malformed row: the controller still initializes and keeps every readable row.
 */
import { describe, expect, it } from "vite-plus/test";

import { WatchController } from "../src/accounts/watch.ts";
import { AddressBookController } from "../src/addresses/controller.ts";
import { AssetsController } from "../src/assets/controller.ts";
import { ConnectionController } from "../src/connect/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const TORN = new TextEncoder().encode('{"id":"torn');

const seeded = async (collection: string, key: string): Promise<EngineStore> => {
  const store = createMemoryEngineStore();
  await store.collection(collection).put(key, TORN);
  return store;
};

const recorder = () => {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (message: string) => warnings.push(message) } };
};

const random = (n: number) => new Uint8Array(n).fill(7);

describe("controller init over a non-JSON row", () => {
  it("address book", async () => {
    const store = await seeded("contacts", "torn");
    const { warnings, logger } = recorder();
    const book = new AddressBookController({
      openStore: async () => Promise.resolve(store),
      random,
      now: () => 0,
      logger,
    });
    await book.init();
    expect(book.getState().entries).toStrictEqual({});
    expect(warnings).toContain("address book record skipped: malformed");
  });

  it("custom tokens", async () => {
    const store = await seeded("assets-custom-tokens", "customTokens");
    const assets = new AssetsController({
      networks: {} as never,
      openStore: async () => Promise.resolve(store),
      setTimer: () => () => undefined,
      logger: recorder().logger,
    });
    await expect(assets.init()).resolves.toBeUndefined();
  });

  it("dApp connections", async () => {
    const store = await seeded("connections", "torn");
    const { warnings, logger } = recorder();
    const connections = new ConnectionController({
      openStore: async () => Promise.resolve(store),
      random,
      now: () => 0,
      logger,
      allowLocalhost: false,
      selectedGroup: () => undefined,
      evmAddress: async () => Promise.resolve(""),
      solanaAddress: async () => Promise.resolve(""),
      bitcoinAddress: async () => Promise.resolve(""),
      enabledNetworks: () => [],
      nostrPubkey: async () => Promise.resolve(""),
      invalidate: () => undefined,
      phishing: { check: () => ({ blocked: false }) } as never,
      setTimer: () => () => undefined,
    });
    await connections.init();
    expect(connections.getState().sessions).toStrictEqual({});
    expect(warnings).toContain("connection session skipped: malformed");
  });

  it("watch accounts", async () => {
    const store = await seeded("watch", "torn");
    const { warnings, logger } = recorder();
    const watch = new WatchController({
      random,
      now: () => 0,
      logger,
      ownAddresses: async () => Promise.resolve([]),
    });
    watch.setStore(store);
    await watch.init();
    expect(watch.getState().accounts).toStrictEqual({});
    expect(warnings).toContain("dropping a malformed watch account");
  });
});
