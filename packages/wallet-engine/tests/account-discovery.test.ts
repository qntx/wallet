import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";

import { AccountTreeController } from "../src/accounts/controller.ts";
import type { EngineLogger } from "../src/events.ts";
import type { MetaDocTree } from "../src/meta/doc.ts";
import type { SparkController } from "../src/spark/controller.ts";

const W = "w";
const HD = HDKey.fromMasterSeed(new Uint8Array(64).fill(1)).derive("m/84'/0'/0'");
const LOGGER: EngineLogger = { warn: () => {} };

const walletStub = (custody: "vault" | "hardware" | "card" = "vault"): Wallet =>
  ({
    getSnapshot: () => ({
      wallets: [{ walletId: W, custody }],
      nostr: { keys: [] as unknown[] },
    }),
  }) as unknown as Wallet;

type Rig = {
  ctl: AccountTreeController;
  readonly usedEvm: Set<number>;
  readonly evmNonce: Record<number, number>;
  readonly solSigs: Set<number>;
  readonly btcUsed: Set<number>;
  readonly tronUsed: Set<number>;
  readonly sparkUsed: Set<number>;
  readonly deviceRequired: Set<string>;
  readonly custody: "vault" | "hardware" | "card";
  readonly failOn: Set<string>;
  readonly calls: string[];
  readonly sparkAccounts: ReadonlyArray<ReadonlyArray<unknown>>;
  evmGroup: number;
  solGroup: number;
  btcGroup: number;
  tronGroup: number;
};

