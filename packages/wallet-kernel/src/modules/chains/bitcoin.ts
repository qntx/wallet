/**
 * Bitcoin request preparation for `chain.sign` — every input's derivation entry must be this
 * account's, the prevout script must be that key's output, and change outputs are bound before the
 * PSBT's intent is decoded and its plan built. Never signs.
 */
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { hash160 } from "@scure/btc-signer/utils.js";

import type { DisplayIntent, TaskKey } from "@qntx/wallet-chains";
import {
  bitcoinNetwork,
  decodeBitcoinPsbt,
  decodeMessageTarget,
  normalizeBitcoin,
  planBitcoinMessage,
  planBitcoinPsbt,
} from "@qntx/wallet-chains/bitcoin";

import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import { messagePromptIntent } from "./prompt.ts";
import type { BitcoinRequest, Prepared } from "./shared.ts";
import { BTC_PURPOSE, deepEqual, mapChainError } from "./shared.ts";

const isPath = (path: unknown): path is number[] =>
  Array.isArray(path) && path.every((p) => typeof p === "number");

const hex = (bytes: Uint8Array): string =>
  bytes.reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");

/** The BIP-32 master fingerprint: first 4 bytes big-endian of hash160(master pubkey). */
const fingerprintOf = (pub: Uint8Array): number => {
  const h = hash160(pub);
  return new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(0);
};

type DerivationOwner = {
  bip32Derivation?: ReadonlyArray<readonly [Uint8Array, { fingerprint: number; path: number[] }]>;
  tapBip32Derivation?: ReadonlyArray<
    readonly [Uint8Array, { hashes: unknown; der: { fingerprint: unknown; path: unknown } }]
  >;
};

type Derivation = { pubkey: Uint8Array; fingerprint: number; path: ReadonlyArray<number> };

/**
 * The group context: the master fingerprint claims ownership, coin type and group index bound the
 * path shape `m/purpose'/coin'/group'/change/index` — the only shape this group may sign.
 */
type BitcoinDerive = {
  readonly material: PublicMaterial;
  readonly fingerprint: number;
  readonly coinType: number;
  readonly hardened: number;
  readonly groupIndex: number;
  readonly net: ReturnType<typeof bitcoinNetwork>;
};

const PURPOSES: ReadonlyArray<number> = [44, 49, 84, 86];

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

/**
 * The public key at `m/purpose'/coin'/group'/change/index` — the only path shape this group may
 * sign. The claim is validated before the key leaves the material.
 */
const childAt = async (
  b: BitcoinDerive,
  purpose: number,
  path: ReadonlyArray<number>,
): Promise<Uint8Array> => {
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
  return b.material.secp256k1(path);
};

/**
 * Ownership check for one `request.sign` entry: under the entry's own template, the derivation
 * entry must be this account's, the claimed pubkey the derived child's, and the prevout script
 * (witnessUtxo, or nonWitnessUtxo for P2PKH, plus redeemScript for P2SH-P2WPKH) the script of that
 * key. A template that disagrees with the input's script type fails the path or script check.
 */
const bitcoinInput = async (
  b: BitcoinDerive,
  tx: Transaction,
  entry: { readonly index: number; readonly template: string },
): Promise<{ index: number; key: TaskKey }> => {
  const purpose = BTC_PURPOSE[entry.template];
  if (purpose === undefined) {
    throw new KernelError("invalid-input", "sign template is not a bitcoin account template");
  }
  const { index: idx } = entry;
  const input = tx.getInput(idx);
  const der = derivationOf(input, b.fingerprint, purpose);
  if (der === undefined) {
    throw new KernelError("invalid-input", `input ${idx}: derivation entry is not this account's`);
  }
  const pub = await childAt(b, purpose, der.path);
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
  return { index: idx, key: { path: der.path, publicKey: pub } };
};

