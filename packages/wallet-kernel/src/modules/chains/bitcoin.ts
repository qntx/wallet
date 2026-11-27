/**
 * Bitcoin request preparation for `chain.sign` — every input's derivation entry must be this
 * account's, the prevout script must be that key's output, and change outputs are bound before the
 * PSBT's intent is decoded and its plan built. Never signs.
 */
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import type { DisplayIntent, TaskKey } from "@qntx/wallet-chains";
import {
  bitcoinNetwork,
  decodeBitcoinPsbt,
  decodeMessageTarget,
  isDiscoverableChange,
  normalizeBitcoin,
  planBitcoinMessage,
  planBitcoinPsbt,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinOwn, BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";

import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import { pathString } from "./keys.ts";
import { messagePromptIntent } from "./prompt.ts";
import type { BitcoinRequest, Prepared } from "./shared.ts";
import { BTC_PURPOSE, deepEqual, mapChainError } from "./shared.ts";

const isPath = (path: unknown): path is number[] =>
  Array.isArray(path) && path.every((p) => typeof p === "number");

const hex = (bytes: Uint8Array): string =>
  bytes.reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");

/** The BIP-32 master fingerprint as the uint32 PSBT derivation entries carry. */
const fingerprintNumber = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

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
): Promise<{ index: number; key: TaskKey; tail: BitcoinPathTail }> => {
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
  return {
    index: idx,
    key: { path: der.path, publicKey: pub },
    tail: { purpose, change: der.path[3] ?? 0, index: der.path[4] ?? 0 },
  };
};

/**
 * Output binding, independent of which templates sign inputs: an output is this group's own when it
 * carries a derivation entry with our fingerprint — tap entries only for bip86, bip32 entries for
 * 44/49/84 — whose path is a valid `m/purpose'/coin'/group'/{0,1}/i` of this group and whose script
 * equals that key's script for the purpose. Failures just mean "not own". An own-key output the
 * serving entry never confirmed on the device is `unconfirmed` — a plain send with a danger
 * warning; it is never hidden, never worded as "your own address", and never touches the marks. A
 * verified, confirmed own output is hidden as change only when `isDiscoverableChange` says the
 * wallet can reach it — anything else is shown as a send to the user's own address at the unusual
 * path it names. The returned `hidden` map holds the highest change index each purpose hid — the
 * raise the request would commit; the caller seals it only for `internal` requests.
 */
const bitcoinOwn = async (
  b: BitcoinDerive,
  tx: Transaction,
  signed: ReadonlyArray<BitcoinPathTail>,
  markOf: (purpose: number) => number,
): Promise<{
  own: BitcoinOwn;
  hidden: Map<number, number>;
}> => {
  const change = new Set<string>();
  const unusual = new Map<string, string>();
  const unconfirmed = new Set<string>();
  const hidden = new Map<number, number>();
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
        if (!deepEqual(output.script, expectedScript(purpose, pub))) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- ownership checks keep output order
        if (!(await b.material.confirmed("secp256k1", entry.path))) {
          unconfirmed.add(hex(output.script));
          break;
        }
        const tail = { purpose, change: entry.path[3] ?? 0, index: entry.path[4] ?? 0 };
        if (isDiscoverableChange(tail, signed, markOf(purpose))) {
          change.add(hex(output.script));
          hidden.set(purpose, Math.max(hidden.get(purpose) ?? -1, tail.index));
        } else {
          unusual.set(hex(output.script), pathString(entry.path));
        }
        break;
      } catch (error) {
        // A miss on external material is a real answer, not "not ours" — the signer must serve.
        if (error instanceof KernelError && error.code === "device-required") {
          throw error;
        }
        continue;
      }
    }
  }
  return { own: { change, unusual, unconfirmed }, hidden };
};

/**
 * The PSBT plan: input ownership, output binding, normalize, decode intent, then plan. The hidden
 * change bound is the sealed mark alone — a signed input can name any path, so inputs never widen
 * it — and the raise an `internal` request commits after verification is exactly the change indexes
 * it hid. Only `internal` requests produce `changeMarks`: an external request may hide change
 * within the mark + gap window — the scan reaches it either way — but commits nothing, so no
 * outside caller can ratchet the sealed mark without broadcasting.
 */
const prepareBitcoinPsbt = async (
  b: BitcoinDerive,
  request: Extract<BitcoinRequest, { kind: "bitcoin.psbt" }>,
  storedMark: (purpose: number) => number,
): Promise<Prepared> => {
  const tx = Transaction.fromPSBT(request.psbt);
  const inputs = [];
  const signed: BitcoinPathTail[] = [];
  for (const entry of request.sign) {
    // oxlint-disable-next-line no-await-in-loop -- input checks keep request order
    const input = await bitcoinInput(b, tx, entry);
    inputs.push({ index: input.index, key: input.key });
    signed.push(input.tail);
  }
  const { own, hidden } = await bitcoinOwn(b, tx, signed, storedMark);
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
    intent = decodeBitcoinPsbt(request, own);
  } catch (error) {
    mapChainError(error);
  }
  let plan;
  try {
    plan = planBitcoinPsbt(request.psbt, inputs);
  } catch (error) {
    mapChainError(error);
  }
  // The raise is exactly what the request hid — the highest hidden change index per purpose.
  // `commitChangeMarks` ignores a raise that does not extend the stored mark, so a hidden index
  // at or below the seal costs no record write; an external request commits nothing either way.
  const raises =
    request.origin === "internal"
      ? [...hidden.entries()].map(([purpose, index]) => ({ purpose, index }))
      : [];
  return {
    prompt: intent,
    plan: { ...plan, hiddenChange: own.change },
    ...(raises.length > 0 ? { changeMarks: raises } : {}),
  };
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
  storedMark: (purpose: number) => number,
): Promise<Prepared> => {
  const net = bitcoinNetwork(request.network);
  const b: BitcoinDerive = {
    material,
    fingerprint: fingerprintNumber(await material.fingerprint()),
    coinType: net.coinType,
    hardened: 0x80000000,
    groupIndex: account.groupIndex,
    net,
  };
  if (request.kind === "bitcoin.psbt") {
    return prepareBitcoinPsbt(b, request, storedMark);
  }
  const purpose = "template" in account ? BTC_PURPOSE[account.template] : undefined;
  if (purpose === undefined) {
    throw new KernelError("invalid-input", "account template is not a bitcoin template");
  }
  return prepareBitcoinMessage(b, purpose, request);
};
