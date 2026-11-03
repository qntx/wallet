/**
 * Bitcoin signing for `chain.sign` — every input's derivation entry must be this account's, the
 * prevout script must be that key's output, and change outputs are bound before the PSBT is signed
 * or its intent decoded.
 */
import { HDKey } from "@scure/bip32";
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import type { DisplayIntent } from "@qntx/wallet-chains";
import {
  bitcoinNetwork,
  decodeBitcoinPsbt,
  decodeMessageTarget,
  normalizeBitcoin,
} from "@qntx/wallet-chains/bitcoin";
import { signBitcoinMessage, signBitcoinPsbt } from "@qntx/wallet-chains/bitcoin/sign";

import { KernelError } from "../../errors.ts";
import { MESSAGE_INTENT } from "./prompt.ts";
import type { BitcoinRequest, ExecuteResult, HdAccount } from "./shared.ts";
import { BTC_PURPOSE, deepEqual, mapChainError } from "./shared.ts";

const isPath = (path: unknown): path is number[] =>
  Array.isArray(path) && path.every((p) => typeof p === "number");

const hex = (bytes: Uint8Array): string =>
  bytes.reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");

type DerivationOwner = {
  bip32Derivation?: ReadonlyArray<readonly [Uint8Array, { fingerprint: number; path: number[] }]>;
  tapBip32Derivation?: ReadonlyArray<
    readonly [Uint8Array, { hashes: unknown; der: { fingerprint: unknown; path: unknown } }]
  >;
};

type Derivation = { pubkey: Uint8Array; fingerprint: number; path: ReadonlyArray<number> };

/** The account derivation context: master, account node, tracked children and the template path. */
type BitcoinDerive = {
  readonly master: HDKey;
  readonly accountNode: HDKey;
  readonly children: HDKey[];
  readonly purpose: number;
  readonly coinType: number;
  readonly hardened: number;
  readonly account: HdAccount;
  readonly net: ReturnType<typeof bitcoinNetwork>;
};

/** The PSBT derivation entry that claims this account's fingerprint and path, if any. */
const derivationOf = (
  owner: DerivationOwner,
  fingerprint: number,
  purpose: number,
): Derivation | undefined => {
  if (purpose === 86) {
    const claimed = (der: {
      fingerprint: unknown;
      path: unknown;
    }): der is { fingerprint: number; path: number[] } =>
      der.fingerprint === fingerprint && isPath(der.path);
    for (const [key, value] of owner.tapBip32Derivation ?? []) {
      if (claimed(value.der)) {
        return { pubkey: key, fingerprint: value.der.fingerprint, path: value.der.path };
      }
    }
    return undefined;
  }
  for (const [key, value] of owner.bip32Derivation ?? []) {
    if (value.fingerprint === fingerprint) {
      return { pubkey: key, fingerprint: value.fingerprint, path: value.path };
    }
  }
  return undefined;
};

const expectedPub = (purpose: number, pub: Uint8Array): Uint8Array =>
  purpose === 86 ? pub.slice(1) : pub;

const expectedScript = (purpose: number, pub: Uint8Array): Uint8Array =>
  purpose === 86
    ? p2tr(pub.slice(1)).script
    : purpose === 49
      ? p2sh(p2wpkh(pub)).script
      : purpose === 44
        ? p2pkh(pub).script
        : p2wpkh(pub).script;

/** Derives `m/purpose'/coin'/group'/change/index` — the only path shape this account may sign. */
const childAt = (b: BitcoinDerive, path: ReadonlyArray<number>): HDKey => {
  const [purposePath, coinPath, groupPath, change, index] = path;
  if (
    path.length !== 5 ||
    purposePath !== b.purpose + b.hardened ||
    coinPath !== b.coinType + b.hardened ||
    groupPath !== b.account.groupIndex + b.hardened ||
    change === undefined ||
    index === undefined ||
    (change !== 0 && change !== 1) ||
    index < 0 ||
    index >= b.hardened
  ) {
    throw new KernelError("invalid-input", "derivation path is not this account's");
  }
  const child = b.accountNode.deriveChild(change).deriveChild(index);
  b.children.push(child);
  return child;
};

/**
 * Ownership check for one `request.sign` input: the derivation entry must be this account's, the
 * claimed pubkey the derived child's, and the prevout script (witnessUtxo, or nonWitnessUtxo for
 * P2PKH, plus redeemScript for P2SH-P2WPKH) the script of that key.
 */
const bitcoinInput = (
  b: BitcoinDerive,
  tx: Transaction,
  idx: number,
): { index: number; privateKey: Uint8Array } => {
  const input = tx.getInput(idx);
  const entry = derivationOf(input, b.master.fingerprint, b.purpose);
  if (entry === undefined) {
    throw new KernelError("invalid-input", `input ${idx}: derivation entry is not this account's`);
  }
  const child = childAt(b, entry.path);
  const pub = child.publicKey;
  const priv = child.privateKey;
  if (pub === null || priv === null) {
    throw new KernelError("integrity", "no key at derivation path");
  }
  if (!deepEqual(entry.pubkey, expectedPub(b.purpose, pub))) {
    throw new KernelError("invalid-input", `input ${idx}: derivation pubkey is not ours`);
  }
  // bip84/bip49 spend via witnessUtxo; bip44 (P2PKH) proves the
  // prevout via nonWitnessUtxo — the PSBT must carry the matching tx.
  if (b.purpose === 44) {
    if (input.nonWitnessUtxo === undefined) {
      throw new KernelError("invalid-input", `input ${idx}: P2PKH spend requires nonWitnessUtxo`);
    }
    const vout = input.index;
    const outs = input.nonWitnessUtxo.outputs as ReadonlyArray<{
      readonly script?: Uint8Array;
    }>;
    const prevScript = vout === undefined ? undefined : outs[vout]?.script;
    if (prevScript === undefined || !deepEqual(prevScript, expectedScript(b.purpose, pub))) {
      throw new KernelError(
        "invalid-input",
        `input ${idx}: nonWitnessUtxo prevout is not this key's`,
      );
    }
  } else {
    const prevout = input.witnessUtxo;
    if (prevout === undefined || !deepEqual(prevout.script, expectedScript(b.purpose, pub))) {
      throw new KernelError("invalid-input", `input ${idx}: prevout script is not this key's`);
    }
    if (
      b.purpose === 49 &&
      (input.redeemScript === undefined || !deepEqual(input.redeemScript, p2wpkh(pub).script))
    ) {
      throw new KernelError("invalid-input", `input ${idx}: redeemScript is not this key's`);
    }
  }
  return { index: idx, privateKey: priv };
};

