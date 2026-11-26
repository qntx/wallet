/// <reference types="node" />
/**
 * Regenerates vectors/chains/signing-plans.json — the signing tasks every family's `plan` must
 * produce for the public test mnemonic, and the artefact the deterministic software signer must
 * assemble from them. No project imports: digests come from the protocols' own libraries — viem
 * (EVM), tronweb (TRON), bitcoinjs-lib (Bitcoin sighashes) and @solana/kit (compiled messages,
 * WebCrypto Ed25519) — and the expected signatures from the same libraries' signers. Before
 * writing, the Bitcoin message procedures are checked against the published BIP-322 and Electrum
 * vectors in vectors/chains/bitcoin.json.
 *
 * Bun scripts/signing-plans-vectors.ts (from packages/wallet-chains)
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createKeyPairFromPrivateKeyBytes, signBytes } from "@solana/kit";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { hashMessage, hashTypedData, keccak256, serializeTransaction } from "viem";
import type { TransactionSerializable } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashAuthorization } from "viem/utils";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = resolve(ROOT, "vectors/chains/signing-plans.json");
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the committed file's shape
const read = <T>(file: string): T =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- committed vector files of known shape
  JSON.parse(readFileSync(resolve(ROOT, file), "utf8")) as T;

type Hex = `0x${string}`;
type EvmTx = {
  readonly type: "legacy" | "eip2930" | "eip1559" | "eip7702";
  readonly chainId: number;
  readonly to: Hex;
  readonly data: Hex;
  readonly value: string;
  readonly nonce: number;
  readonly gas: string;
  readonly gasPrice?: string;
  readonly maxFeePerGas?: string;
  readonly maxPriorityFeePerGas?: string;
  readonly accessList?: ReadonlyArray<{ readonly address: Hex; readonly storageKeys: Hex[] }>;
  readonly authorization?: { readonly address: Hex };
};
type EvmVectors = {
  readonly transactions: ReadonlyArray<{
    readonly name: string;
    readonly network: string;
    readonly tx: EvmTx;
  }>;
  readonly personalMessage: Hex;
  readonly typedData: string;
};
type TronVectors = {
  readonly transactions: ReadonlyArray<{ readonly rawDataHex: string; readonly txId: string }>;
};
type TronTypedVectors = {
  readonly cases: ReadonlyArray<{
    readonly typedData: string;
    readonly digest: string;
    readonly args: { readonly domain: unknown; readonly types: unknown; readonly message: unknown };
  }>;
};
type SolanaWireVectors = {
  readonly cases: ReadonlyArray<{ readonly name: string; readonly message: string }>;
};
type BitcoinVectors = {
  readonly bip322: {
    readonly wif: string;
    readonly simple: ReadonlyArray<{
      readonly message: string;
      readonly signatures: string[];
      readonly wif?: string;
    }>;
  };
  readonly legacyMessage: {
    readonly wif: string;
    readonly message: string;
    readonly signature: string;
  };
};

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);
const H = 0x80000000;

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const req = createRequire(import.meta.url);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tronweb's typed-data utils are untyped
const tronUtils = req("tronweb/utils") as {
  signTransaction: (
    key: string,
    tx: { txID: string; raw_data_hex: string },
  ) => { signature: string[] };
  hashMessage: (m: Uint8Array) => string;
  signMessage: (m: Uint8Array, key: string) => string;
  hashTypedData: (d: unknown, t: unknown, v: unknown) => string;
  signTypedData: (d: unknown, t: unknown, v: unknown, key: string) => string;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const unhex = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text.replace(/^0x/, ""), "hex"));
const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p);
  }
  return Uint8Array.from(h.digest());
};
const assert = (ok: boolean, what: string): void => {
  if (!ok) {
    throw new Error(`self-check failed: ${what}`);
  }
};

const pathText = (path: ReadonlyArray<number>): string =>
  `m${path.map((i) => (i >= H ? `/${i - H}'` : `/${i}`)).join("")}`;

/** BIP-32 secp256k1 node: private key and compressed public key. */
const secpNode = (path: ReadonlyArray<number>): { priv: Uint8Array; pub: Uint8Array } => {
  const node = HDKey.fromMasterSeed(SEED).derive(pathText(path));
  if (node.privateKey === null || node.publicKey === null) {
    throw new Error(`no key at ${pathText(path)}`);
  }
  return { priv: node.privateKey, pub: node.publicKey };
};

/**
 * SLIP-0010 ed25519 private key, spelled out from the spec
 * (https://github.com/satoshilabs/slips/blob/master/slip-0010.md).
 */
