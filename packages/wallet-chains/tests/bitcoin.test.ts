import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, WIF, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { NETWORK } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt, normalizeBitcoin } from "../src/bitcoin/index.ts";
import { bip322ToSpendTxid } from "../src/bitcoin/message.ts";
import { signBitcoinMessage, signBitcoinPsbt } from "../src/bitcoin/sign.ts";
import { ChainError } from "../src/index.ts";

const expectedHash = (message: string): Uint8Array => {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
  const push = (d: Uint8Array): Uint8Array => {
    const o = new Uint8Array(1 + d.length);
    o[0] = d.length;
    o.set(d, 1);
    return o;
  };
  const prefix = utf8("Bitcoin Signed Message:\n");
  const msg = utf8(message);
  const data = new Uint8Array(prefix.length + 1 + msg.length + 1);
  data.set(push(prefix), 0);
  data.set(push(msg), prefix.length + 1);
  return sha256(sha256(data));
};

type BtcVectors = {
  mnemonic: string;
  bip84: { path: string; addresses: Record<string, string> };
  bip49: { path: string; addresses: Record<string, string> };
  bip44: { path: string; addresses: Record<string, string> };
  bip86: { path: string; addresses: Record<string, string> };
  bip322: {
    address: string;
    wif: string;
    txHashes: ReadonlyArray<{ message: string; messageHash: string; toSpendTxHash: string }>;
    simple: ReadonlyArray<{ message: string; signatures: ReadonlyArray<string> }>;
  };
  legacyMessage: { wif: string; address: string; message: string; signature: string };
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrMap = (v: unknown): v is Record<string, string> =>
  isRec(v) && Object.values(v).every((x) => typeof x === "string");

const readVectors = (): BtcVectors => {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/bitcoin.json"), "utf8"),
  );
  if (
    !isRec(raw) ||
    typeof raw["mnemonic"] !== "string" ||
    !isRec(raw["bip84"]) ||
    !isStrMap(raw["bip84"]["addresses"]) ||
    !isRec(raw["bip49"]) ||
    !isStrMap(raw["bip49"]["addresses"]) ||
    !isRec(raw["bip44"]) ||
    !isStrMap(raw["bip44"]["addresses"]) ||
    !isRec(raw["bip86"]) ||
    !isStrMap(raw["bip86"]["addresses"]) ||
    !isRec(raw["bip322"]) ||
    typeof raw["bip322"]["address"] !== "string" ||
    typeof raw["bip322"]["wif"] !== "string" ||
    !Array.isArray(raw["bip322"]["simple"]) ||
    !isRec(raw["legacyMessage"]) ||
    !isStrMap(raw["legacyMessage"])
  ) {
    throw new Error("malformed bitcoin vectors");
  }
  const v = raw["bip322"];
  const txHashes = (v["txHashes"] as ReadonlyArray<unknown>).map((t) => {
    if (
      !isRec(t) ||
      typeof t["message"] !== "string" ||
      typeof t["toSpendTxHash"] !== "string" ||
      typeof t["messageHash"] !== "string"
    ) {
      throw new Error("malformed txHashes");
    }
    return {
      message: t["message"],
      messageHash: t["messageHash"],
      toSpendTxHash: t["toSpendTxHash"],
    };
  });
  const simple = v["simple"] as ReadonlyArray<{
    message: string;
    signatures: ReadonlyArray<string>;
  }>;
  return {
    mnemonic: raw["mnemonic"],
    bip84: { path: String(raw["bip84"]["path"]), addresses: raw["bip84"]["addresses"] },
    bip49: { path: String(raw["bip49"]["path"]), addresses: raw["bip49"]["addresses"] },
    bip44: { path: String(raw["bip44"]["path"]), addresses: raw["bip44"]["addresses"] },
    bip86: { path: String(raw["bip86"]["path"]), addresses: raw["bip86"]["addresses"] },
    bip322: {
      address: typeof v["address"] === "string" ? v["address"] : "",
      wif: typeof v["wif"] === "string" ? v["wif"] : "",
      txHashes,
      simple,
    },
    legacyMessage: {
      wif: String(raw["legacyMessage"]["wif"]),
      address: String(raw["legacyMessage"]["address"]),
      message: String(raw["legacyMessage"]["message"]),
      signature: String(raw["legacyMessage"]["signature"]),
    },
  };
};

