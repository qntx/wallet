import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { bitcoinNetwork, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";
import { chains } from "@qntx/wallet/chains";
import { hardware } from "@qntx/wallet/hardware";
import type { DeviceIo, LedgerDescriptorSource } from "@qntx/wallet/hardware";

import {
  hex as bytesHex,
  ok,
  scriptedLedger,
  SEED as LEDGER_SEED,
  unhex,
  utf8Hex,
  vectorCase,
  xpubAt,
} from "../../wallet-kernel/tests/signers-ledger-fake.ts";
import { SignersController } from "../src/signers/controller.ts";
import type { SignerFamily, SignersState } from "../src/signers/controller.ts";
import { freshNodeWallet, nodeWallet, until, VERIFY } from "./apps-helpers.ts";
import { cardRig, CARD_CODE, CARD_VERIFY } from "./card-rig.ts";
import { keystoneIo, pairKeystone } from "./keystone-io.ts";

const stepKind = (state: SignersState): string => state.active?.step.kind ?? "none";

const controller = (
  wallet: Wallet,
  options: {
    readonly deviceIo?: DeviceIo;
    readonly ledgerDescriptors?: LedgerDescriptorSource;
    readonly logger?: { readonly warn: (message: string, error?: unknown) => void };
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
    networks: { enabled: (family) => (family === "evm" ? ["eip155:42161", "eip155:1"] : []) },
    random: (n) => new Uint8Array(n).fill(7),
    logger: options.logger ?? { warn: () => undefined },
    ...(options.ledgerDescriptors === undefined
      ? {}
      : { ledgerDescriptors: options.ledgerDescriptors }),
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

const pairFakeLedger = async (wallet: Wallet): Promise<string> => {
  const word = (index: number): string => (index + H).toString(16).padStart(8, "0");
  const fake = scriptedLedger("bitcoin", [
    { apdu: "e105000100", response: ok("f5acc2fd") },
    ...[44, 49, 84, 86].map((purpose) => ({
      apdu: `e10000010e0003${word(purpose)}${word(0)}${word(0)}`,
      response: ok(utf8Hex(xpubAt([purpose + H, H, H]))),
    })),
  ]);
  const result = await hardware(wallet).start(
    { kind: "pair", device: "ledger" },
    { io: fake.link, verify: VERIFY },
  ).result;
  fake.done();
  if (result.kind !== "pair" || result.wallet.custody !== "hardware") {
    throw new Error("pair did not return a hardware wallet");
  }
  return result.wallet.walletId;
};

const pinFakeLedgerEvm = async (wallet: Wallet, walletId: string): Promise<void> => {
  const [command] = vectorCase("ethereum", "public-node").commands;
  if (command === undefined) {
    throw new Error("ethereum vectors carry no public-node command");
  }
  const fake = scriptedLedger("ethereum", [{ response: command.response }]);
  const result = await hardware(wallet).start(
    {
      kind: "accounts",
      walletId,
      groupIndex: 0,
      templates: ["evm.bip44"],
      network: "eip155:1",
    },
    { io: fake.link, verify: VERIFY },
  ).result;
  fake.done();
  if (result.kind !== "accounts") {
    throw new Error("accounts did not complete");
  }
};

const ledgerAppReply = (name: string, version: string): Uint8Array => {
  const lv = (text: string): string => {
    const data = utf8Hex(text);
    return `${(data.length / 2).toString(16).padStart(2, "0")}${data}`;
  };
  return unhex(ok(`01${lv(name)}${lv(version)}00`));
};

/**
 * A Ledger Ethereum app fake that performs the one SIGN command itself with the speculos seed's
 * key. It is deliberately small: tests assert the token-provision/configuration APDUs around it.
 */
const evmSigningIo = (): { readonly io: DeviceIo; readonly sent: string[] } => {
  const key = HDKey.fromMasterSeed(LEDGER_SEED).derive("m/44'/60'/0'/0/0").privateKey;
  if (key === null) {
    throw new Error("speculos seed has no evm key");
  }
  const sent: string[] = [];
  return {
    sent,
    io: {
      // oxlint-disable-next-line typescript/require-await -- the transport contract is async
      exchange: async (request) => {
        if (request.kind !== "message") {
          throw new Error("ledger io carries only messages");
        }
        const apdu = request.data;
        sent.push(bytesHex(apdu));
        if (bytesHex(apdu) === "b001000000") {
          return { kind: "message", data: ledgerAppReply("Ethereum", "1.24.0") };
        }
        if (apdu[1] === 0x0a) {
          return { kind: "message", data: unhex(ok("00")) };
        }
        if (apdu[1] === 0x06) {
          return { kind: "message", data: unhex(ok("01011800")) };
        }
        if (apdu[1] === 0x04) {
          const payload = apdu.subarray(5);
          const [depth] = payload;
          if (depth === undefined) {
            throw new Error("sign APDU carries no path");
          }
          const unsigned = payload.subarray(1 + depth * 4);
          const signature = secp256k1.sign(keccak_256(unsigned), key, { prehash: false });
          return {
            kind: "message",
            data: Uint8Array.of(0, ...signature, 0x90, 0x00),
          };
        }
        throw new Error(`unscripted Ledger APDU ${bytesHex(apdu)}`);
      },
    },
  };
};

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TRANSFER_DATA = `0xa9059cbb${"0".repeat(24)}00000000000000000000000000000000deadbeef${"0".repeat(63)}1`;

const usdcDescriptor = (): Uint8Array => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../vectors/ledger/cal/tokens.json", import.meta.url)),
      "utf8",
    ),
  );
  if (typeof parsed !== "object" || parsed === null || !("tokens" in parsed)) {
    throw new Error("CAL token vector has no tokens");
  }
  const rows = parsed.tokens as ReadonlyArray<{
    chainId: number;
    address: string;
    descriptor: string;
  }>;
  const row = rows.find((entry) => entry.chainId === 1 && entry.address === USDC);
  if (row === undefined) {
    throw new Error("CAL token vector has no chain-1 USDC row");
  }
  return unhex(row.descriptor);
};