const slip10 = (path: ReadonlyArray<number>): Uint8Array => {
  let i = createHmac("sha512", "ed25519 seed").update(SEED).digest();
  for (const index of path) {
    const data = Buffer.alloc(37);
    i.copy(data, 1, 0, 32);
    data.writeUInt32BE(index, 33);
    i = createHmac("sha512", i.subarray(32)).update(data).digest();
  }
  return Uint8Array.from(i.subarray(0, 32));
};

type Task =
  | { scheme: "ecdsa-secp256k1"; path: number[]; publicKey: string; digest: string }
  | { scheme: "bip340"; path: number[]; publicKey: string; message: string; tweak: string }
  | { scheme: "ed25519"; path: number[]; publicKey: string; message: string };

const ecdsa = (path: number[], pub: Uint8Array, digest: string): Task => ({
  scheme: "ecdsa-secp256k1",
  path,
  publicKey: hex(pub),
  digest: digest.replace(/^0x/, ""),
});

const EVM_PATH = [44 + H, 60 + H, H, 0, 0];
const evmKey = secpNode(EVM_PATH);
const evmAccount = privateKeyToAccount(`0x${hex(evmKey.priv)}`);

const evmTaskKey = { path: EVM_PATH, publicKey: hex(evmKey.pub) };
const big = (value: string | undefined): bigint => BigInt(value ?? "0x0");

const viemTx = (tx: EvmTx): TransactionSerializable => {
  const base = {
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
  };
  const accessList = tx.accessList ?? [];
  if (tx.type === "legacy") {
    return { ...base, type: "legacy", gasPrice: big(tx.gasPrice) };
  }
  if (tx.type === "eip2930") {
    return { ...base, type: "eip2930", gasPrice: big(tx.gasPrice), accessList };
  }
  return {
    ...base,
    type: "eip1559",
    accessList,
    maxFeePerGas: big(tx.maxFeePerGas),
    maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
  };
};

const evmTransactionCase = async (name: string, network: string, tx: EvmTx): Promise<unknown> => {
  const request = { kind: "evm.transaction", network, tx };
  if (tx.type !== "eip7702" || tx.authorization === undefined) {
    const unsigned = viemTx(tx);
    const signed = await evmAccount.signTransaction(unsigned);
    return {
      name: `evm-${name}`,
      key: evmTaskKey,
      request,
      stages: [[ecdsa(EVM_PATH, evmKey.pub, keccak256(serializeTransaction(unsigned)))]],
      artefact: signed.slice(2),
    };
  }
  const authorization = {
    address: tx.authorization.address,
    chainId: tx.chainId,
    nonce: tx.nonce + 1,
  };
  const signedAuth = await evmAccount.signAuthorization(authorization);
  const full: TransactionSerializable = {
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    type: "eip7702",
    accessList: tx.accessList ?? [],
    maxFeePerGas: big(tx.maxFeePerGas),
    maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
    authorizationList: [signedAuth],
  };
  const signed = await evmAccount.signTransaction(full);
  return {
    name: `evm-${name}`,
    key: evmTaskKey,
    request,
    stages: [
      [ecdsa(EVM_PATH, evmKey.pub, hashAuthorization(authorization))],
      [ecdsa(EVM_PATH, evmKey.pub, keccak256(serializeTransaction(full)))],
    ],
    artefact: signed.slice(2),
  };
};

const evmCases = async (): Promise<unknown[]> => {
  const evm = read<EvmVectors>("vectors/chains/evm.json");
  const transactions = await Promise.all(
    evm.transactions.map(async ({ name, network, tx }) => evmTransactionCase(name, network, tx)),
  );
  const raw = evm.personalMessage;
  const personal = await evmAccount.signMessage({ message: { raw } });
  const { typedData } = evm;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the committed EIP-712 document
  const doc = JSON.parse(typedData) as Parameters<typeof hashTypedData>[0];
  const typed = await evmAccount.signTypedData(doc);
  return [
    ...transactions,
    {
      name: "evm-personal-message",
      key: evmTaskKey,
      request: { kind: "evm.personal-message", network: "eip155:1", message: raw.slice(2) },
      stages: [[ecdsa(EVM_PATH, evmKey.pub, hashMessage({ raw }))]],
      artefact: personal.slice(2),
    },
    {
      name: "evm-typed-data-mail",
      key: evmTaskKey,
      request: { kind: "evm.typed-data", network: "eip155:1", typedData },
      stages: [[ecdsa(EVM_PATH, evmKey.pub, hashTypedData(doc))]],
      artefact: typed.slice(2),
    },
  ];
};