const vectors = readVectors();

const hex = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from(s.startsWith("0x") ? s.slice(2) : s, "hex"));

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "btc" } as const;
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const auxRand = (_n: number): Uint8Array => new Uint8Array(32);

const wifKey = (wif: string): Uint8Array => WIF(NETWORK).decode(wif);

describe("derivation", () => {
  it.each(Object.entries(vectors.bip84.addresses))("BIP-84 %s → address", (path, expected) => {
    const derived = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(path);
    expect(derived.publicKey).toBeDefined();
    expect(p2wpkh(derived.publicKey!, NETWORK).address).toBe(expected);
  });

  it.each(Object.entries(vectors.bip49.addresses))("BIP-49 %s → P2SH-P2WPKH", (path, expected) => {
    const derived = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(path);
    const wrapped = p2sh(p2wpkh(derived.publicKey!, NETWORK), NETWORK);
    expect(wrapped.address).toBe(expected);
  });

  it.each(Object.entries(vectors.bip44.addresses))("BIP-44 %s → P2PKH", (path, expected) => {
    const derived = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(path);
    expect(p2pkh(derived.publicKey!, NETWORK).address).toBe(expected);
  });

  it.each(Object.entries(vectors.bip86.addresses))("BIP-86 %s → address", (path, expected) => {
    const derived = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(path);
    const internal = derived.publicKey!.slice(1);
    expect(p2tr(internal, undefined, NETWORK).address).toBe(expected);
  });
});

describe("bip322 + legacy message", () => {
  const key = wifKey(vectors.bip322.wif);

  it.each(vectors.bip322.txHashes)(
    "BIP-322 to_spend txid for message $message matches the official vector",
    ({ message, toSpendTxHash }) => {
      const scriptPubKey = OutScript.encode(Address(NETWORK).decode(vectors.bip322.address));
      expect(Buffer.from(bip322ToSpendTxid(scriptPubKey, message)).toString("hex")).toBe(
        toSpendTxHash,
      );
    },
  );

  it.each(vectors.bip322.simple)(
    "BIP-322 simple signature for message $message has the spec structure",
    ({ message }) => {
      const sig = signBitcoinMessage(
        { network: MAINNET, address: vectors.bip322.address, message, format: "bip322-simple" },
        key,
        auxRand,
      );
      const witness = Buffer.from(sig.slice(3), "base64");
      expect(sig.startsWith("smp")).toBe(true);
      expect(witness[0]).toBe(2);
      const sigLen = Number(witness[1]);
      expect(sigLen).toBeGreaterThan(70);
      expect(sigLen).toBeLessThan(74);
      expect(witness[2 + sigLen]).toBe(0x21);
      expect(
        Buffer.from(witness.subarray(3 + sigLen, 36 + sigLen)).equals(
          Buffer.from(secp256k1.getPublicKey(key, true)),
        ),
      ).toBe(true);
      const der = witness.subarray(2, 2 + sigLen);
      expect(der[sigLen - 1]).toBe(1);
    },
  );

  it("legacy message signature: compact base64, header 31-34, recovers the key", () => {
    const priv = wifKey(vectors.legacyMessage.wif);
    const sig = signBitcoinMessage(
      {
        network: MAINNET,
        address: vectors.legacyMessage.address,
        message: vectors.legacyMessage.message,
        format: "legacy",
      },
      priv,
      auxRand,
    );
    const raw = Buffer.from(sig, "base64");
    expect(raw).toHaveLength(65);
    const header = Number(raw[0]);
    expect(header).toBeGreaterThanOrEqual(31);
    expect(header).toBeLessThanOrEqual(34);
    expect(
      secp256k1.verify(
        raw.subarray(1),
        expectedHash(vectors.legacyMessage.message),
        secp256k1.getPublicKey(priv, true),
      ),
    ).toBe(true);
  });
});

const PAYEE = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const ownPub = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(
  "m/84'/0'/0'/0/0",
).publicKey!;
const ownScript = p2wpkh(ownPub, NETWORK).script;

