import { readFileSync } from "node:fs";

import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import type { DeviceIo } from "@qntx/wallet/hardware";
import { hardware } from "@qntx/wallet/hardware";

import { SignersController } from "../src/signers/controller.ts";
import type { SignerFamily, SignersState } from "../src/signers/controller.ts";
import { nodeWallet, VERIFY } from "./apps-helpers.ts";
import { keystoneIo } from "./keystone-io.ts";

const SYNC = hexToBytes(
  (
    JSON.parse(
      readFileSync(new URL("../../../vectors/keystone/sync.json", import.meta.url), "utf8"),
    ) as { sync: { cbor: string } }
  ).sync.cbor,
);

const stepKind = (state: SignersState): string => state.active?.step.kind ?? "none";

const controller = (
  wallet: Wallet,
  options: {
    readonly deviceIo?: DeviceIo;
    readonly recheck?: (
      walletId: string,
      groupIndex: number,
      family: SignerFamily,
    ) => Promise<void>;
  } = {},
): SignersController => {
  const io = options.deviceIo;
  return new SignersController({
    wallet,
    ...(io === undefined ? {} : { deviceIo: () => io }),
    recheck: options.recheck ?? (async () => Promise.resolve()),
    networks: { enabled: (family) => (family === "evm" ? ["eip155:42161"] : []) },
    random: (n) => new Uint8Array(n).fill(7),
    logger: { warn: () => undefined },
  });
};

const pairKeystone = async (wallet: Wallet): Promise<string> => {
  const existing = wallet.getSnapshot().wallets.find((w) => w.custody === "hardware");
  if (existing !== undefined) {
    return existing.walletId;
  }
  const result = await hardware(wallet).start(
    { kind: "pair", device: "keystone" },
    {
      io: {
        exchange: async () =>
          Promise.resolve({
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: SYNC },
          }),
      },
    },
  ).result;
  if (result.kind !== "pair") {
    throw new Error("pair did not return a wallet");
  }
  return result.wallet.walletId;
};

const typedData = (hwId: string) => ({
  kind: "evm.typed-data" as const,
  network: "eip155:42161",
  account: { kind: "hd" as const, walletId: hwId, groupIndex: 0, template: "evm.bip44" as const },
  typedData: JSON.stringify({
    types: { EIP712Domain: [], Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    domain: {},
    message: { contents: "hello" },
  }),
});

describe("the signers controller", () => {
  it("routes a hardware wallet's signature through deviceIo and publishes exchange steps", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const signers = controller(wallet, { deviceIo: keystoneIo() });
    const steps: string[] = [];
    const off = signers.store.subscribe((state) => {
      steps.push(stepKind(state));
    });
    const result = await signers.apis.sign({
      request: typedData(hwId),
      verify: VERIFY,
    });
    off();
    expect(result.kind).toBe("evm.typed-data");
    expect(steps).toContain("starting");
    expect(steps).toContain("device");
    expect(signers.getState().active).toBeNull();
  });

  it("signs vault requests through chains() without an activity", async () => {
    const { wallet, walletId } = await nodeWallet();
    const signers = controller(wallet);
    const result = await signers.apis.sign({
      request: {
        kind: "evm.typed-data",
        network: "eip155:42161",
        account: {
          kind: "hd",
          walletId,
          groupIndex: 0,
          template: "evm.bip44",
        },
        typedData: JSON.stringify({
          types: { EIP712Domain: [], Mail: [{ name: "contents", type: "string" }] },
          primaryType: "Mail",
          domain: {},
          message: { contents: "hello" },
        }),
      },
      verify: VERIFY,
    });
    expect(result.kind).toBe("evm.typed-data");
    expect(signers.getState().active).toBeNull();
  });

  it("answers unsupported for a hardware wallet without a transport, and conflict on a second op", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const noTransport = controller(wallet);
    await expect(
      noTransport.apis.sign({ request: typedData(hwId), verify: VERIFY }),
    ).rejects.toMatchObject({ code: "unsupported" });
    let release: () => void = () => undefined;
    const gate = new Promise<never>((_resolve, reject) => {
      release = () => reject(new WalletError("cancelled", "released"));
    });
    // The exchange's rejection reaches the facade's result promise; the raw gate itself is
    // swallowed so vitest does not flag an unhandled rejection.
    void gate.catch(() => undefined);
    const signers = controller(wallet, { deviceIo: keystoneIo(async () => gate) });
    const first = signers.apis.sign({ request: typedData(hwId), verify: VERIFY });
    await Promise.resolve();
    await expect(
      signers.apis.sign({ request: typedData(hwId), verify: VERIFY }),
    ).rejects.toMatchObject({ code: "conflict" });
    release();
    await expect(first).rejects.toBeInstanceOf(WalletError);
    expect(signers.getState().active).toBeNull();
  });

  it("cancel() rejects the running result with cancelled and clears the activity", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const gate = new Promise<never>(() => {});
    const signers = controller(wallet, { deviceIo: keystoneIo(async () => gate) });
    const first = signers.apis.sign({ request: typedData(hwId), verify: VERIFY });
    await Promise.resolve();
    expect(signers.getState().active).not.toBeNull();
    await signers.cancel();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(signers.getState().active).toBeNull();
    await expect(signers.cancel()).resolves.toBeUndefined();
  });

  it("verifyAddress runs the device compare; card and vault refuse unsupported", async () => {
    const { wallet, walletId } = await nodeWallet();
    const signers = controller(wallet, { deviceIo: keystoneIo() });
    await expect(
      signers.verifyAddress({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:42161",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    const hwId = await pairKeystone(wallet);
    const verified = await signers.verifyAddress({
      walletId: hwId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:42161",
    });
    expect(verified.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signers.getState().active).toBeNull();
    await expect(
      signers.verifyAddress({
        walletId: "no-such-wallet",
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:42161",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("fetchAccounts drives one accounts op and re-checks the family", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const rechecked: string[] = [];
    const signers = controller(wallet, {
      deviceIo: {
        exchange: async () =>
          Promise.resolve({
            kind: "qr",
            ur: { type: "crypto-multi-accounts", cbor: SYNC },
          }),
      },
      recheck: async (walletId, groupIndex, family) => {
        rechecked.push(`${walletId}:${groupIndex}:${family}`);
        await Promise.resolve();
      },
    });
    const accounts = await signers.fetchAccounts({ walletId: hwId, groupIndex: 0, family: "evm" });
    expect(accounts.length).toBeGreaterThan(0);
    expect(rechecked).toStrictEqual([`${hwId}:0:evm`]);
    expect(signers.getState().active).toBeNull();
  });
});
