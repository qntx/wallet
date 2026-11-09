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
import type { BitcoinRequest, ExecuteResult } from "./shared.ts";
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

/** The account node of one BIP purpose and the children derived under it, for wiping. */
type PurposeDerive = {
  readonly accountNode: HDKey;
  readonly children: HDKey[];
};

/**
 * The group derivation context: purpose-specific account nodes (`m/purpose'/coin'/group'`) are
 * derived lazily — one PSBT may spend inputs of several templates of the same group.
 */
type BitcoinDerive = {
  readonly master: HDKey;
  readonly purposes: Map<number, PurposeDerive>;
  readonly coinType: number;
  readonly hardened: number;
  readonly groupIndex: number;
  readonly net: ReturnType<typeof bitcoinNetwork>;
};

const PURPOSES: ReadonlyArray<number> = [44, 49, 84, 86];

const contextFor = (b: BitcoinDerive, purpose: number): PurposeDerive => {
  let ctx = b.purposes.get(purpose);
  if (ctx === undefined) {
    ctx = {
      accountNode: b.master.derive(`m/${purpose}'/${b.coinType}'/${b.groupIndex}'`),
      children: [],
    };
    b.purposes.set(purpose, ctx);
  }
  return ctx;
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

/** Derives `m/purpose'/coin'/group'/change/index` — the only path shape this group may sign. */
const childAt = (b: BitcoinDerive, purpose: number, path: ReadonlyArray<number>): HDKey => {
  const [purposePath, coinPath, groupPath, change, index] = path;
  if (
    path.length !== 5 ||
    purposePath !== purpose + b.hardened ||
    coinPath !== b.coinType + b.hardened ||
    groupPath !== b.groupIndex + b.hardened ||
    change === undefined ||
    index === undefined ||
    (change !== 0 && change !== 1) ||
    index < 0 ||
    index >= b.hardened
  ) {
    throw new KernelError("invalid-input", "derivation path is not this account's");
  }
  const ctx = contextFor(b, purpose);
  const child = ctx.accountNode.deriveChild(change).deriveChild(index);
  ctx.children.push(child);
  return child;
};

/**
 * Ownership check for one `request.sign` entry: under the entry's own template, the derivation
 * entry must be this account's, the claimed pubkey the derived child's, and the prevout script
 * (witnessUtxo, or nonWitnessUtxo for P2PKH, plus redeemScript for P2SH-P2WPKH) the script of that
 * key. A template that disagrees with the input's script type fails the path or script check.
 */
const bitcoinInput = (
  b: BitcoinDerive,
  tx: Transaction,
  entry: { readonly index: number; readonly template: string },
): { index: number; privateKey: Uint8Array } => {
  const purpose = BTC_PURPOSE[entry.template];
  if (purpose === undefined) {
    throw new KernelError("invalid-input", "sign template is not a bitcoin account template");
  }
  const { index: idx } = entry;
  const input = tx.getInput(idx);
  const der = derivationOf(input, b.master.fingerprint, purpose);
  if (der === undefined) {
    throw new KernelError("invalid-input", `input ${idx}: derivation entry is not this account's`);
  }
  const child = childAt(b, purpose, der.path);
  const pub = child.publicKey;
  const priv = child.privateKey;
  if (pub === null || priv === null) {
    throw new KernelError("integrity", "no key at derivation path");
  }
  if (!deepEqual(der.pubkey, expectedPub(purpose, pub))) {
    throw new KernelError("invalid-input", `input ${idx}: derivation pubkey is not ours`);
  }
  // Non-taproot spends must carry nonWitnessUtxo (normalize requires it — a BIP-143 signature
  // commits only to its own input's amount); bip44 also proves the prevout script through it.
  // btc-signer already checked nonWitnessUtxo against the txid and any witnessUtxo at parse.
  if (purpose === 44) {
    if (input.nonWitnessUtxo === undefined) {
      throw new KernelError("invalid-input", `input ${idx}: P2PKH spend requires nonWitnessUtxo`);
    }
    const vout = input.index;
    const outs = input.nonWitnessUtxo.outputs as ReadonlyArray<{
      readonly script?: Uint8Array;
    }>;
    const prevScript = vout === undefined ? undefined : outs[vout]?.script;
    if (prevScript === undefined || !deepEqual(prevScript, expectedScript(purpose, pub))) {
      throw new KernelError(
        "invalid-input",
        `input ${idx}: nonWitnessUtxo prevout is not this key's`,
      );
    }
  } else {
    const prevout = input.witnessUtxo;
    if (prevout === undefined || !deepEqual(prevout.script, expectedScript(purpose, pub))) {
      throw new KernelError("invalid-input", `input ${idx}: prevout script is not this key's`);
    }
    if (
      purpose === 49 &&
      (input.redeemScript === undefined || !deepEqual(input.redeemScript, p2wpkh(pub).script))
    ) {
      throw new KernelError("invalid-input", `input ${idx}: redeemScript is not this key's`);
    }
  }
  return { index: idx, privateKey: priv };
};

/**
 * Output binding, independent of which templates sign inputs: an output is this group's own when it
 * carries a derivation entry with our fingerprint — tap entries only for bip86, bip32 entries for
 * 44/49/84 — whose path is a valid `m/purpose'/coin'/group'/{0,1}/i` of this group and whose script
 * equals that key's script for the purpose. Failures just mean "not own".
 */
const bitcoinOwnScripts = (b: BitcoinDerive, tx: Transaction): Set<string> => {
  const ownScripts = new Set<string>();
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    if (output.script === undefined) {
      continue;
    }
    for (const purpose of PURPOSES) {
      const entry = derivationOf(output, b.master.fingerprint, purpose);
      if (entry === undefined) {
        continue;
      }
      try {
        const child = childAt(b, purpose, entry.path);
        const pub = child.publicKey;
        if (pub !== null && deepEqual(output.script, expectedScript(purpose, pub))) {
          ownScripts.add(hex(output.script));
        }
      } catch {
        continue;
      }
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
  const inputs = request.sign.map((entry) => bitcoinInput(b, tx, entry));
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
  purpose: number,
  request: Extract<BitcoinRequest, { kind: "bitcoin.message" }>,
  random: (len: number) => Uint8Array,
  intentOnly: boolean,
): ExecuteResult => {
  if (request.format === "legacy" && purpose !== 44) {
    throw new KernelError("unsupported", "legacy message format is btc.bip44-only");
  }
  const child = childAt(b, purpose, [
    purpose + b.hardened,
    b.coinType + b.hardened,
    b.groupIndex + b.hardened,
    request.change,
    request.index,
  ]);
  const pub = child.publicKey;
  const priv = child.privateKey;
  if (pub === null || priv === null) {
    throw new KernelError("integrity", "no key at derivation path");
  }
  const derived =
    purpose === 86
      ? p2tr(pub.slice(1), undefined, b.net.params).address
      : purpose === 49
        ? p2sh(p2wpkh(pub, b.net.params), b.net.params).address
        : purpose === 44
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
  account: { readonly groupIndex: number },
  seed: Uint8Array,
  intentOnly: boolean,
): ExecuteResult => {
  const net = bitcoinNetwork(request.network);
  const master = HDKey.fromMasterSeed(seed, net.bip32);
  const b: BitcoinDerive = {
    master,
    purposes: new Map(),
    coinType: net.coinType,
    hardened: 0x80000000,
    groupIndex: account.groupIndex,
    net,
  };
  try {
    if (request.kind === "bitcoin.psbt") {
      return executeBitcoinPsbt(b, request, random, intentOnly);
    }
    if (request.account.kind !== "hd") {
      throw new KernelError("unsupported", "imported accounts are not yet supported");
    }
    const purpose = BTC_PURPOSE[request.account.template];
    if (purpose === undefined) {
      throw new KernelError("invalid-input", "account template is not a bitcoin template");
    }
    return executeBitcoinMessage(b, purpose, request, random, intentOnly);
  } finally {
    for (const ctx of b.purposes.values()) {
      for (const child of ctx.children) {
        child.wipePrivateData();
      }
      ctx.accountNode.wipePrivateData();
    }
    master.wipePrivateData();
  }
};