const rig = (over: Partial<Rig> = {}): Rig => {
  const r: Rig = {
    ctl: undefined as unknown as AccountTreeController,
    usedEvm: over.usedEvm === undefined ? new Set() : new Set(over.usedEvm),
    evmNonce: { ...over.evmNonce },
    solSigs: over.solSigs === undefined ? new Set() : new Set(over.solSigs),
    btcUsed: over.btcUsed === undefined ? new Set() : new Set(over.btcUsed),
    tronUsed: over.tronUsed === undefined ? new Set() : new Set(over.tronUsed),
    sparkUsed: over.sparkUsed === undefined ? new Set() : new Set(over.sparkUsed),
    deviceRequired: over.deviceRequired === undefined ? new Set() : new Set(over.deviceRequired),
    custody: over.custody ?? "vault",
    failOn: over.failOn === undefined ? new Set() : new Set(over.failOn),
    calls: [],
    sparkAccounts: [],
    evmGroup: -1,
    solGroup: -1,
    btcGroup: -1,
    tronGroup: -1,
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
    setAccounts: (refs: ReadonlyArray<unknown>) => {
      (r.sparkAccounts as unknown[][]).push([...refs]);
    },
    setStore: () => {},
  } as unknown as SparkController;
  const chains = {
    account: async (p: { readonly groupIndex: number; readonly template: string }) => {
      if (r.deviceRequired.has(p.template)) {
        throw new WalletError("device-required", "the device must derive this path");
      }
      if (p.template === "evm.bip44") {
        r.evmGroup = p.groupIndex;
      } else if (p.template === "solana.bip44-change") {
        r.solGroup = p.groupIndex;
      } else if (p.template === "tron.bip44") {
        r.tronGroup = p.groupIndex;
      } else {
        r.btcGroup = p.groupIndex;
      }
      return Promise.resolve({
        address:
          p.template === "evm.bip44"
            ? "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
            : p.template === "tron.bip44"
              ? "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb"
              : "bc1qabc",
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
      if (family === "tron") {
        return ["tron:728126428"];
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
    tronApi: () => ({
      post: async (path: string) => {
        if (path === "/wallet/getaccount") {
          r.calls.push("tron");
          if (r.failOn.has("tron")) {
            throw new Error("tron node down");
          }
          return Promise.resolve(
            r.tronUsed.has(r.tronGroup) ? { address: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb" } : {},
          );
        }
        return Promise.reject(new Error(`unmocked ${path}`));
      },
    }),
  };
  const ctl = new AccountTreeController({
    setTimer: () => () => undefined,
    wallet: walletStub(r.custody),
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
  // These cases derive every family's accounts on a real kernel and are CPU-bound — each
  // carries an explicit timeout so a loaded machine can't push one past the default.
  it(
    "always includes group 0 and stops after two consecutive unused",
    { timeout: 30_000 },
    async () => {
      const r = rig();
      await init(r);
      const found = await r.ctl.discoverGroups(W);
      expect(found).toStrictEqual([0]);
    },
  );

  it("returns every used group across families", { timeout: 30_000 }, async () => {
    const r = rig({ sparkUsed: new Set([1, 3]) });
    await init(r);
    const found = await r.ctl.discoverGroups(W);
    expect(found).toStrictEqual([0, 1, 3]);
  });

  it("checks all four families in parallel per group", { timeout: 30_000 }, async () => {
    const r = rig();
    await init(r);
    await r.ctl.discoverGroups(W);
    for (const fam of ["spark", "evm", "solana", "bitcoin"]) {
      expect(r.calls).toContain(fam);
    }
  });

  it(
    "account-group discovery never derives or records a nostr key",
    { timeout: 30_000 },
    async () => {
      // WD-076: identity indices are independent of account groups — a group scan probes the
      // four chain families only, and the wallet's nostr section stays empty.
      const r = rig();
      await init(r);
      await r.ctl.discoverGroups(W);
      expect([...new Set(r.calls)].toSorted()).toStrictEqual([
        "bitcoin",
        "evm",
        "solana",
        "spark",
        "tron",
      ]);
      expect(r.ctl.getState().groups[W]?.[0]?.used).toStrictEqual({
        bitcoin: false,
        evm: false,
        solana: false,
        spark: false,
        tron: false,
      });
    },
  );

  it("marks the group's used map per family", { timeout: 30_000 }, async () => {
    const r = rig({ sparkUsed: new Set([1]), solSigs: new Set([1]) });
    await init(r);
    await r.ctl.discoverGroups(W);
    const g1 = r.ctl.getState().groups[W]?.find((g) => g.index === 1);
    expect(g1?.used?.["spark"]).toBe(true);
    expect(g1?.used?.["solana"]).toBe(true);
  });

  it(
    "derives and probes the tron.bip44 account — an existing vault needs no state",
    { timeout: 30_000 },
    async () => {
      const r = rig({ tronUsed: new Set([1]) });
      await init(r);
      const found = await r.ctl.discoverGroups(W);
      expect(found).toStrictEqual([0, 1]);
      const g1 = r.ctl.getState().groups[W]?.find((g) => g.index === 1);
      expect(g1?.used?.["tron"]).toBe(true);
      expect(r.tronGroup).toBeGreaterThanOrEqual(1); // tron.bip44 was derived, not read from state
    },
  );

  it(
    "surfaces a failing family on the group instead of marking it unused",
    { timeout: 30_000 },
    async () => {
      const r = rig({ failOn: new Set(["evm"]) });
      await init(r);
      const found = await r.ctl.discoverGroups(W);
      expect(found).toStrictEqual([0]);
      // failOn breaks group 0's EVM probe; only discovered groups are recorded.
      const g0 = r.ctl.getState().groups[W]?.find((g) => g.index === 0);
      expect(g0?.errors?.["evm"]).toBe("rpc down");
      expect(g0?.used?.["evm"]).toBe(false);
    },
  );

  it("evm counts the group used on nonce or balance", { timeout: 30_000 }, async () => {
    const r = rig();
    await init(r);
    r.usedEvm.add(1);
    const found = await r.ctl.discoverGroups(W);
    expect(found).toStrictEqual([0, 1]);
  });
});

describe("discovery and the per-group sync stamp", () => {
  const T0 = 1_000_000;
  const T1 = 2_000_000;
  const T2 = 3_000_000;

  /** A device whose every family probe reports unused — a pure scan with no chain reads. */
  const device = (clock: { t: number }): AccountTreeController =>
    new AccountTreeController({
      setTimer: () => () => undefined,
      wallet: walletStub(),
      spark: {
        store: { subscribe: () => () => {} },
        inspect: async () => Promise.resolve({ balanceSats: 0, used: false }),
        setAccounts: () => {},
        setStore: () => {},
      } as unknown as SparkController,
      sparkNetwork: "regtest",
      chains: { account: async () => Promise.resolve({}) },
      logger: LOGGER,
      now: () => clock.t,
    });

  const group = (ctl: AccountTreeController, index: number) =>
    ctl.getState().groups[W]?.find((g) => g.index === index);

  it("a scan-only pass keeps an existing group's stamp, so a real rename wins the merge", async () => {
    const clock = { t: T0 };
    const a = device(clock);
    const b = device(clock);
    await a.init();
    await b.init();
    // Both devices share wallet w with group 1 named "Old" at T0.
    a.addGroups(W, [1]);
    a.renameGroup(W, 1, "Old");
    b.addGroups(W, [1]);
    b.renameGroup(W, 1, "Old");
    expect(group(a, 1)).toMatchObject({ name: "Old", updatedAt: T0 });
    expect(group(b, 1)).toMatchObject({ name: "Old", updatedAt: T0 });

    // Device A renames the group — the only real user edit in the scenario.
    clock.t = T1;
    a.renameGroup(W, 1, "New");
    expect(group(a, 1)).toMatchObject({ name: "New", updatedAt: T1 });

    // B never pulled A's metadata and scans at T2: the scan only refreshes used/errors, so
    // B's group 1 must keep its T0 stamp — otherwise the next merge reverts A's rename.
    clock.t = T2;
    await b.discoverGroups(W);
    const doc = b.exportMeta(W);
    expect(doc.groups.find((g) => g.index === 1)).toMatchObject({
      name: "Old",
      updatedAt: T0,
    });

    const res = a.mergeMeta(W, doc);
    expect(res.changed).toBe(false);
    expect(res.localNewer).toBe(true);
    expect(group(a, 1)).toMatchObject({ name: "New", updatedAt: T1 });
  });

  it("a group appended by a scan starts at stamp 0, so a remote rename wins the merge", async () => {
    const clock = { t: T0 };
    const b = device(clock);
    await b.init();
    await b.discoverGroups(W);
    // Probed and unused, group 1 is appended — with stamp 0 like a reconcile-created group.
    const appended = group(b, 1);
    expect(appended).toBeDefined();
    expect(appended?.updatedAt).toBe(0);

    const remote: MetaDocTree = {
      wallet: { updatedAt: T1 },
      groups: [
        { index: 0, hidden: false, updatedAt: T0 },
        { index: 1, hidden: false, name: "Renamed", updatedAt: T1 },
      ],
    };
    b.mergeMeta(W, remote);
    expect(group(b, 1)).toMatchObject({ name: "Renamed", updatedAt: T1 });
  });
});

describe("a hardware wallet's account tree", () => {
  it("never inspects spark during discovery and still stops on two unused groups", async () => {
    const r = rig({ custody: "hardware", sparkUsed: new Set([1, 2, 3, 4, 5]) });
    await init(r);
    const found = await r.ctl.discoverGroups(W);
    expect(found).toStrictEqual([0]);
    expect(r.calls).not.toContain("spark");
  });

  it("treats a device-required family as unused, not an error", async () => {
    const r = rig({ custody: "hardware", deviceRequired: new Set(["evm.bip44"]) });
    await init(r);
    await r.ctl.discoverGroups(W);
    const group0 = r.ctl.getState().groups[W]?.find((g) => g.index === 0);
    expect(group0?.used?.["evm"]).toBe(false);
    expect(group0?.errors?.["evm"]).toBeUndefined();
  });

  it("drives no spark account for a selected hardware group", async () => {
    const r = rig({ custody: "hardware" });
    await init(r);
    expect(r.sparkAccounts.length).toBeGreaterThan(0);
    expect(r.sparkAccounts.every((refs) => refs.length === 0)).toBe(true);
  });

  it("refreshes no spark totals for hardware groups", async () => {
    const r = rig({ custody: "hardware" });
    await init(r);
    r.ctl.addGroup(W);
    r.ctl.select(W, 1);
    const before = r.calls.length;
    await r.ctl.refreshTotals();
    expect(r.calls.slice(before)).not.toContain("spark");
    expect(r.calls.slice(before)).toHaveLength(0);
  });
});
