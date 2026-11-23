import { describe, expect, it } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import type { Wallet, WalletInfo, WalletSnapshot } from "@qntx/wallet";

import { AccountTreeController } from "../src/accounts/controller.ts";
import type { AccountTreeControllerOptions } from "../src/accounts/controller.ts";
import { AccountTreeError } from "../src/accounts/errors.ts";
import type { SparkController } from "../src/spark/controller.ts";

const LOGGER = { warn: () => {} };
const cardWallet = (state: "ready" | "pending"): WalletInfo => ({
  custody: "card",
  walletId: `w-card-${state}`,
  origin: "card-generated",
  backup: "cards",
  createdAt: 1,
  members: 1,
  cards: [{ cardId: "aa".repeat(16), state }],
});

const HARDWARE: WalletInfo = {
  custody: "hardware",
  walletId: "w-hw",
  device: "keystone",
  supported: true,
  fingerprint: "73c5da0a",
  createdAt: 1,
};

const scriptedWallet = (wallets: ReadonlyArray<WalletInfo>): Wallet =>
  ({
    getSnapshot: () =>
      ({
        vault: "unlocked",
        wallets,
        keys: [],
        blindSigning: "disabled",
        verification: "none",
        lockedAt: 0,
      }) as unknown as WalletSnapshot,
    subscribe: () => () => {},
  }) as unknown as Wallet;

const sparkStub = {
  getState: () => ({ accounts: {} }),
  store: { subscribe: () => () => {} },
  setAccounts: () => {},
} as unknown as SparkController;

/** Chain access gated behind a flag — the test flips `fail` once the signer fetched material. */
const gatedChains = (gate: { fail: boolean }): AccountTreeControllerOptions["chains"] => ({
  account: async () =>
    gate.fail
      ? Promise.reject(new WalletError("device-required", "material lives on the device"))
      : Promise.resolve({ address: "0x1111111111111111111111111111111111111111" }),
});

const tree = (
  wallet: Wallet,
  chains?: AccountTreeControllerOptions["chains"],
): AccountTreeController =>
  new AccountTreeController({
    setTimer: () => () => undefined,
    wallet,
    spark: sparkStub,
    sparkNetwork: "regtest",
    chains: chains ?? {
      account: async () =>
        Promise.reject(new WalletError("device-required", "material lives on the device")),
    },
    networks: {
      enabled: (family: string) =>
        family === "bitcoin" ? ["bip122:000000000019d6689c085ae165831e93"] : ["eip155:1"],
      esplora: () => ({}),
    } as never,
    logger: LOGGER,
    now: () => 1,
  });

describe("the account tree across custodies", () => {
  it("a card wallet with a pending member is incomplete: no groups, discovery and add refuse", async () => {
    const accounts = tree(scriptedWallet([cardWallet("pending")]));
    await accounts.init();
    expect(accounts.getState().wallets[0]?.state).toBe("incomplete");
    expect(accounts.getState().wallets[0]?.custody).toBe("card");
    expect(accounts.getState().groups["w-card-pending"]).toStrictEqual([]);
    await expect(accounts.discoverGroups("w-card-pending")).rejects.toMatchObject({
      category: "rejected",
    });
    expect(() => accounts.addGroup("w-card-pending")).toThrow(AccountTreeError);
    await accounts.destroy();
  });

  it("a card wallet whose members are all ready gets group 0 like any wallet", async () => {
    const accounts = tree(scriptedWallet([cardWallet("ready")]));
    await accounts.init();
    expect(accounts.getState().wallets[0]?.state).toBe("ready");
    expect(accounts.getState().groups["w-card-ready"]?.map((g) => g.index)).toStrictEqual([0]);
    await accounts.destroy();
  });

  it("device-required families record signer and discovery stops at group 0", async () => {
    const accounts = tree(scriptedWallet([HARDWARE]));
    await accounts.init();
    const found = await accounts.discoverGroups("w-hw");
    expect(found).toStrictEqual([0]);
    const group = accounts.getState().groups["w-hw"]?.[0];
    expect(group?.signer).toStrictEqual({
      evm: "device-required",
      solana: "device-required",
      bitcoin: "device-required",
      tron: "device-required",
    });
    expect(group?.used?.["spark"]).toBe(false);
    await accounts.destroy();
  });

  it("recheckFamily clears the signer mark once the family answers", async () => {
    const gate = { fail: true };
    const accounts = tree(scriptedWallet([HARDWARE]), gatedChains(gate));
    await accounts.init();
    await accounts.discoverGroups("w-hw");
    expect(accounts.getState().groups["w-hw"]?.[0]?.signer?.["evm"]).toBe("device-required");
    gate.fail = false;
    await accounts.recheckFamily("w-hw", 0, "evm");
    const group = accounts.getState().groups["w-hw"]?.[0];
    expect(group?.signer?.["evm"]).toBeUndefined();
    expect(group?.signer?.["solana"]).toBe("device-required");
    expect(group?.used?.["evm"]).toBe(false);
    await accounts.destroy();
  });

  it("a group where every non-spark family waits on the signer stops discovery", async () => {
    const accounts = tree(scriptedWallet([HARDWARE]));
    await accounts.init();
    // The all-signer stop means index 1 is never even checked — discovery returns after group 0.
    const found = await accounts.discoverGroups("w-hw");
    expect(found).toStrictEqual([0]);
    await accounts.destroy();
  });

  it("an unsupported device kind keeps custody hardware with its flag", async () => {
    const trezor: WalletInfo = { ...HARDWARE, device: "trezor", supported: false };
    const accounts = tree(scriptedWallet([trezor]));
    await accounts.init();
    const [entry] = accounts.getState().wallets;
    expect(entry?.custody).toBe("hardware");
    expect(entry?.state).toBe("ready");
    await accounts.destroy();
  });
});
