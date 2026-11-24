// oxlint-disable vitest/no-conditional-in-test -- the step driver and sign oracles are conditional by design
/**
 * End to end through the shipped host packages: `connectKernel` (@qntx/wallet/host) over the
 * in-process kernel's `hostPort`, `card(wallet)` (@qntx/wallet/card) driving a real card operation
 * — the observer answers `input` steps through the test secure input and `tap` steps by presenting
 * a simulator card — and a `sign` result the facade re-verifies like `chains.sign`. Runs only with
 * `QNTX_CARD_SIM`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { address, getAddressEncoder } from "@solana/kit";
import { recoverTransactionAddress } from "viem";
import type { TransactionSerialized } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey, recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey, tronMessageDigest } from "@qntx/wallet-chains/tron";
import { card } from "@qntx/wallet/card";
import { chains } from "@qntx/wallet/chains";
import type { ChainSignRequest, ChainSignResult } from "@qntx/wallet/chains";
import { connectKernel } from "@qntx/wallet/host";
import type { MainPort } from "@qntx/wallet/host";
import type { CardStep } from "@qntx/wallet/protocol";
import type { Wallet } from "@qntx/wallet/types";

import { accessHash } from "../src/modules/card/protocol/access.ts";
import { cardId, shortId } from "../src/modules/card/protocol/identity.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { testSecureInput } from "./card/input.ts";
import type { TestSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import type { TestCardReader } from "./card/reader.ts";
import { CA1_ANCHOR, SIM_LAUNCHER, startSimulator } from "./card/sim.ts";
import type { SimCard, Simulator } from "./card/sim.ts";
import { createHarness } from "./harness.ts";
import { quickArgon2id, subtlePbkdf2 } from "./helpers.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "the vault password";
const CODE_TEXT = "facade card code";

/** The kernel owns every reply buffer it is handed — a fresh copy per push, like a real field. */
const freshCode = (): Uint8Array => utf8ToBytes(CODE_TEXT);

const PASSKEY = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};

let simulator: Simulator;

/** Recursive scan for a needle's raw bytes, hex, base64 or printable text inside any value. */
const containsSecret = (value: unknown, needles: ReadonlyArray<Uint8Array>): boolean => {
  const forms = (n: Uint8Array): string[] => {
    let binary = "";
    for (const b of n) {
      binary += String.fromCodePoint(b);
    }
    return [bytesToHex(n), btoa(binary), new TextDecoder("utf-8", { fatal: false }).decode(n)];
  };
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v instanceof Uint8Array) {
      for (const n of needles) {
        if (n.length <= v.length && bytesToHex(v).includes(bytesToHex(n))) {
          return true;
        }
      }
    } else if (typeof v === "string") {
      for (const n of needles) {
        if (forms(n).some((f) => f.length > 3 && v.includes(f))) {
          return true;
        }
      }
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (typeof v === "object" && v !== null) {
      stack.push(...Object.values(v));
    }
  }
  return false;
};

const HARDENED = 0x80000000;
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const TRON_NETWORK = "tron:728126428";
const SOL_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** The vector requests' embedded signers — the card wallet's key replaces them. */
const ANVIL_TRON = hexToBytes("41f39fd6e51aad88f6f4ce6ab8827279cfffb92266");

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as {
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly request: Record<string, unknown> & { readonly kind: string };
  }>;
};
const vectorCase = (name: string): Record<string, unknown> => {
  const found = vectors.cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`no vector case ${name}`);
  }
  return found.request;
};

/** The secp256k1 key behind a tron signature — recovered over the request's digest. */
const recoverTronKey = (signature: Uint8Array, digest: Uint8Array) => {
  const v = signature[64] ?? 0;
  return new secp256k1.Signature(
    bytesToNumberBE(signature.subarray(0, 32)),
    bytesToNumberBE(signature.subarray(32, 64)),
    v >= 27 ? v - 27 : v,
  ).recoverPublicKey(digest);
};