const usdcTransfer = (walletId: string) =>
  ({
    kind: "evm.transaction",
    network: "eip155:1",
    account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
    tx: {
      type: "eip1559",
      chainId: 1,
      nonce: 0,
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      value: "0x0",
      data: TRANSFER_DATA,
      gas: "0x5208",
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x3b9aca00",
      accessList: [],
    },
  }) as const;

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

  it("passes a Ledger descriptor source into deviceSign and clear-signs the bound token", async () => {
    const { wallet } = await freshNodeWallet();
    const walletId = await pairFakeLedger(wallet);
    await pinFakeLedgerEvm(wallet, walletId);
    const signing = evmSigningIo();
    let sourceCalls = 0;
    const signers = controller(wallet, {
      deviceIo: signing.io,
      // oxlint-disable-next-line typescript/require-await -- the source contract is async
      ledgerDescriptors: async () => {
        sourceCalls += 1;
        return { tokens: [usdcDescriptor()] };
      },
    });
    const result = await signers.apis.sign({ request: usdcTransfer(walletId), verify: VERIFY });
    expect(result.kind).toBe("evm.transaction");
    expect(sourceCalls).toBe(1);
    expect(signing.sent.some((apdu) => apdu.startsWith("e00a0000"))).toBe(true);
    expect(signing.sent.some((apdu) => apdu.startsWith("e0060000"))).toBe(false);
  });

  it("still signs a Ledger request when the descriptor source throws", async () => {
    const { wallet } = await freshNodeWallet();
    const walletId = await pairFakeLedger(wallet);
    await pinFakeLedgerEvm(wallet, walletId);
    const signing = evmSigningIo();
    const warnings: string[] = [];
    const signers = controller(wallet, {
      deviceIo: signing.io,
      ledgerDescriptors: async () => Promise.reject(new Error("CAL offline")),
      logger: {
        warn: (message) => {
          warnings.push(message);
        },
      },
    });
    const result = await signers.apis.sign({ request: usdcTransfer(walletId), verify: VERIFY });
    expect(result.kind).toBe("evm.transaction");
    expect(warnings).toStrictEqual(["ledger descriptor fetch failed"]);
    expect(signing.sent.some((apdu) => apdu.startsWith("e00a0000"))).toBe(false);
    expect(signing.sent.some((apdu) => apdu.startsWith("e0060000"))).toBe(true);
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

  it("verifyAddress bumps confirmations only on a completed device verify", async () => {
    const { wallet, walletId } = await nodeWallet();
    const signers = controller(wallet, { deviceIo: keystoneIo() });
    expect(signers.getState().confirmations).toBe(0);

    // A verify that never reaches the device bumps nothing.
    await expect(
      signers.verifyAddress({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:42161",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      signers.verifyAddress({
        walletId: "no-such-wallet",
        groupIndex: 0,
        template: "evm.bip44",
        network: "eip155:42161",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(signers.getState().confirmations).toBe(0);

    const hwId = await pairKeystone(wallet);
    await signers.verifyAddress({
      walletId: hwId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:42161",
    });
    expect(signers.getState().confirmations).toBe(1);
    await signers.verifyAddress({
      walletId: hwId,
      groupIndex: 0,
      template: "solana.bip44-change",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    });
    expect(signers.getState().confirmations).toBe(2);
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