const TRON_PATH = [44 + H, 195 + H, H, 0, 0];
const tronKey = secpNode(TRON_PATH);
const tronPriv = hex(tronKey.priv);

const tronCases = (): unknown[] => {
  const [transfer] = read<TronVectors>("vectors/chains/tron.json").transactions;
  if (transfer === undefined) {
    throw new Error("tron.json has no transaction");
  }
  const digest = sha256(unhex(transfer.rawDataHex));
  assert(hex(digest) === transfer.txId, "tron txID = sha256(raw_data)");
  const signedTx = tronUtils.signTransaction(tronPriv, {
    txID: transfer.txId,
    raw_data_hex: transfer.rawDataHex,
  });
  const message = Buffer.from("hello tron", "utf8");
  const [permit] = read<TronTypedVectors>("vectors/chains/tron-typed-data.json").cases;
  if (permit === undefined) {
    throw new Error("tron-typed-data.json has no case");
  }
  const typedDigest = tronUtils.hashTypedData(
    permit.args.domain,
    permit.args.types,
    permit.args.message,
  );
  assert(typedDigest === permit.digest, "tron typed-data digest matches the committed vector");
  return [
    {
      name: "tron-transaction-trx-transfer",
      key: { path: TRON_PATH, publicKey: hex(tronKey.pub) },
      request: {
        kind: "tron.transaction",
        network: "tron:728126428",
        rawData: transfer.rawDataHex,
      },
      stages: [[ecdsa(TRON_PATH, tronKey.pub, hex(digest))]],
      artefact: signedTx.signature[0],
    },
    {
      name: "tron-message",
      key: { path: TRON_PATH, publicKey: hex(tronKey.pub) },
      request: { kind: "tron.message", network: "tron:728126428", message: hex(message) },
      stages: [[ecdsa(TRON_PATH, tronKey.pub, tronUtils.hashMessage(message))]],
      artefact: tronUtils.signMessage(message, tronPriv).replace(/^0x/, ""),
    },
    {
      name: "tron-typed-data-permit2-single",
      key: { path: TRON_PATH, publicKey: hex(tronKey.pub) },
      request: { kind: "tron.typed-data", network: "tron:728126428", typedData: permit.typedData },
      stages: [[ecdsa(TRON_PATH, tronKey.pub, typedDigest)]],
      artefact: tronUtils
        .signTypedData(permit.args.domain, permit.args.types, permit.args.message, tronPriv)
        .replace(/^0x/, ""),
    },
  ];
};

const SOLANA_PATH = [44 + H, 501 + H, H, H];

const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_TRANSACTIONS: ReadonlySet<string> = new Set([
  "legacy-single-signer",
  "v0-single-signer",
  "v1-single-signer",
]);

const solanaCases = async (): Promise<unknown[]> => {
  const pair = await createKeyPairFromPrivateKeyBytes(slip10(SOLANA_PATH), true);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const key = { path: SOLANA_PATH, publicKey: hex(pub) };
  const signed = async (
    name: string,
    request: Record<string, string>,
    message: Uint8Array,
  ): Promise<unknown> => {
    const signature = await signBytes(pair.privateKey, message);
    return {
      name,
      key,
      request,
      stages: [
        [{ scheme: "ed25519", path: SOLANA_PATH, publicKey: hex(pub), message: hex(message) }],
      ],
      artefact: hex(signature),
    };
  };
  const { cases } = read<SolanaWireVectors>("vectors/chains/solana-wire.json");
  const transactions = await Promise.all(
    cases
      .filter((c) => SOLANA_TRANSACTIONS.has(c.name))
      .map(async (c) =>
        signed(
          `solana-transaction-${c.name}`,
          { kind: "solana.transaction", network: SOLANA_NETWORK, message: c.message },
          unhex(c.message),
        ),
      ),
  );
  const raw = Buffer.from("hello solana", "utf8");
  return [
    ...transactions,
    await signed(
      "solana-message-raw",
      { kind: "solana.message", network: SOLANA_NETWORK, message: hex(raw), format: "raw" },
      raw,
    ),
  ];
};

const ZERO32 = new Uint8Array(32);
const tapTweak = (x: Uint8Array): Uint8Array => bitcoin.crypto.taggedHash("TapTweak", x);
const btcPath = (purpose: number): number[] => [purpose + H, H, H, 0, 0];

