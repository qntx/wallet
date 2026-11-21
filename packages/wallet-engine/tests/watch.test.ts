import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { WatchController } from "../src/accounts/watch.ts";
import { AssetsController } from "../src/assets/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const EVM = "0x1234567890abcdef1234567890abcdef12345678";
const SOL = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const BTC = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const TRON = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";

const stubbedAssets = (): AssetsController => {
  const c = {
    transport: {
      request: async ({ method }: { method: string }) =>
        Promise.resolve(({ eth_getBalance: "0x1234" } as Record<string, string>)[method]),
    },
  } as unknown as PublicClient;
  return new AssetsController({
    ownBitcoinTxids: () => new Set(),
    networks: {
      client: () => c,
      // chainId 56 has no built-in token table entries — tokens stays empty here.
      info: () => ({ family: "evm", chainId: 56 }),
    } as never,
    chains: { account: async () => Promise.reject(new Error("unmocked chains.account")) },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
    gateway: undefined,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  });
};

const world = (own: ReadonlyArray<string> = []) => {
  let call = 0;
  const ownAddresses = async () => Promise.resolve(own);
  return new WatchController({
    random: (n) => {
      const seed = call++;
      return new Uint8Array(n).map((_, i) => (seed * 37 + i * 11) % 256);
    },
    now: () => 0,
    logger,
    ownAddresses,
  });
};

describe("WatchController", () => {
  it("add/rename/remove/list round-trip", async () => {
    const w = world();
    w.setStore(createMemoryEngineStore());
    await w.init();
    const a = await w.add({ family: "evm", address: EVM, name: "treasury" });
    expect(a.family).toBe("evm");
    expect(a.address).toBe(EVM);
    await w.rename(a.id, "main");
    expect(w.getState().accounts[a.id]?.name).toBe("main");
    const b = await w.add({ family: "solana", address: SOL });
    const c = await w.add({ family: "bitcoin", address: BTC });
    const d = await w.add({ family: "tron", address: TRON });
    expect(d.address).toBe(TRON); // base58 stored verbatim — no case folding
    expect(w.list()).toHaveLength(4);
    await w.remove(b.id);
    await w.remove(c.id);
    await w.remove(d.id);
    expect(w.list()).toHaveLength(1);
  });

  it.each([
    ["evm", "not-an-address"],
    ["solana", `0x${"ab".repeat(20)}`],
    ["bitcoin", "not-bitcoin"],
    ["tron", "not-tron"],
    ["tron", `0x${"ab".repeat(20)}`],
    // a case-folded tron address fails base58check — it is malformed, not normalised
    ["tron", "twd4wrz9wn84f5x1hzhl4dhvk738ns5jwb"],
  ] as const)("rejects a malformed %s address", async (family, address) => {
    const w = world();
    await expect(w.add({ family, address })).rejects.toThrow(`not a valid ${family} address`);
  });

  it("refuses a duplicate (normalised)", async () => {
    const w = world();
    await w.add({ family: "evm", address: EVM });
    await expect(w.add({ family: "evm", address: EVM })).rejects.toThrow("already watched");
  });

  it("refuses an address the wallet owns", async () => {
    const w = world([EVM]);
    await expect(w.add({ family: "evm", address: EVM })).rejects.toThrow("one of the wallet's own");
  });

  it("reads a watched EVM address through the same per-address path", async () => {
    /* `assets.refresh(address, network)` is the one read path HD accounts' derived
       addresses and watch accounts' stored addresses share — no derivation happens. */
    const assets = stubbedAssets();
    const w = world();
    const a = await w.add({ family: "evm", address: EVM });
    const balances = await assets.refresh(a.address, "eip155:1");
    /* `watch.assets` returns this value directly — it is exactly what refresh wrote. */
    expect(balances).toStrictEqual({ native: "4660", tokens: [] });
    expect(assets.getState().balances[`eip155:1:${a.address}`]).toStrictEqual(balances);
  });

  it("a removed watch account can be re-added after its balance was tracked", async () => {
    /* "Own" is derived addresses only — the balances state may still hold a removed
       account's address, and counting it as own would block re-adding it. */
    const assets = stubbedAssets();
    const w = world();
    const a = await w.add({ family: "evm", address: EVM });
    await assets.refresh(a.address, "eip155:1");
    await w.remove(a.id);
    const again = await w.add({ family: "evm", address: EVM });
    expect(again.address).toBe(EVM);
  });

  it("a watch account can never reach a dApp session", async () => {
    /* Connect sessions are built only from the tree's `selected`/`groups`, which carry
       `{walletId, groupIndex}` refs — a WatchAccount has neither field, so the connect
       controller has no way to expose one. The state separation is the guarantee: a watch
       entry cannot be selected because it is never a group member. */
    const w = world();
    const a = await w.add({ family: "evm", address: EVM });
    expect(a).not.toHaveProperty("walletId");
    expect(a).not.toHaveProperty("groupIndex");
  });

  it("persistence round-trip + malformed records drop", async () => {
    const store = createMemoryEngineStore();
    const col = store.collection("watch");
    await col.put(
      "watch/ok",
      new TextEncoder().encode(
        JSON.stringify({ id: "a", family: "evm", address: EVM, createdAt: 0 }),
      ),
    );
    await col.put(
      "watch/bad",
      new TextEncoder().encode(JSON.stringify({ id: "b", family: "nope" })),
    );
    const w = world();
    w.setStore(store);
    await w.init();
    expect(w.list()).toHaveLength(1);
    expect(w.list()[0]?.id).toBe("a");
  });
});