describe.skipIf(SIM_LAUNCHER === undefined)("card(wallet) facade end to end", () => {
  beforeAll(async () => {
    simulator = await startSimulator();
  });

  afterAll(async () => {
    await simulator.close();
  });

  const rig = async (): Promise<{
    wallet: Wallet;
    reader: TestCardReader;
    input: TestSecureInput;
    sourceId: string;
    crossed: unknown[];
    draws: Uint8Array[];
  }> => {
    const reader = testCardReader();
    const input = testSecureInput();
    const h = createHarness({
      card: { reader: reader.reader, anchors: [CA1_ANCHOR] },
      secureInput: input.secureInput,
    });
    // Every frame crossing hostPort in either direction — the leak scan asserts none
    // carries access-code bytes, per-card access hashes, drawn entropy or seed material.
    const crossed: unknown[] = [];
    const port: MainPort = {
      post: (message, transfer) => {
        crossed.push(message);
        h.hostPort.post(message, transfer);
      },
      listen: (l) =>
        h.hostPort.listen((message) => {
          crossed.push(message);
          l(message);
        }),
      onExit: (handler) => h.hostPort.onExit(handler),
      terminate: () => h.hostPort.terminate(),
    };
    const wallet = await connectKernel({
      verifyEvent,
      spawn: () => port,
      factors: "software",
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    const imported = await wallet.wallets.importMnemonic({
      mnemonic: MNEMONIC,
      factor: { kind: "password", password: PASSWORD },
    });
    return { wallet, reader, input, sourceId: imported.walletId, crossed, draws: h.draws };
  };

  /**
   * A step observer the host UI plays: `input` answers through the queued replies, `tap` presents
   * the queued card. emit() is synchronous, so every reply is in place before `card.step` runs.
   */
  const drive = (
    task: ReturnType<ReturnType<typeof card>["start"]>,
    input: TestSecureInput,
    reader: TestCardReader,
    actions: { codes: Uint8Array[]; choices?: SimCard[]; deck?: SimCard[] },
  ): CardStep[] => {
    const seen: CardStep[] = [];
    const deck = actions.deck ?? actions.choices ?? [];
    const byShort = (sid: string): SimCard | undefined =>
      deck.find((c) => shortId(c.identity) === sid);
    let pendingChoice: SimCard | undefined;
    task.observe((step) => {
      seen.push(step);
      if (step.kind === "input") {
        if (step.purpose === "short-id") {
          // The card about to be tapped: the deck resolves a bound ask, `choices` an unbound one.
          const chosen = step.card === undefined ? actions.choices?.shift() : byShort(step.card);
          pendingChoice = chosen;
          input.push(utf8ToBytes(chosen === undefined ? "0000-0000" : shortId(chosen.identity)));
        } else {
          const code = actions.codes.shift();
          if (code === undefined) {
            throw new Error(`unexpected input step ${JSON.stringify(step)}`);
          }
          input.push(code);
        }
      } else if (step.kind === "tap") {
        const next =
          (step.card === undefined ? undefined : byShort(step.card)) ??
          pendingChoice ??
          actions.choices?.shift();
        if (next === undefined) {
          throw new Error(`unexpected tap step ${JSON.stringify(step)}`);
        }
        reader.present(next);
      }
    });
    return seen;
  };

  it("runs create, status and sign through the facade on the real applet", async () => {
    const { wallet, reader, input, sourceId } = await rig();
    const sim = await simulator.newCard();
    const api = card(wallet);

    const created = api.start(
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: sourceId } },
      { verify: { kind: "password", password: PASSWORD } },
    );
    const createSteps = drive(created, input, reader, {
      codes: [freshCode(), freshCode()],
      choices: Array.from({ length: 10 }, () => sim),
    });
    await expect(created.result).resolves.toMatchObject({ kind: "create" });
    expect(createSteps.map((step) => step.kind)).toStrictEqual([
      "input",
      "input",
      "input",
      "tap",
      "tap",
      "done",
    ]);
    const { walletId } = (await created.result) as { kind: "create"; walletId: string };

    const status = api.start({ kind: "status" });
    drive(status, input, reader, { codes: [], choices: [sim] });
    await expect(status.result).resolves.toStrictEqual({
      kind: "status",
      life: "loaded",
      tries: 10,
      walletId,
    });

    const request = {
      kind: "evm.personal-message" as const,
      network: "eip155:1",
      account: {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "evm.bip44" as const,
      },
      message: utf8ToBytes("hello facade"),
    };
    const signed = api.start(
      { kind: "sign", request },
      { verify: { kind: "password", password: PASSWORD } },
    );
    drive(signed, input, reader, { codes: [freshCode()], choices: [sim], deck: [sim] });
    const outcome = (await signed.result) as {
      kind: "sign";
      result: { kind: "evm.personal-message"; signature: Uint8Array };
    };
    expect(outcome.result.kind).toBe("evm.personal-message");
    // The facade already re-verified; confirm independently the signature is the card wallet's.
    const accounts = (await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:1",
    })) as { address: string };
    expect(recoverEvmSigner(request, { signature: outcome.result.signature })).toBe(
      accounts.address.toLowerCase(),
    );
  });

  it("creates a 2-card generated set and signs one request per family — facade-verified, independently recovered", async () => {
    const { wallet, reader, input, crossed, draws } = await rig();
    const api = card(wallet);
    const source = await simulator.newCard();
    const target = await simulator.newCard();

    const created = api.start(
      { kind: "create", cards: 2, source: { kind: "generate" } },
      { verify: { kind: "password", password: PASSWORD } },
    );
    drive(created, input, reader, {
      codes: [freshCode(), freshCode()],
      choices: [target, source],
      deck: [source, target],
    });
    const { walletId } = (await created.result) as { kind: "create"; walletId: string };

    // Every family's account comes off the card-wallet record — the generated seed has no
    // software oracle, so each sign below is what proves the account.
    const evm = (await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:1",
    })) as { address: string };
    const tron = (await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "tron.bip44",
      network: TRON_NETWORK,
    })) as { address: string };
    const solana = (await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change",
      network: SOL_NETWORK,
    })) as { address: string };
    const btc84 = (await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "btc.bip84",
      network: BTC_NETWORK,
    })) as { xpub: string; fingerprint: string };
    const btc86 = (await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "btc.bip86",
      network: BTC_NETWORK,
    })) as { xpub: string; fingerprint: string };
    expect(btc86.xpub).not.toBe(btc84.xpub);

    /** A sign through the facade — resolving `task.result` means checkResult already passed. */
    const sign = async (request: ChainSignRequest, which: SimCard): Promise<ChainSignResult> => {
      const task = api.start(
        { kind: "sign", request },
        { verify: { kind: "password", password: PASSWORD } },
      );
      drive(task, input, reader, { codes: [freshCode()], choices: [which], deck: [which] });
      const outcome = (await task.result) as { kind: "sign"; result: ChainSignResult };
      return outcome.result;
    };

    // EVM eip1559 — viem parses the signed envelope and recovers the account address.
    const evmRequest: ChainSignRequest = {
      kind: "evm.transaction",
      network: "eip155:1",
      account: {
        kind: "hd",
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
      },
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 2,
        gas: "0x5208",
        value: "0x16345785d8a0000",
        data: "0x",
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        maxFeePerGas: "0x77359400",
        maxPriorityFeePerGas: "0x59682f00",
        accessList: [],
      },
    };
    const evmResult = await sign(evmRequest, source);
    if (evmResult.kind !== "evm.transaction") {
      throw new Error(`evm sign answered ${evmResult.kind}`);
    }
    const recovered = await recoverTransactionAddress({
      serializedTransaction:
        `0x${bytesToHex(evmResult.signedTransaction)}` as TransactionSerialized,
    });
    expect(recovered.toLowerCase()).toBe(evm.address.toLowerCase());

    // A tron.message sign first — its recovered key is the owner the transaction embeds.
    const tronText = utf8ToBytes("hello tron");
    const tronMessage: ChainSignRequest = {
      kind: "tron.message",
      network: TRON_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" },
      message: tronText,
    };
    const tronMsgResult = await sign(tronMessage, target);
    if (tronMsgResult.kind !== "tron.message") {
      throw new Error(`tron sign answered ${tronMsgResult.kind}`);
    }
    const tronKey = recoverTronKey(tronMsgResult.signature, tronMessageDigest(tronText));
    expect(tronAddressFromPublicKey(tronKey.toBytes(false))).toBe(tron.address);

    const tronRaw = hexToBytes(vectorCase("tron-transaction-trx-transfer")["rawData"] as string);
    const owner = hexToBytes(evmAddressFromPublicKey(tronKey.toBytes(true)).slice(2));
    for (let i = 0; i + 21 <= tronRaw.length; i += 1) {
      if (tronRaw.subarray(i, i + 21).every((b, j) => b === ANVIL_TRON[j])) {
        tronRaw.set([0x41, ...owner], i);
      }
    }
    const tronTx: ChainSignRequest = {
      kind: "tron.transaction",
      network: TRON_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0, template: "tron.bip44" },
      rawData: tronRaw,
    };
    const tronTxResult = await sign(tronTx, target);
    if (tronTxResult.kind !== "tron.transaction") {
      throw new Error(`tron sign answered ${tronTxResult.kind}`);
    }
    const tronTxKey = recoverTronKey(tronTxResult.signature, sha256(tronRaw));
    expect(tronAddressFromPublicKey(tronTxKey.toBytes(false))).toBe(tron.address);

    // Solana — the vector's first required signer is re-pointed at the wallet's key.
    const solanaMessage = hexToBytes(
      vectorCase("solana-transaction-legacy-single-signer")["message"] as string,
    );
    solanaMessage.set(
      new Uint8Array(getAddressEncoder().encode(address(solana.address))),
      3 + 1, // legacy header(3), account count(1), then the first account
    );
    const solTx: ChainSignRequest = {
      kind: "solana.transaction",
      network: SOL_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
      message: solanaMessage,
    };
    const solResult = await sign(solTx, source);
    if (solResult.kind !== "solana.transaction") {
      throw new Error(`solana sign answered ${solResult.kind}`);
    }
    expect(verifySolanaSignature(solanaMessage, solResult.signature, solana.address)).toBe(true);

    // Bitcoin PSBT spending one bip84 input — built from the account xpub's change-0 leaf.
    const leaf84 = HDKey.fromExtendedKey(btc84.xpub).deriveChild(0).deriveChild(0);
    const pub84 = leaf84.publicKey;
    if (pub84 === null) {
      throw new Error("no public key");
    }
    const spend = p2wpkh(pub84);
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({
      txid: hexToBytes(`aa${"11".repeat(31)}`),
      index: 0,
      sequence: 0xffffffff,
    });
    prev.addOutput({ script: spend.script, amount: 100000n });
    const psbtTx = new Transaction({ version: 2, allowUnknownOutputs: true });
    psbtTx.addInput({
      txid: hexToBytes(prev.id),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: spend.script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [
          pub84,
          {
            fingerprint: Number.parseInt(btc84.fingerprint, 16),
            path: [84 + HARDENED, HARDENED, HARDENED, 0, 0],
          },
        ],
      ],
    });
    const change = HDKey.fromExtendedKey(btc84.xpub).deriveChild(0).deriveChild(1).publicKey;
    if (change === null) {
      throw new Error("no public key");
    }
    psbtTx.addOutput({ script: p2wpkh(change).script, amount: 5000n });
    const psbtRequest: ChainSignRequest = {
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0 },
      psbt: psbtTx.toPSBT(0),
      sign: [{ index: 0, template: "btc.bip84" }],
    };
    const psbtResult = await sign(psbtRequest, target);
    if (psbtResult.kind !== "bitcoin.psbt") {
      throw new Error(`psbt sign answered ${psbtResult.kind}`);
    }
    expect(
      verifyBitcoinPsbtSignatures(psbtResult.signedPsbt, [0], btc84.xpub, "btc.bip84", BTC_NETWORK),
    ).toBe(true);

    // Leak scan over everything that crossed hostPort: access-code bytes, every per-card
    // access hash, drawn host entropy and the imported wallet's seed must all stay kernel-side.
    const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);
    const code = utf8ToBytes(CODE_TEXT);
    const needles = [
      code,
      await accessHash(code, cardId(source.identity), quickArgon2id),
      await accessHash(code, cardId(target.identity), quickArgon2id),
      seed,
      ...draws.filter((d) => d.length === 32),
      ...draws.filter((d) => d.length === 32).map((d) => d.subarray(0, 16)),
    ];
    for (const frame of crossed) {
      expect(containsSecret(frame, needles)).toBe(false);
    }
    crossed.push({ planted: code });
    expect(containsSecret(crossed.at(-1), needles)).toBe(true);
    crossed.pop();
  }, 900_000);
});