type BtcInput = {
  readonly purpose: 44 | 49 | 84 | 86;
  readonly sighash?: number;
};

const prevTx = (script: Uint8Array, value: bigint, salt: number): bitcoin.Transaction => {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, salt), 0, 0xfffffffd);
  tx.addOutput(script, value);
  return tx;
};

const btcPsbtCase = (name: string, inputs: ReadonlyArray<BtcInput>, outputs: number): unknown => {
  const master = HDKey.fromMasterSeed(SEED);
  const fingerprint = Buffer.alloc(4);
  fingerprint.writeUInt32BE(master.fingerprint);
  const keys = inputs.map(({ purpose }) => {
    const path = btcPath(purpose);
    const { priv, pub } = secpNode(path);
    const x = pub.slice(1);
    const script =
      purpose === 44
        ? bitcoin.payments.p2pkh({ pubkey: pub }).output
        : purpose === 49
          ? bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: pub }) }).output
          : purpose === 84
            ? bitcoin.payments.p2wpkh({ pubkey: pub }).output
            : bitcoin.payments.p2tr({ internalPubkey: x }).output;
    if (script === undefined) {
      throw new Error("payment without output");
    }
    return { path, priv, pub, x, script, purpose };
  });
  const values = keys.map((_, i) => 100_000n + BigInt(i) * 1000n);
  const prevs = keys.map((k, i) => prevTx(k.script, values[i] ?? 0n, i + 1));
  const psbt = new bitcoin.Psbt();
  const unsigned = new bitcoin.Transaction();
  unsigned.version = 2;
  for (const [i, k] of keys.entries()) {
    const prev = prevs[i];
    const value = values[i];
    if (prev === undefined || value === undefined) {
      throw new Error("missing prevout");
    }
    const sighashType = inputs[i]?.sighash;
    const common = {
      hash: prev.getHash(),
      index: 0,
      sequence: 0xfffffffd,
      ...(sighashType === undefined ? {} : { sighashType }),
    };
    if (k.purpose === 86) {
      psbt.addInput({
        ...common,
        witnessUtxo: { script: k.script, value },
        tapInternalKey: k.x,
        tapBip32Derivation: [
          { masterFingerprint: fingerprint, path: pathText(k.path), pubkey: k.x, leafHashes: [] },
        ],
      });
    } else {
      psbt.addInput({
        ...common,
        nonWitnessUtxo: prev.toBuffer(),
        ...(k.purpose === 49
          ? { redeemScript: bitcoin.payments.p2wpkh({ pubkey: k.pub }).output }
          : {}),
        bip32Derivation: [
          { masterFingerprint: fingerprint, path: pathText(k.path), pubkey: k.pub },
        ],
      });
    }
    unsigned.addInput(prev.getHash(), 0, 0xfffffffd);
  }
  for (let o = 0; o < outputs; o++) {
    const script = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xa0 + o) }).output;
    if (script === undefined) {
      throw new Error("payment without output");
    }
    psbt.addOutput({ script, value: 50_000n });
    unsigned.addOutput(script, 50_000n);
  }
  const prevScripts = keys.map((k) => k.script);
  const tasks: Task[] = keys.map((k, i) => {
    const value = values[i] ?? 0n;
    const sighash = inputs[i]?.sighash;
    if (k.purpose === 86) {
      const q = k.script.slice(2);
      return {
        scheme: "bip340",
        path: k.path,
        publicKey: hex(q),
        message: hex(
          unsigned.hashForWitnessV1(
            i,
            prevScripts,
            values,
            sighash ?? bitcoin.Transaction.SIGHASH_DEFAULT,
          ),
        ),
        tweak: hex(tapTweak(k.x)),
      };
    }
    const scriptCode = bitcoin.payments.p2pkh({ pubkey: k.pub }).output;
    if (scriptCode === undefined) {
      throw new Error("payment without output");
    }
    const hashType = sighash ?? bitcoin.Transaction.SIGHASH_ALL;
    const digest =
      k.purpose === 44
        ? unsigned.hashForSignature(i, scriptCode, hashType)
        : unsigned.hashForWitnessV0(i, scriptCode, value, hashType);
    return ecdsa(k.path, k.pub, hex(digest));
  });
  const unsignedPsbt = psbt.toBuffer();
  const signatures = keys.map((k, i) => {
    const sighash = inputs[i]?.sighash;
    const pair = ECPair.fromPrivateKey(k.priv);
    if (k.purpose === 86) {
      psbt.signInput(i, pair.tweak(tapTweak(k.x)), sighash === undefined ? undefined : [sighash]);
      const tapKeySig = psbt.data.inputs[i]?.tapKeySig;
      if (tapKeySig === undefined) {
        throw new Error("bitcoinjs produced no tapKeySig");
      }
      return { index: i, tapKeySig: hex(tapKeySig) };
    }
    psbt.signInput(i, pair, sighash === undefined ? undefined : [sighash]);
    const partial = psbt.data.inputs[i]?.partialSig?.[0];
    if (partial === undefined) {
      throw new Error("bitcoinjs produced no partialSig");
    }
    assert(hex(partial.pubkey) === hex(k.pub), "partialSig pubkey");
    return { index: i, partialSig: hex(partial.signature) };
  });
  return {
    name,
    request: {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: "bip122:000000000019d6689c085ae165831e93",
      psbt: hex(unsignedPsbt),
      inputs: keys.map((k, i) => ({ index: i, path: k.path, publicKey: hex(k.pub) })),
    },
    stages: [tasks],
    artefact: { signatures },
  };
};

