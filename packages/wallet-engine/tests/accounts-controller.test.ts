import { randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { SparkClient, SparkNetwork } from "@qntx/spark";
import type { Wallet, WalletInfo } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { AccountTreeController } from "../src/accounts/controller.ts";
import { AccountTreeError } from "../src/accounts/errors.ts";
import { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const LOGGER = { warn: () => {} };
const NETWORK: SparkNetwork = "regtest";
const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A store whose first `put` stalls until `release` — proves persists serialize. */
function stallingStore(inner: EngineStore): { store: EngineStore; release: () => void } {
  let release: () => void = () => {};
  let stalled = true;
  const col = inner.collection("accounts");
  const store: EngineStore = {
    collection: () => ({
      get: async (k: string) => col.get(k),
      delete: async (k: string) => col.delete(k),
      list: async () => col.list(),
      put: async (k: string, bytes: Uint8Array) => {
        if (stalled) {
          stalled = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        await col.put(k, bytes);
      },
    }),
    close: async () => inner.close(),
  };
  return { store, release: () => release() };
}

const indicesOf = (groups: ReadonlyArray<{ readonly index: number }> | undefined): number[] => {
  const out: number[] = [];
  for (const g of groups ?? []) {
    out.push(g.index);
  }
  return out;
};

const ref = (walletId: string, groupIndex: number): SparkAccountRef => ({
  walletId,
  groupIndex,
  network: NETWORK,
});

type Rig = {
  readonly wallet: Wallet;
  readonly spark: SparkController;
  readonly accounts: AccountTreeController;
  readonly store: EngineStore;
  readonly setAccountsCalls: ReadonlyArray<ReadonlyArray<SparkAccountRef>>;
  readonly inspects: Record<string, { balanceSats: number; payments: number }>;
};

async function rig(opts: { inspects?: Rig["inspects"] } = {}): Promise<Rig> {
  const wallet = await createNodeWallet({
    passkey: PASSKEY_CONFIG,
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const inspects = opts.inspects ?? {};
  const closed: string[] = [];
  const spark = new SparkController({
    spark: {
      signer: () => null as never,
      approve: async () => Promise.resolve({}),
    },
    fetch: async () => Promise.reject(new Error("no fetch")),
    random: (n) => new Uint8Array(n).fill(1),
    now: () => 0,
    logger: LOGGER,
    createClient: ({ ref: r }) => {
      const k = `${r.walletId}:${r.groupIndex}`;
      const cfg = () => inspects[k] ?? { balanceSats: 0, payments: 0 };
      return {
        balance: async () => Promise.resolve(cfg().balanceSats),
        transfers: {
          history: async () =>
            Promise.resolve({
              payments: Array.from({ length: cfg().payments }, () => ({})),
              nextOffset: undefined,
            }),
        },
        close: () => {
          closed.push(k);
        },
      } as unknown as SparkClient;
    },
  });
  const setAccountsCalls: Array<ReadonlyArray<SparkAccountRef>> = [];
  const orig = spark.setAccounts.bind(spark);
  spark.setAccounts = (refs) => {
    setAccountsCalls.push(refs);
    orig(refs);
  };
  void closed;
  const accounts = new AccountTreeController({
    wallet,
    spark,
    sparkNetwork: NETWORK,
    logger: LOGGER,
    now: () => Date.now(),
  });
  const store = createMemoryEngineStore();
  accounts.setStore(store);
  spark.setStore(store);
  return { wallet, spark, accounts, store, setAccountsCalls, inspects };
}

async function vaultWithMnemonic(wallet: Wallet): Promise<WalletInfo> {
  const draft = await wallet.wallets.createMnemonic({
    words: 12,
    factor: { kind: "password", password: PASSWORD },
  });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  return draft.confirm(draft.quiz.map((p) => words[p]!));
}

describe("AccountTreeController", () => {
  it("auto-creates group 0 for a new wallet and selects it", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    const s = r.accounts.getState();
    expect(s.status).toBe("ready");
    expect(s.groups[created.walletId]).toStrictEqual([
      { walletId: created.walletId, index: 0, hidden: false },
    ]);
    expect(s.selected).toStrictEqual({ walletId: created.walletId, groupIndex: 0 });
    expect(r.setAccountsCalls.at(-1)).toStrictEqual([ref(created.walletId, 0)]);
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("addGroup picks max+1 incl hidden; addGroups skips existing", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    expect(r.accounts.addGroup(created.walletId)).toBe(1);
    expect(r.accounts.addGroup(created.walletId)).toBe(2);
    r.accounts.setHidden(created.walletId, 2, true);
    expect(r.accounts.addGroup(created.walletId)).toBe(3);
    r.accounts.addGroups(created.walletId, [3, 4, 4, 10]);
    const indices = indicesOf(r.accounts.getState().groups[created.walletId]);
    expect(indices).toStrictEqual([0, 1, 2, 3, 4, 10]);
    expect(() => r.accounts.addGroup("nope")).toThrow(AccountTreeError);
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("rename bounds: 0 and 25 rejected, 1 and 24 accepted, whitespace trimmed", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    r.accounts.renameGroup(created.walletId, 0, "  main  ");
    expect(r.accounts.getState().groups[created.walletId]?.[0]?.name).toBe("main");
    r.accounts.renameGroup(created.walletId, 0, "x".repeat(24));
    expect(() => r.accounts.renameGroup(created.walletId, 0, "x".repeat(25))).toThrow(/1-24/);
    expect(() => r.accounts.renameGroup(created.walletId, 0, "   ")).toThrow(/1-24/);
    r.accounts.renameWallet(created.walletId, "daily");
    expect(r.accounts.getState().wallets[0]?.name).toBe("daily");
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("hide selected re-selects the next visible group; cannot hide all", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    r.accounts.addGroup(created.walletId);
    r.accounts.select(created.walletId, 1);
    r.accounts.setHidden(created.walletId, 1, true);
    expect(r.accounts.getState().selected).toStrictEqual({
      walletId: created.walletId,
      groupIndex: 0,
    });
    expect(() => r.accounts.setHidden(created.walletId, 0, true)).toThrow(/cannot hide every/);
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("deleted wallet drops groups/names/totals and re-selects", async () => {
    const r = await rig();
    const first = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    r.accounts.renameWallet(first.walletId, "first");
    const sel = r.accounts.getState().selected;
    expect(sel).not.toBeNull();
    await r.wallet.wallets.delete(first.walletId, VERIFY);
    r.accounts.reconcile();
    const s = r.accounts.getState();
    expect(s.wallets).toHaveLength(0);
    expect(s.groups[first.walletId]).toBeUndefined();
    expect(s.selected).toBeNull();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("persists the tree and restores it on a fresh controller", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    r.accounts.renameGroup(created.walletId, 0, "primary");
    r.accounts.addGroup(created.walletId);
    r.accounts.setHidden(created.walletId, 1, true);
    await sleep(50);
    await r.accounts.destroy();
    const again = new AccountTreeController({
      wallet: r.wallet,
      spark: r.spark,
      sparkNetwork: NETWORK,
      logger: LOGGER,
      now: () => Date.now(),
    });
    again.setStore(r.store);
    await again.init();
    const s = again.getState();
    expect(s.groups[created.walletId]?.[0]?.name).toBe("primary");
    expect(s.groups[created.walletId]?.[1]?.hidden).toBe(true);
    await again.destroy();
    await r.wallet.destroy();
  });

  it("invalid persisted record → empty tree + warn", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    await r.accounts.destroy();
    // Unknown key + duplicated index + negative index + a prototype-key name.
    const bad = new TextEncoder().encode(
      JSON.stringify({
        wallets: {},
        groups: {
          [created.walletId]: [
            { walletId: created.walletId, index: 0, hidden: false },
            { walletId: created.walletId, index: 0, hidden: false },
            { walletId: created.walletId, index: -1, hidden: false },
          ],
        },
        selected: null,
        totals: {},
        bogus: true,
      }),
    );
    await r.store.collection("accounts").put("tree", bad);
    let warned = false;
    const accounts = new AccountTreeController({
      wallet: r.wallet,
      spark: r.spark,
      sparkNetwork: NETWORK,
      logger: {
        warn: () => {
          warned = true;
        },
      },
      now: () => Date.now(),
    });
    accounts.setStore(r.store);
    await accounts.init();
    // Strict decode rejected it; reconcile then built group 0 from the snapshot.
    expect(warned).toBe(true);
    expect(accounts.getState().groups[created.walletId]).toStrictEqual([
      { walletId: created.walletId, index: 0, hidden: false },
    ]);
    await accounts.destroy();
    await r.wallet.destroy();
  });

  it("a prototype-chain key in the persisted record is rejected", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    const store = createMemoryEngineStore();
    const polluted = { wallets: {}, groups: {}, selected: null, totals: {} };
    const bad = new TextEncoder().encode(JSON.stringify(polluted));
    await store.collection("accounts").put("tree", bad);
    // Same shape but with an inherited extra key — JSON can't produce one directly, so this
    // asserts the codec doesn't consult prototype properties during validation.
    const accounts = new AccountTreeController({
      wallet: r.wallet,
      spark: r.spark,
      sparkNetwork: NETWORK,
      logger: { warn: () => {} },
      now: () => Date.now(),
    });
    accounts.setStore(store);
    await accounts.init();
    expect(accounts.getState().selected?.walletId).toBe(created.walletId);
    await accounts.destroy();
    await r.wallet.destroy();
  });

  it("discoverSpark stops after two consecutive unused, includes 0", async () => {
    const r = await rig({
      inspects: {
        "w:0": { balanceSats: 0, payments: 1 },
        "w:2": { balanceSats: 50, payments: 0 },
        "w:3": { balanceSats: 0, payments: 0 },
        "w:4": { balanceSats: 0, payments: 0 },
        "w:5": { balanceSats: 99, payments: 0 },
      },
    });
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    const w = created.walletId;
    const { inspects } = r;
    inspects[`${w}:0`] = { balanceSats: 0, payments: 1 };
    inspects[`${w}:2`] = { balanceSats: 50, payments: 0 };
    inspects[`${w}:3`] = { balanceSats: 0, payments: 0 };
    inspects[`${w}:4`] = { balanceSats: 0, payments: 0 };
    inspects[`${w}:5`] = { balanceSats: 99, payments: 0 };
    const found = await r.accounts.discoverSpark(w);
    expect(found).toStrictEqual([0, 2]);
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("lock during a pending totals persist keeps names, flags and selection", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    const w = created.walletId;
    r.accounts.renameGroup(w, 0, "primary");
    r.accounts.addGroups(w, [1]);
    r.accounts.setHidden(w, 1, true);
    // A totals update starts the 1 s debounce — lock lands inside that window.
    r.inspects[`${w}:2`] = { balanceSats: 777, payments: 0 };
    r.accounts.addGroups(w, [2]);
    await r.accounts.refreshTotals();
    await r.accounts.lock();
    expect(r.accounts.getState().totals).toStrictEqual({});
    const again = new AccountTreeController({
      wallet: r.wallet,
      spark: r.spark,
      sparkNetwork: NETWORK,
      logger: LOGGER,
      now: () => Date.now(),
    });
    again.setStore(r.store);
    await again.init();
    const s = again.getState();
    expect(s.groups[w]?.[0]?.name).toBe("primary");
    expect(s.groups[w]?.[1]?.hidden).toBe(true);
    expect(s.selected?.groupIndex).toBe(0);
    expect(s.totals[`${w}:2`]).toBe(777);
    await again.destroy();
    await r.wallet.destroy();
  });

  it("persists serialize — the final stored tree equals the final state", async () => {
    const wallet = await createNodeWallet({
      passkey: PASSKEY_CONFIG,
      autoLock: { platform: "web", idleMinutes: 15 },
      authenticator: createSoftwarePasskey(randomBytes(32)),
      kernelUrl: KERNEL_URL,
    });
    const spark = new SparkController({
      spark: { signer: () => null as never, approve: async () => Promise.resolve({}) },
      fetch: async () => Promise.reject(new Error("no fetch")),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => 0,
      logger: LOGGER,
      createClient: () => ({ close: () => {} }) as unknown as never,
    });
    // Without serialization the second persist would land first and the stale first write
    // would overwrite it.
    const inner = createMemoryEngineStore();
    const col = inner.collection("accounts");
    const { store, release } = stallingStore(inner);
    const accounts = new AccountTreeController({
      wallet,
      spark,
      sparkNetwork: NETWORK,
      logger: LOGGER,
      now: () => Date.now(),
    });
    accounts.setStore(store);
    const created = await vaultWithMnemonic(wallet);
    await wallet.vault.unlock(VERIFY);
    await accounts.init();
    accounts.renameWallet(created.walletId, "first name"); // stalls inside the chain
    accounts.renameWallet(created.walletId, "final name"); // queued behind it
    release();
    await accounts.lock();
    const raw = await col.get("tree");
    expect(raw).toBeDefined();
    const persisted = JSON.parse(new TextDecoder().decode(raw)) as {
      wallets: Record<string, { name?: string }>;
    };
    expect(persisted.wallets[created.walletId]?.name).toBe("final name");
    await wallet.destroy();
  });

  it("refreshTotals fills other groups' balances from inspect", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.wallet.vault.unlock(VERIFY);
    await r.accounts.init();
    const w = created.walletId;
    r.accounts.addGroups(w, [1, 2]);
    r.inspects[`${w}:1`] = { balanceSats: 111, payments: 0 };
    r.inspects[`${w}:2`] = { balanceSats: 222, payments: 0 };
    await r.accounts.refreshTotals();
    expect(r.accounts.getState().totals[`${w}:1`]).toBe(111);
    expect(r.accounts.getState().totals[`${w}:2`]).toBe(222);
    expect(r.accounts.getState().totals[`${w}:0`]).toBeUndefined();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });
});
