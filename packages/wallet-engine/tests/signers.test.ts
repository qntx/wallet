import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { bitcoinNetwork, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";
import { chains } from "@qntx/wallet/chains";
import type { DeviceIo } from "@qntx/wallet/hardware";

import { SignersController } from "../src/signers/controller.ts";
import type { SignerFamily, SignersState } from "../src/signers/controller.ts";
import { nodeWallet, until, VERIFY } from "./apps-helpers.ts";
import { cardRig, CARD_CODE, CARD_VERIFY } from "./card-rig.ts";
import { keystoneIo, pairKeystone } from "./keystone-io.ts";

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

/** The inner card step the activity currently shows, if any. */
const activeCardStep = (signers: SignersController): string | undefined => {
  const step = signers.getState().active?.step;
  return step?.kind === "card" ? step.step.kind : undefined;
};

const H = 0x80_00_00_00;
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";

/**
 * A bip84 spend paying a foreign output and its change to the paired Keystone's /1/0 — the entry a
 * fresh pairing never confirmed on the device.
 */
const unconfirmedPsbt = async (wallet: Wallet, hwId: string) => {
  const account = await chains(wallet).account({
    walletId: hwId,
    groupIndex: 0,
    template: "btc.bip84",
    network: BTC_NETWORK,
  });
  if (!("xpub" in account) || account.xpub === undefined) {
    throw new Error("expected a bitcoin account");
  }
  const fingerprint = Number.parseInt(account.fingerprint, 16);
  const inputPub = bitcoinPubkeyFromXpub(account.xpub, "btc.bip84", BTC_NETWORK, 0, 0);
  const changePub = bitcoinPubkeyFromXpub(account.xpub, "btc.bip84", BTC_NETWORK, 1, 0);
  const inputScript = p2wpkh(inputPub).script;
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({ txid: hexToBytes("10".repeat(32)), index: 0, sequence: 0xff_ff_ff_ff });
  prev.addOutput({ script: inputScript, amount: 100_000n });
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  tx.addInput({
    txid: prev.id,
    index: 0,
    sequence: 0xff_ff_ff_fd,
    witnessUtxo: { script: inputScript, amount: 100_000n },
    nonWitnessUtxo: prev.toBytes(true, false),
    bip32Derivation: [[inputPub, { fingerprint, path: [H + 84, H, H, 0, 0] }]],
  });
  tx.addOutput({
    script: OutScript.encode(
      Address(bitcoinNetwork(BTC_NETWORK).params).decode(
        "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
      ),
    ),
    amount: 90_000n,
  });
  tx.addOutput({ script: p2wpkh(changePub).script, amount: 9000n });
  tx.updateOutput(1, {
    bip32Derivation: [[changePub, { fingerprint, path: [H + 84, H, H, 1, 0] }]],
  });
  return {
    kind: "bitcoin.psbt" as const,
    origin: "internal" as const,
    network: BTC_NETWORK,
    account: { kind: "hd" as const, walletId: hwId, groupIndex: 0 },
    psbt: tx.toPSBT(0),
    sign: [{ index: 0, template: "btc.bip84" as const }],
  };
};

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

  it("forwards the unconfirmed acknowledgement into the hardware sign op", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const base = keystoneIo();
    let exchanges = 0;
    const signers = controller(wallet, {
      deviceIo: {
        exchange: async (request, context) => {
          exchanges += 1;
          return base.exchange(request, context);
        },
      },
    });
    const request = await unconfirmedPsbt(wallet, hwId);
    /* The kernel gate refuses before any prompt or device exchange — a dropped flag would land
       exactly here. */
    await expect(signers.apis.sign({ request, verify: VERIFY })).rejects.toMatchObject({
      code: "approval-required",
    });
    expect(exchanges).toBe(0);
    const result = await signers.apis.sign({
      request,
      verify: VERIFY,
      acknowledgeUnconfirmed: true,
    });
    expect(result.kind).toBe("bitcoin.psbt");
    expect((result as { readonly signedPsbt: unknown }).signedPsbt).toBeInstanceOf(Uint8Array);
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

  it("answers unsupported for a hardware wallet without a transport", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    const noTransport = controller(wallet);
    await expect(
      noTransport.apis.sign({ request: typedData(hwId), verify: VERIFY }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("a second sign refuses conflict while the exchange runs, and the first op completes", async () => {
    const { wallet } = await nodeWallet();
    const hwId = await pairKeystone(wallet);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signers = controller(wallet, { deviceIo: keystoneIo(async () => gate) });
    const first = signers.apis.sign({ request: typedData(hwId), verify: VERIFY });
    // The user's confirmation is on the device — the exchange is in flight.
    await until(() => signers.getState().active?.step.kind === "device");
    await expect(
      signers.apis.sign({ request: typedData(hwId), verify: VERIFY }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Releasing the device finishes the running op untouched — it was never cancelled.
    release();
    await expect(first).resolves.toMatchObject({ kind: "evm.typed-data" });
    expect(signers.getState().active).toBeNull();
  });

  it("a second sign refuses conflict while the card waits for a tap, and the first op completes", async () => {
    const { wallet, cardWalletId, input, reader, member } = await cardRig();
    const signers = controller(wallet);
    // Pre-queue the access code — the op consumes it on the spot and parks at the tap wait.
    input.push(utf8ToBytes(CARD_CODE));
    const first = signers.apis.sign({ request: typedData(cardWalletId), verify: CARD_VERIFY });
    // The member-card prompt is on screen — the card op is in flight.
    await until(() => activeCardStep(signers) === "tap");
    await expect(
      signers.apis.sign({ request: typedData(cardWalletId), verify: CARD_VERIFY }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Present the member card — the running op completes untouched.
    reader.present(member);
    await expect(first).resolves.toMatchObject({ kind: "evm.typed-data" });
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
      deviceIo: keystoneIo(),
      recheck: async (walletId, groupIndex, family) => {
        rechecked.push(`${walletId}:${groupIndex}:${family}`);
        await Promise.resolve();
      },
    });
    const accounts = await signers.fetchAccounts({
      walletId: hwId,
      groupIndex: 0,
      family: "evm",
      verify: VERIFY,
    });
    expect(accounts.length).toBeGreaterThan(0);
    expect(rechecked).toStrictEqual([`${hwId}:0:evm`]);
    expect(signers.getState().active).toBeNull();
  });
});
