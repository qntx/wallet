import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeBitcoinPsbt,
  normalizeBitcoin,
  verifyBitcoinPsbtSignatures,
} from "../src/bitcoin/index.ts";
import { signBitcoinPsbt } from "../src/bitcoin/sign.ts";
import { ChainError } from "../src/index.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "btc.bip84" } as const;
const PAYEE = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const SINGLE_ACP = 0x83;
const auxRand = (_n: number): Uint8Array => new Uint8Array(32);
const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const node84 = master.derive("m/84'/0'/0'/0/0");
const node86 = master.derive("m/86'/0'/0'/0/0");
const xpub84 = master.derive("m/84'/0'/0'").publicExtendedKey;
const xpub86 = master.derive("m/86'/0'/0'").publicExtendedKey;
const FP = 0x73c5da0a;

type Kind = "p2wpkh" | "p2tr";

const buildPsbt = (
  kind: Kind,
  opts: { sighash?: number; outputs?: number; inputs?: number } = {},
): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  const node = kind === "p2wpkh" ? node84 : node86;
  const internal = (node.publicKey ?? new Uint8Array()).subarray(1);
  const script =
    kind === "p2wpkh"
      ? p2wpkh(node.publicKey ?? new Uint8Array(), NETWORK).script
      : p2tr(internal, undefined, NETWORK).script;
  for (let i = 0; i < (opts.inputs ?? 1); i++) {
    tx.addInput({
      txid: hex(`07${String(i)}7`.repeat(16).slice(0, 64)),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script, amount: 100000n },
      ...(opts.sighash === undefined ? {} : { sighashType: opts.sighash }),
      ...(kind === "p2wpkh"
        ? {
            bip32Derivation: [
              [
                node.publicKey ?? new Uint8Array(),
                { fingerprint: FP, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
              ],
            ],
          }
        : {
            tapInternalKey: internal,
            tapBip32Derivation: [
              [
                internal,
                {
                  hashes: [],
                  der: { fingerprint: FP, path: [0x80000056, 0x80000000, 0x80000000, 0, 0] },
                },
              ],
            ],
          }),
    });
  }
  for (let i = 0; i < (opts.outputs ?? 1); i++) {
    tx.addOutput({ script: OutScript.encode(Address(NETWORK).decode(PAYEE)), amount: 90000n });
  }
  return tx.toPSBT(0);
};

const request = (psbt: Uint8Array, sign: ReadonlyArray<number> = [0]) => ({
  kind: "bitcoin.psbt",
  network: MAINNET,
  account: ACCOUNT,
  psbt,
  sign,
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ChainError ? error.code : "other";
  }
  return undefined;
};

const privateKeyOf = (node: HDKey): Uint8Array => node.privateKey ?? new Uint8Array();

type PsbtRequest = Extract<ReturnType<typeof normalizeBitcoin>, { kind: "bitcoin.psbt" }>;

const normalizedPsbt = (psbt: Uint8Array): PsbtRequest => {
  const normalized = normalizeBitcoin(request(psbt));
  if (normalized.kind !== "bitcoin.psbt") {
    throw new Error("expected a PSBT request");
  }
  return normalized;
};

/** The signature a signed input carries: `tapKeySig` for taproot, else the first partial sig. */
const sigOf = (input: ReturnType<Transaction["getInput"]>): Uint8Array | undefined =>
  input.tapKeySig ?? input.partialSig?.[0]?.[1];

const bitcoinjsSignature = async (
  kind: Kind,
  psbt: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array | undefined> => {
  const bitcoin = await import("bitcoinjs-lib");
  const ecc = await import("tiny-secp256k1");
  bitcoin.initEccLib(ecc);
  const { ECPairFactory } = await import("ecpair");
  const signer = ECPairFactory(ecc).fromPrivateKey(key);
  const theirs = bitcoin.Psbt.fromBuffer(Buffer.from(psbt));
  const tweak = bitcoin.crypto.taggedHash("TapTweak", signer.publicKey.subarray(1));
  theirs.signInput(0, kind === "p2tr" ? signer.tweak(tweak) : signer, [SINGLE_ACP]);
  const [input] = theirs.data.inputs;
  const sig = input?.tapKeySig ?? input?.partialSig?.[0]?.signature;
  return sig === undefined ? undefined : new Uint8Array(sig);
};

describe("SIGHASH_SINGLE|ANYONECANPAY", () => {
  it.each([
    ["p2wpkh", node84, "btc.bip84", xpub84],
    ["p2tr", node86, "btc.bip86", xpub86],
  ] as const)(
    "%s: signs 0x83, verifies, and decode marks the listing",
    (kind, node, template, xpub) => {
      const normalized = normalizedPsbt(buildPsbt(kind, { sighash: SINGLE_ACP }));
      const signed = signBitcoinPsbt(
        normalized.psbt,
        [{ index: 0, privateKey: privateKeyOf(node) }],
        auxRand,
      );
      expect(verifyBitcoinPsbtSignatures(signed, [0], xpub, template, MAINNET)).toBe(true);
      const sig = sigOf(Transaction.fromPSBT(signed).getInput(0));
      // segwit v0 appends the sighash byte to the DER signature; taproot adds it to the 64 bytes.
      expect(sig?.at(-1)).toBe(SINGLE_ACP);
      const intent = decodeBitcoinPsbt(normalized);
      expect(intent.verifiability).toBe("partial");
      expect(intent.fee).toBeUndefined();
      expect(intent.warnings).toStrictEqual([
        {
          kind: "sighash-single-anyonecanpay",
          message:
            "signed inputs bind only their same-index outputs; the rest of the transaction can change",
        },
      ]);
    },
  );

  it.each([
    ["p2wpkh", node84],
    ["p2tr", node86],
  ] as const)("%s: matches bitcoinjs byte-for-byte", async (kind, node) => {
    const key = privateKeyOf(node);
    const psbt = buildPsbt(kind, { sighash: SINGLE_ACP });
    const ours = sigOf(
      Transaction.fromPSBT(
        signBitcoinPsbt(psbt, [{ index: 0, privateKey: key }], auxRand),
      ).getInput(0),
    );
    expect(ours).toStrictEqual(await bitcoinjsSignature(kind, psbt, key));
  });

  it("refuses 0x83 without a paired output", () => {
    // Two inputs, one output: input 1 has no same-index output.
    const psbt = buildPsbt("p2wpkh", { sighash: SINGLE_ACP, inputs: 2, outputs: 1 });
    expect(code(() => normalizeBitcoin(request(psbt, [0])))).toBeUndefined();
    expect(code(() => normalizeBitcoin(request(psbt, [1])))).toBe("unsupported");
  });

  it.each([0x02, 0x03, 0x81, 0x82])("refuses sighash 0x%s", (sighash) => {
    expect(code(() => normalizeBitcoin(request(buildPsbt("p2wpkh", { sighash }))))).toBe(
      "unsupported",
    );
    expect(code(() => normalizeBitcoin(request(buildPsbt("p2tr", { sighash }))))).toBe(
      "unsupported",
    );
  });

  it("ALL keeps the fee and a full decode", () => {
    const normalized = normalizedPsbt(buildPsbt("p2wpkh", { sighash: 1 }));
    const intent = decodeBitcoinPsbt(normalized);
    expect(intent.warnings).toStrictEqual([]);
    expect(intent.fee).toBeDefined();
  });
});