const buildPsbt = (opts: {
  sighash?: number;
  noWitnessUtxo?: boolean;
  opReturn?: boolean;
  extraInput?: boolean;
  weirdScript?: boolean;
  coinType?: number;
}): Uint8Array => {
  const coinType = opts.coinType ?? 0x80000000;
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  const input: Record<string, unknown> = {
    txid: hex("0707".repeat(16)),
    index: 0,
    sequence: 0xfffffffd,
    bip32Derivation: [
      [ownPub, { fingerprint: 0x73c5da0a, path: [0x80000054, coinType, 0x80000000, 0, 0] }],
    ],
    ...(opts.noWitnessUtxo === true ? {} : { witnessUtxo: { script: ownScript, amount: 100000n } }),
  };
  if (opts.sighash !== undefined) {
    input["sighashType"] = opts.sighash;
  }
  tx.addInput(input);
  if (opts.extraInput === true) {
    tx.addInput({
      txid: hex("0808".repeat(16)),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: ownScript, amount: 5000n },
      bip32Derivation: [
        [ownPub, { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 1] }],
      ],
    });
  }
  if (opts.weirdScript === true) {
    tx.addOutput({ script: Uint8Array.of(0x50, 0x21, ...new Uint8Array(33)), amount: 5000n });
  } else {
    tx.addOutput({ script: OutScript.encode(Address(NETWORK).decode(PAYEE)), amount: 90000n });
  }
  if (opts.opReturn === true) {
    tx.addOutput({ script: Uint8Array.of(0x6a, 4, 1, 2, 3, 4), amount: 0n });
  }
  return tx.toPSBT(0);
};

const req = (psbt: Uint8Array, sign: ReadonlyArray<number> = [0]) => ({
  kind: "bitcoin.psbt",
  network: MAINNET,
  account: ACCOUNT,
  psbt,
  sign,
});

describe("normalizeBitcoin", () => {
  it("accepts a valid P2WPKH PSBT", () => {
    const n = normalizeBitcoin(req(buildPsbt({})));
    expect(n.kind).toBe("bitcoin.psbt");
  });

  it("rejects missing witnessUtxo, non-default sighash, malformed sign, bad network", () => {
    expect(() => normalizeBitcoin(req(buildPsbt({ noWitnessUtxo: true })))).toThrow(ChainError);
    expect(() => normalizeBitcoin(req(buildPsbt({ sighash: 2 })))).toThrow(ChainError);
    expect(() => normalizeBitcoin(req(buildPsbt({ sighash: 0x41 })))).toThrow(ChainError);
    expect(() => normalizeBitcoin(req(buildPsbt({}), []))).toThrow(ChainError);
    expect(() => normalizeBitcoin(req(buildPsbt({}), [1]))).toThrow(ChainError);
    expect(() => normalizeBitcoin(req(buildPsbt({}), [0, 0]))).toThrow(ChainError);
    expect(() => normalizeBitcoin({ ...req(buildPsbt({})), network: "bip122:deadbeef" })).toThrow(
      ChainError,
    );
    expect(() => normalizeBitcoin({ ...req(buildPsbt({})), psbt: new Uint8Array(4) })).toThrow(
      ChainError,
    );
  });

  it("is idempotent", () => {
    const once = asPsbt(normalizeBitcoin(req(buildPsbt({}))));
    const twice = asPsbt(normalizeBitcoin({ ...req(buildPsbt({})), psbt: once.psbt }));
    expect(Buffer.from(twice.psbt).equals(Buffer.from(once.psbt))).toBe(true);
  });

  it("rejects a derivation-path coin-type mismatch", () => {
    expect(() => normalizeBitcoin(req(buildPsbt({ coinType: 0x80000001 })))).toThrow(ChainError);
  });
});