const varint = (n: number): Uint8Array => Uint8Array.of(n);
const pushes = (items: ReadonlyArray<Uint8Array>): Uint8Array =>
  Buffer.concat([varint(items.length), ...items.flatMap((item) => [varint(item.length), item])]);
const smp = (witness: ReadonlyArray<Uint8Array>): string =>
  `smp${Buffer.from(pushes(witness)).toString("base64")}`;

/** BIP-322 to_sign for `scriptPubKey` and `message`, spelled out from the BIP. */
const bip322ToSign = (scriptPubKey: Uint8Array, message: string): bitcoin.Transaction => {
  const tag = sha256(Buffer.from("BIP0322-signed-message"));
  const messageHash = sha256(tag, tag, Buffer.from(message, "utf8"));
  const toSpend = new bitcoin.Transaction();
  toSpend.version = 0;
  toSpend.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0,
    Buffer.concat([Uint8Array.of(0x00, 0x20), messageHash]),
  );
  toSpend.addOutput(scriptPubKey, 0n);
  const toSign = new bitcoin.Transaction();
  toSign.version = 0;
  toSign.addInput(toSpend.getHash(), 0, 0);
  toSign.addOutput(Uint8Array.of(0x6a), 0n);
  return toSign;
};

const bip322Wpkh = (
  priv: Uint8Array,
  pub: Uint8Array,
  message: string,
): { digest: Uint8Array; signature: string } => {
  const spk = bitcoin.payments.p2wpkh({ pubkey: pub }).output;
  const scriptCode = bitcoin.payments.p2pkh({ pubkey: pub }).output;
  if (spk === undefined || scriptCode === undefined) {
    throw new Error("payment without output");
  }
  const digest = bip322ToSign(spk, message).hashForWitnessV0(
    0,
    scriptCode,
    0n,
    bitcoin.Transaction.SIGHASH_ALL,
  );
  const der = bitcoin.script.signature.encode(
    ecc.sign(digest, priv),
    bitcoin.Transaction.SIGHASH_ALL,
  );
  return { digest, signature: smp([der, pub]) };
};

const legacyDigest = (message: string): Uint8Array => {
  const magic = Buffer.from("Bitcoin Signed Message:\n", "utf8");
  const body = Buffer.from(message, "utf8");
  return sha256(sha256(varint(magic.length), magic, varint(body.length), body));
};

const legacySign = (priv: Uint8Array, message: string): string => {
  const { signature, recoveryId } = ecc.signRecoverable(legacyDigest(message), priv);
  return Buffer.concat([Uint8Array.of(27 + 4 + recoveryId), signature]).toString("base64");
};

const checkPublishedBitcoinVectors = (): void => {
  const { bip322, legacyMessage: legacy } = read<BitcoinVectors>("vectors/chains/bitcoin.json");
  for (const row of bip322.simple.filter((r) => r.wif === undefined)) {
    const pair = ECPair.fromWIF(bip322.wif);
    if (pair.privateKey === undefined) {
      throw new Error("wif without key");
    }
    const ours = bip322Wpkh(pair.privateKey, pair.publicKey, row.message).signature;
    assert(row.signatures.includes(ours), `BIP-322 P2WPKH "${row.message}"`);
  }
  const pair = ECPair.fromWIF(legacy.wif);
  // Electrum's published signature is not RFC 6979-reproducible: check the digest and header rule
  // by recovering the key from it.
  const published = Buffer.from(legacy.signature, "base64");
  const recovered = ecc.recover(
    legacyDigest(legacy.message),
    published.subarray(1),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- header 31..34 → recovery id 0..3
    ((published[0] ?? 0) - 31) as 0 | 1 | 2 | 3,
    true,
  );
  assert(recovered !== null && hex(recovered) === hex(pair.publicKey), "Electrum legacy message");
};

