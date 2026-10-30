import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { AccountTreeController } from "../src/accounts/controller.ts";
import type { EngineLogger } from "../src/events.ts";
import type { SparkController } from "../src/spark/controller.ts";

const W = "w";
const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/84'/0'/0'");
const LOGGER: EngineLogger = { warn: () => {} };

const walletStub = (): Wallet =>
  ({ getSnapshot: () => ({ wallets: [{ walletId: W }] }) }) as unknown as Wallet;

type Rig = {
  ctl: AccountTreeController;
  readonly usedEvm: Set<number>;
  readonly evmNonce: Record<number, number>;
  readonly solSigs: Set<number>;
  readonly btcUsed: Set<number>;
  readonly sparkUsed: Set<number>;
  readonly failOn: Set<string>;
  readonly calls: string[];
  evmGroup: number;
  solGroup: number;
  btcGroup: number;
};

const rig = (over: Partial<Rig> = {}): Rig => {
  const r: Rig = {
    ctl: undefined as unknown as AccountTreeController,
    usedEvm: over.usedEvm === undefined ? new Set() : new Set(over.usedEvm),
    evmNonce: { ...over.evmNonce },
    solSigs: over.solSigs === undefined ? new Set() : new Set(over.solSigs),
    btcUsed: over.btcUsed === undefined ? new Set() : new Set(over.btcUsed),
    sparkUsed: over.sparkUsed === undefined ? new Set() : new Set(over.sparkUsed),
    failOn: over.failOn === undefined ? new Set() : new Set(over.failOn),
    calls: [],
    evmGroup: -1,
    solGroup: -1,
    btcGroup: -1,
  };
  const spark = {
    store: { subscribe: () => () => {} },
    inspect: async (ref: { readonly groupIndex: number }) => {
      if (r.failOn.has("spark")) {
        throw new Error("spark inspect failed");
      }
      r.calls.push("spark");
      return Promise.resolve({ balanceSats: 0, used: r.sparkUsed.has(ref.groupIndex) });
    },
    setAccounts: () => {},
    setStore: () => {},
  } as unknown as SparkController;
  const chains = {
    account: async (p: { readonly groupIndex: number; readonly template: string }) => {
      if (p.template === "evm.bip44") {
        r.evmGroup = p.groupIndex;
      } else if (p.template === "solana.bip44-change") {
        r.solGroup = p.groupIndex;
      } else {
        r.btcGroup = p.groupIndex;
      }
      return Promise.resolve({
        address:
          p.template === "evm.bip44" ? "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" : "bc1qabc",
        xpub: HD.publicExtendedKey,
      });
    },
  };
  const networks = {
    enabled: (family: string): ReadonlyArray<string> => {
      if (family === "evm") {
        return ["eip155:1"];
      }
      if (family === "solana") {
        return ["solana:x"];
      }
      if (family === "bitcoin") {
        return ["bip122:000000000019d6689c085ae165831e93"];
      }
      return [];
    },
    client: () => ({
      getTransactionCount: async () => Promise.resolve(0),
      getBalance: async () => {
        r.calls.push("evm");
        if (r.failOn.has("evm") && r.evmGroup === 0) {
          throw new Error("rpc down");
        }
        return Promise.resolve(r.usedEvm.has(r.evmGroup) ? 1n : 0n);
      },
    }),
    solanaRpc: () => ({
      call: async () => {
        r.calls.push("solana");
        return Promise.resolve(r.solSigs.has(r.solGroup) ? [{ signature: "s" }] : []);
      },
    }),
    esplora: () => ({
      get: async (_u: string) => {
        r.calls.push("bitcoin");
        if (r.failOn.has("bitcoin")) {
          throw new Error("esplora down");
        }
        return Promise.resolve(r.btcUsed.has(r.btcGroup) ? [{ txid: "aa" }] : []);
      },
      post: async () => Promise.resolve(""),
    }),
  };
  const ctl = new AccountTreeController({
    wallet: walletStub(),
    spark,
    sparkNetwork: "regtest",
    chains,
    networks,
    logger: LOGGER,
    now: () => 0,
  });
  r.ctl = ctl;
  return r;
};

const init = async (r: Rig): Promise<void> => {
  await r.ctl.init();
};

describe("account discovery", () => {
  it("always includes group 0 and stops after two consecutive unused", async () => {
    const r = rig();
    await init(r);
    const found = await r.ctl.discoverGroups(W);
    expect(found).toStrictEqual([0]);
  });

  it("returns every used group across families", async () => {
    const r = rig({ sparkUsed: new Set([1, 3]) });
    await init(r);
    const found = await r.ctl.discoverGroups(W);
    expect(found).toStrictEqual([0, 1, 3]);
  });

  it("checks all four families in parallel per group", async () => {
    const r = rig();
    await init(r);
    await r.ctl.discoverGroups(W);
    for (const fam of ["spark", "evm", "solana", "bitcoin"]) {
      expect(r.calls).toContain(fam);
    }
  });

  it("marks the group's used map per family", async () => {
    const r = rig({ sparkUsed: new Set([1]), solSigs: new Set([1]) });
    await init(r);
    await r.ctl.discoverGroups(W);
    const g1 = r.ctl.getState().groups[W]?.find((g) => g.index === 1);
    expect(g1?.used?.["spark"]).toBe(true);
    expect(g1?.used?.["solana"]).toBe(true);
  });

  it(
    "surfaces a failing family on the group instead of marking it unused",
    { timeout: 15_000 },
    async () => {
      const r = rig({ failOn: new Set(["evm"]) });
      await init(r);
      const found = await r.ctl.discoverGroups(W);
      expect(found).toStrictEqual([0]);
      const g1 = r.ctl.getState().groups[W]?.find((g) => g.index === 1);
      expect(g1?.errors?.["evm"]).toBe("rpc down");
      expect(g1?.used?.["evm"]).toBe(false);
    },
  );

  it("evm counts the group used on nonce or balance", async () => {
    const r = rig();
    await init(r);
    r.usedEvm.add(1);
    const found = await r.ctl.discoverGroups(W);
    expect(found).toStrictEqual([0, 1]);
  });
});