describe("bitcoin.message normalize", () => {
  const msg = (format: string, address: string, network = MAINNET) => ({
    kind: "bitcoin.message",
    network,
    account: ACCOUNT,
    address,
    message: "hi",
    format,
    change: 0,
    index: 0,
  });

  it("accepts bip322-simple for P2WPKH/P2TR, legacy for P2PKH", () => {
    expect(normalizeBitcoin(msg("bip322-simple", vectors.bip322.address)).kind).toBe(
      "bitcoin.message",
    );
    expect(
      normalizeBitcoin(msg("bip322-simple", vectors.bip86.addresses["m/86'/0'/0'/0/0"]!)).kind,
    ).toBe("bitcoin.message");
    expect(normalizeBitcoin(msg("legacy", vectors.legacyMessage.address)).kind).toBe(
      "bitcoin.message",
    );
  });

  it("rejects mismatched formats and wrong-network addresses", () => {
    expect(() => normalizeBitcoin(msg("bip322-simple", vectors.legacyMessage.address))).toThrow(
      ChainError,
    );
    expect(() => normalizeBitcoin(msg("legacy", vectors.bip322.address))).toThrow(ChainError);
    expect(() => normalizeBitcoin(msg("offchain", vectors.bip322.address))).toThrow(ChainError);
    expect(() =>
      normalizeBitcoin(msg("bip322-simple", "tb1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")),
    ).toThrow(ChainError);
    expect(() => normalizeBitcoin(msg("bip322-simple", "not an address"))).toThrow(ChainError);
  });
});

type PsbtRequest = Extract<ReturnType<typeof normalizeBitcoin>, { kind: "bitcoin.psbt" }>;
const asPsbt = (n: ReturnType<typeof normalizeBitcoin>): PsbtRequest => {
  if (n.kind !== "bitcoin.psbt") {
    throw new Error("unexpected kind");
  }
  return n;
};

describe("decode + verifiability", () => {
  const psbtReq = (): PsbtRequest => asPsbt(normalizeBitcoin(req(buildPsbt({}))));

  it("decodes the outflow and fee (100000 - 90000 = 10000 sats)", () => {
    const intent = decodeBitcoinPsbt(psbtReq(), new Set());
    expect(intent.verifiability).toBe("full");
    expect(intent.outflows[0]?.to).toBe(PAYEE);
    expect(intent.outflows[0]?.amount.amount).toBe("90000");
    expect(intent.fee?.max.amount).toBe("10000");
  });

  it("ownScripts suppresses the output", () => {
    const payeeScript = OutScript.encode(Address(NETWORK).decode(PAYEE));
    const intent = decodeBitcoinPsbt(
      psbtReq(),
      new Set([Buffer.from(payeeScript).toString("hex")]),
    );
    expect(intent.outflows).toHaveLength(0);
  });

  it("external input → opaque and fee includes its prevout", () => {
    const intent = decodeBitcoinPsbt(
      asPsbt(normalizeBitcoin(req(buildPsbt({ extraInput: true })))),
      new Set(),
    );
    expect(intent.verifiability).toBe("opaque");
    expect(intent.fee?.max.amount).toBe("15000");
  });

  it("OP_RETURN row keeps full class; undecodable output → partial", () => {
    const intent = decodeBitcoinPsbt(
      asPsbt(normalizeBitcoin(req(buildPsbt({ opReturn: true })))),
      new Set(),
    );
    expect(intent.verifiability).toBe("full");
    expect(
      decodeBitcoinPsbt(asPsbt(normalizeBitcoin(req(buildPsbt({ weirdScript: true })))), new Set())
        .verifiability,
    ).toBe("partial");
  });
});

describe("signBitcoinPsbt", () => {
  it("signs the listed inputs", () => {
    const ownPriv = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(
      "m/84'/0'/0'/0/0",
    ).privateKey!;
    const signed = signBitcoinPsbt(buildPsbt({}), [{ index: 0, privateKey: ownPriv }], auxRand);
    const tx = Transaction.fromPSBT(signed);
    expect(tx.getInput(0).partialSig).toBeDefined();
  });
});