/**
 * Output binding, independent of which templates sign inputs: an output is this group's own when it
 * carries a derivation entry with our fingerprint — tap entries only for bip86, bip32 entries for
 * 44/49/84 — whose path is a valid `m/purpose'/coin'/group'/{0,1}/i` of this group and whose script
 * equals that key's script for the purpose. Failures just mean "not own".
 */
const bitcoinOwnScripts = async (b: BitcoinDerive, tx: Transaction): Promise<Set<string>> => {
  const ownScripts = new Set<string>();
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    if (output.script === undefined) {
      continue;
    }
    for (const purpose of PURPOSES) {
      const entry = derivationOf(output, b.fingerprint, purpose);
      if (entry === undefined) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- ownership checks keep output order
        const pub = await childAt(b, purpose, entry.path);
        if (deepEqual(output.script, expectedScript(purpose, pub))) {
          ownScripts.add(hex(output.script));
        }
      } catch (error) {
        // A cache miss on card material is a real answer, not "not ours" — the caller must tap.
        if (error instanceof KernelError && error.code === "card-required") {
          throw error;
        }
        continue;
      }
    }
  }
  return ownScripts;
};

/** The PSBT plan: input ownership, output binding, normalize, decode intent, then plan. */
const prepareBitcoinPsbt = async (
  b: BitcoinDerive,
  request: Extract<BitcoinRequest, { kind: "bitcoin.psbt" }>,
): Promise<Prepared> => {
  const tx = Transaction.fromPSBT(request.psbt);
  const inputs = [];
  for (const entry of request.sign) {
    // oxlint-disable-next-line no-await-in-loop -- input checks keep request order
    inputs.push(await bitcoinInput(b, tx, entry));
  }
  const ownScripts = await bitcoinOwnScripts(b, tx);
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
  let plan;
  try {
    plan = planBitcoinPsbt(request.psbt, inputs);
  } catch (error) {
    mapChainError(error);
  }
  return { prompt: intent, plan };
};

/** The message plan: the declared change/index must derive this address, then normalize/plan. */
const prepareBitcoinMessage = async (
  b: BitcoinDerive,
  purpose: number,
  request: Extract<BitcoinRequest, { kind: "bitcoin.message" }>,
): Promise<Prepared> => {
  if (request.format === "legacy" && purpose !== 44) {
    throw new KernelError("unsupported", "legacy message format is btc.bip44-only");
  }
  const path = [
    purpose + b.hardened,
    b.coinType + b.hardened,
    b.groupIndex + b.hardened,
    request.change,
    request.index,
  ];
  const pub = await childAt(b, purpose, path);
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
  let plan;
  try {
    plan = planBitcoinMessage(request, { path, publicKey: pub });
  } catch (error) {
    mapChainError(error);
  }
  return {
    prompt: {
      ...messagePromptIntent({ kind: "text", text: request.message }),
      family: "bitcoin",
    },
    plan,
  };
};

/**
 * Validates and decodes the request and returns its signing plan. The account's group index and the
 * request's per-sign-entry templates shape every derivation path.
 */
export const prepareBitcoin = async (
  request: BitcoinRequest,
  account: Extract<BitcoinRequest["account"], { kind: "hd" }>,
  material: PublicMaterial,
): Promise<Prepared> => {
  const net = bitcoinNetwork(request.network);
  const b: BitcoinDerive = {
    material,
    fingerprint: fingerprintOf(await material.secp256k1([])),
    coinType: net.coinType,
    hardened: 0x80000000,
    groupIndex: account.groupIndex,
    net,
  };
  if (request.kind === "bitcoin.psbt") {
    return prepareBitcoinPsbt(b, request);
  }
  const purpose = "template" in account ? BTC_PURPOSE[account.template] : undefined;
  if (purpose === undefined) {
    throw new KernelError("invalid-input", "account template is not a bitcoin template");
  }
  return prepareBitcoinMessage(b, purpose, request);
};