const bitcoinMessageCases = (): unknown[] => {
  const message = "Hello World";
  const network = "bip122:000000000019d6689c085ae165831e93";
  const k84 = secpNode(btcPath(84));
  const wpkh = bip322Wpkh(k84.priv, k84.pub, message);
  const k86 = secpNode(btcPath(86));
  const x86 = k86.pub.slice(1);
  const tr = bitcoin.payments.p2tr({ internalPubkey: x86 });
  if (tr.output === undefined || tr.address === undefined) {
    throw new Error("payment without output");
  }
  const trDigest = bip322ToSign(tr.output, message).hashForWitnessV1(
    0,
    [tr.output],
    [0n],
    bitcoin.Transaction.SIGHASH_DEFAULT,
  );
  const tweaked = ECPair.fromPrivateKey(k86.priv).tweak(tapTweak(x86));
  const trSig = ecc.signSchnorr(trDigest, tweaked.privateKey ?? ZERO32, ZERO32);
  const k44 = secpNode(btcPath(44));
  return [
    {
      name: "bitcoin-message-bip322-p2wpkh",
      request: {
        kind: "bitcoin.message",
        network,
        address: bitcoin.payments.p2wpkh({ pubkey: k84.pub }).address,
        message,
        format: "bip322-simple",
      },
      key: { path: btcPath(84), publicKey: hex(k84.pub) },
      stages: [[ecdsa(btcPath(84), k84.pub, hex(wpkh.digest))]],
      artefact: wpkh.signature,
    },
    {
      name: "bitcoin-message-bip322-p2tr",
      request: {
        kind: "bitcoin.message",
        network,
        address: tr.address,
        message,
        format: "bip322-simple",
      },
      key: { path: btcPath(86), publicKey: hex(k86.pub) },
      stages: [
        [
          {
            scheme: "bip340",
            path: btcPath(86),
            publicKey: hex(tr.output.slice(2)),
            message: hex(trDigest),
            tweak: hex(tapTweak(x86)),
          },
        ],
      ],
      artefact: smp([trSig]),
    },
    {
      name: "bitcoin-message-legacy",
      request: {
        kind: "bitcoin.message",
        network,
        address: bitcoin.payments.p2pkh({ pubkey: k44.pub }).address,
        message,
        format: "legacy",
      },
      key: { path: btcPath(44), publicKey: hex(k44.pub) },
      stages: [[ecdsa(btcPath(44), k44.pub, hex(legacyDigest(message)))]],
      artefact: legacySign(k44.priv, message),
    },
  ];
};

const main = async (): Promise<void> => {
  checkPublishedBitcoinVectors();
  const cases = [
    ...(await evmCases()),
    ...tronCases(),
    ...(await solanaCases()),
    btcPsbtCase(
      "bitcoin-psbt-every-template",
      [{ purpose: 44 }, { purpose: 49 }, { purpose: 84 }, { purpose: 86 }],
      2,
    ),
    btcPsbtCase(
      "bitcoin-psbt-single-anyonecanpay",
      [
        { purpose: 84, sighash: 0x83 },
        { purpose: 86, sighash: 0x83 },
      ],
      2,
    ),
    ...bitcoinMessageCases(),
  ];
  const json = {
    source:
      "regenerate with `bun scripts/signing-plans-vectors.ts` from packages/wallet-chains — digests and signatures from viem 2.57.12, tronweb 6.5.2, bitcoinjs-lib 7.0.5 + tiny-secp256k1 2.2.5, @solana/kit 8.5.0; no project code",
    mnemonic: MNEMONIC,
    notes: [
      "stages: one array of tasks per dependent signing round (EIP-7702 has two); bytes are hex",
      'bip340 publicKey is the tweaked output key Q; tweak = TaggedHash("TapTweak", x(P))',
      "taproot artefacts are signed with a zero aux_rand; bitcoin.psbt artefacts list the per-input partialSig (DER ‖ sighash) or tapKeySig",
    ],
    cases,
  };
  writeFileSync(OUT, `${JSON.stringify(json, null, 1)}\n`);
  console.log(`wrote ${OUT} (${cases.length} cases)`);
};

await main();