describe("bitcoinjs oracle", () => {
  const psbtFor = (input: Record<string, unknown>): Uint8Array => {
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    tx.addInput(input);
    tx.addOutput({ script: OutScript.encode(Address(NETWORK).decode(PAYEE)), amount: 90000n });
    return tx.toPSBT(0);
  };
  const ourSig = (psbt: Uint8Array, key: Uint8Array): Uint8Array => {
    const tx = Transaction.fromPSBT(
      signBitcoinPsbt(psbt, [{ index: 0, privateKey: key }], auxRand),
    );
    const partial = tx.getInput(0).partialSig;
    const tap = tx.getInput(0).tapKeySig;
    if (tap !== undefined) {
      return tap;
    }
    if (partial === undefined) {
      throw new Error("no signature produced");
    }
    const [, sig] = partial[0] ?? [];
    if (sig === undefined) {
      throw new Error("no signature produced");
    }
    return sig;
  };
  const theirSig = async (psbt: Uint8Array, key: Uint8Array): Promise<Uint8Array> => {
    const bitcoin = await import("bitcoinjs-lib");
    const ecc = await import("tiny-secp256k1");
    bitcoin.initEccLib(ecc);
    const { ECPairFactory } = await import("ecpair");
    const ECPair = ECPairFactory(ecc);
    const signer = ECPair.fromPrivateKey(key);
    const theirs = bitcoin.Psbt.fromBuffer(Buffer.from(psbt));
    const [tapInput] = theirs.data.inputs;
    if (tapInput?.tapInternalKey === undefined) {
      theirs.signInput(0, signer);
    } else {
      const tweakHash = bitcoin.crypto.taggedHash("TapTweak", signer.publicKey.subarray(1));
      theirs.signInput(0, signer.tweak(tweakHash));
    }
    const partial = theirs.data.inputs[0]?.partialSig;
    if (partial !== undefined) {
      const sig = partial[0]?.signature;
      if (sig !== undefined) {
        return sig;
      }
    }
    const tap = theirs.data.inputs[0]?.tapKeySig;
    if (tap !== undefined) {
      return tap;
    }
    throw new Error("no signature produced");
  };
  const ownNode = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(
    "m/84'/0'/0'/0/0",
  );
  const priv = ownNode.privateKey!;
  const pub = p2wpkh(ownNode.publicKey!, NETWORK);

  const baseInput = (): Record<string, unknown> => ({
    txid: hex("0707".repeat(16)),
    index: 0,
    sequence: 0xfffffffd,
  });

  it("P2WPKH partial sig matches bitcoinjs byte-for-byte", async () => {
    const psbt = psbtFor({
      ...baseInput(),
      witnessUtxo: { script: pub.script, amount: 100000n },
      bip32Derivation: [
        [
          ownNode.publicKey!,
          { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
        ],
      ],
    });
    expect(ourSig(psbt, priv)).toStrictEqual(await theirSig(psbt, priv));
  });

  it("P2SH-P2WPKH partial sig matches bitcoinjs byte-for-byte", async () => {
    const { p2sh } = await import("@scure/btc-signer/payment.js");
    const wrapped = p2sh(pub, NETWORK);
    const psbt = psbtFor({
      ...baseInput(),
      witnessUtxo: { script: wrapped.script, amount: 100000n },
      redeemScript: pub.script,
      bip32Derivation: [
        [
          ownNode.publicKey!,
          { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
        ],
      ],
    });
    expect(ourSig(psbt, priv)).toStrictEqual(await theirSig(psbt, priv));
  });

  it("P2PKH partial sig matches bitcoinjs byte-for-byte", async () => {
    const { p2pkh } = await import("@scure/btc-signer/payment.js");
    const pk = p2pkh(ownNode.publicKey!, NETWORK);
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hex("0000".repeat(16)), index: 0, sequence: 0xfffffffd });
    prev.addOutput({ script: pk.script, amount: 100000n });
    const prevBytes = prev.toBytes();
    const prevTxid = hex(prev.id);
    const psbt = psbtFor({
      ...baseInput(),
      txid: prevTxid,
      nonWitnessUtxo: prevBytes,
      witnessUtxo: { script: pk.script, amount: 100000n },
      bip32Derivation: [
        [
          ownNode.publicKey!,
          { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
        ],
      ],
    });
    expect(ourSig(psbt, priv)).toStrictEqual(await theirSig(psbt, priv));
  });

  it("P2TR key-path tapKeySig matches bitcoinjs byte-for-byte", async () => {
    const internal = ownNode.publicKey!.subarray(1);
    const tr = p2tr(internal, undefined, NETWORK);
    const psbt = psbtFor({
      ...baseInput(),
      witnessUtxo: { script: tr.script, amount: 100000n },
      tapInternalKey: internal,
      tapBip32Derivation: [
        [
          internal,
          {
            hashes: [],
            der: { fingerprint: 0x73c5da0a, path: [0x80000056, 0x80000000, 0x80000000, 0, 0] },
          },
        ],
      ],
    });
    expect(ourSig(psbt, priv)).toStrictEqual(await theirSig(psbt, priv));
  });
});