/** Output binding: the scripts of outputs that look like this account's (its change addresses). */
const bitcoinOwnScripts = (b: BitcoinDerive, tx: Transaction): Set<string> => {
  const ownScripts = new Set<string>();
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    if (output.script === undefined) {
      continue;
    }
    const entry = derivationOf(output, b.master.fingerprint, b.purpose);
    if (entry === undefined) {
      continue;
    }
    try {
      const child = childAt(b, entry.path);
      const pub = child.publicKey;
      if (pub !== null && deepEqual(output.script, expectedScript(b.purpose, pub))) {
        ownScripts.add(hex(output.script));
      }
    } catch {
      continue;
    }
  }
  return ownScripts;
};

/** The PSBT path: input ownership, output binding, normalize, decode intent or sign. */
const executeBitcoinPsbt = (
  b: BitcoinDerive,
  request: Extract<BitcoinRequest, { kind: "bitcoin.psbt" }>,
  random: (len: number) => Uint8Array,
  intentOnly: boolean,
): ExecuteResult => {
  const tx = Transaction.fromPSBT(request.psbt);
  const inputs = request.sign.map((idx) => bitcoinInput(b, tx, idx));
  const ownScripts = bitcoinOwnScripts(b, tx);
  let normalized;
  try {
    normalized = normalizeBitcoin(request);
  } catch (error) {
    mapChainError(error);
  }
  if (!deepEqual(normalized, request)) {
    throw new KernelError("invalid-input", "request is not normalized");
  }
  let intent: DisplayIntent;
  try {
    intent = decodeBitcoinPsbt(request, ownScripts);
  } catch (error) {
    mapChainError(error);
  }
  if (intentOnly) {
    return { prompt: intent };
  }
  return {
    kind: "bitcoin.psbt",
    signedPsbt: signBitcoinPsbt(request.psbt, inputs, () => random(32)),
  };
};

/** The message path: the declared change/index must derive this address, then normalize/sign. */
const executeBitcoinMessage = (
  b: BitcoinDerive,
  request: Extract<BitcoinRequest, { kind: "bitcoin.message" }>,
  random: (len: number) => Uint8Array,
  intentOnly: boolean,
): ExecuteResult => {
  if (request.format === "legacy" && b.account.template !== "btc.bip44") {
    throw new KernelError("unsupported", "legacy message format is btc.bip44-only");
  }
  const child = childAt(b, [
    b.purpose + b.hardened,
    b.coinType + b.hardened,
    b.account.groupIndex + b.hardened,
    request.change,
    request.index,
  ]);
  const pub = child.publicKey;
  const priv = child.privateKey;
  if (pub === null || priv === null) {
    throw new KernelError("integrity", "no key at derivation path");
  }
  const derived =
    b.purpose === 86
      ? p2tr(pub.slice(1), undefined, b.net.params).address
      : b.purpose === 49
        ? p2sh(p2wpkh(pub, b.net.params), b.net.params).address
        : b.purpose === 44
          ? p2pkh(pub, b.net.params).address
          : p2wpkh(pub, b.net.params).address;
  if (derived !== request.address) {
    throw new KernelError("invalid-input", "address is not ours");
  }
  let normalized;
  try {
    normalized = normalizeBitcoin(request);
  } catch (error) {
    mapChainError(error);
  }
  if (!deepEqual(normalized, request)) {
    throw new KernelError("invalid-input", "request is not normalized");
  }
  try {
    decodeMessageTarget(request);
  } catch (error) {
    mapChainError(error);
  }
  if (intentOnly) {
    return { prompt: MESSAGE_INTENT };
  }
  return {
    kind: "bitcoin.message",
    signature: signBitcoinMessage(request, priv, () => random(32)),
  };
};

export const executeBitcoin = (
  random: (len: number) => Uint8Array,
  request: BitcoinRequest,
  account: HdAccount,
  seed: Uint8Array,
  intentOnly: boolean,
): ExecuteResult => {
  const net = bitcoinNetwork(request.network);
  const master = HDKey.fromMasterSeed(seed, net.bip32);
  try {
    const purpose = BTC_PURPOSE[account.template] ?? 84;
    const { coinType } = net;
    const hardened = 0x80000000;
    const accountNode = master.derive(`m/${purpose}'/${coinType}'/${account.groupIndex}'`);
    const children: HDKey[] = [];
    const b: BitcoinDerive = {
      master,
      accountNode,
      children,
      purpose,
      coinType,
      hardened,
      account,
      net,
    };
    try {
      if (request.kind === "bitcoin.psbt") {
        return executeBitcoinPsbt(b, request, random, intentOnly);
      }
      return executeBitcoinMessage(b, request, random, intentOnly);
    } finally {
      for (const child of children) {
        child.wipePrivateData();
      }
      accountNode.wipePrivateData();
    }
  } finally {
    master.wipePrivateData();
  }
};
