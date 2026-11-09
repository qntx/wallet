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

const stubbedAssets = (): AssetsController => {
  const c = {
    transport: {
      request: async ({ method }: { method: string }) =>
        Promise.resolve(({ eth_getBalance: "0x1234" } as Record<string, string>)[method]),
    },
  } as unknown as PublicClient;
  return new AssetsController({
    networks: {
      client: () => c,
      info: () => ({ family: "evm", chainId: 1 }),
    } as never,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger,
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
    expect(w.list()).toHaveLength(3);
    await w.remove(b.id);
    await w.remove(c.id);
    expect(w.list()).toHaveLength(1);
  });

  it.each([
    ["evm", "not-an-address"],
    ["solana", `0x${"ab".repeat(20)}`],
    ["bitcoin", "not-bitcoin"],
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
    await assets.refresh(a.address, "eip155:1");
    expect(assets.getState().balances[`eip155:1:${a.address}`]?.native).toBe("4660");
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
