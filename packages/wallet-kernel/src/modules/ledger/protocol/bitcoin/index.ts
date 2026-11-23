/**
 * Bitcoin app client (CLA `0xE1`, P2 protocol version 1 — doc/bitcoin.md "Framework"/"Commands";
 * the call shapes mirror bitcoin_client_js/src/lib/appClient.ts). Only the four default wallet
 * policies of doc/wallet.md are supported — registered wallets, multisig, tapscript and MuSig2 are
 * out of scope. The pinned app is the mainnet build (Makefile `COIN=bitcoin`: BIP32_PUBKEY_VERSION
 * 0x0488B21E, coin type 0', "bc" segwit prefix).
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { taprootTweakPubkey } from "@scure/btc-signer/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinAddressFromXpub, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";

import type { Command, Exchange } from "../apdu.ts";
import { transmit } from "../apdu.ts";
import { encodePath, input, Reader, u32, varint } from "../bytes.ts";
import { LedgerError } from "../errors.ts";
import {
  interact,
  knownList,
  knownMapping,
  knownWalletPolicy,
  maxRounds,
  newKnown,
} from "./client.ts";
import { leafHash, merkleRoot } from "./merkle.ts";
import type { BitcoinPolicy, ParsedPolicyKey } from "./policy.ts";
import { MAINNET_BIP32, policyId, policyKey } from "./policy.ts";
import { mapCommitment, psbtV2Maps } from "./psbt.ts";
import type { KeyValue } from "./psbt.ts";

const CLA = 0xe1;
const PROTOCOL_VERSION = 1; // doc/bitcoin.md "APDUs" — P2 on every command

const INS_GET_EXTENDED_PUBKEY = 0x00;
const INS_GET_WALLET_ADDRESS = 0x03;
const INS_SIGN_PSBT = 0x04;
const INS_GET_MASTER_FINGERPRINT = 0x05;
const INS_SIGN_MESSAGE = 0x10;

// MAX_BIP32_PATH_STEPS in src/constants.h (8 BIP-388 steps + change/index).
const MAX_PATH_DEPTH = 10;
// MAX_BIP44_ADDRESS_INDEX_RECOMMENDED in src/constants.h.
const MAX_ADDRESS_INDEX = 50_000;
// doc/bitcoin.md SIGN_MESSAGE — the message is committed as a Merkle tree of 64-byte chunks.
const MESSAGE_CHUNK = 64;
// The mainnet BIP-122 network id — wallet-chains/src/bitcoin/networks.ts NETWORKS[0].
const MAINNET = "bip122:000000000019d6689c085ae165831e93";

// BIP-174/371 key types carrying the derivation information a yielded key must match.
const PSBT_IN_BIP32_DERIVATION = 0x06;
const PSBT_IN_TAP_BIP32_DERIVATION = 0x16;

const CHAINS_TEMPLATE = {
  "pkh(@0/**)": "btc.bip44",
  "sh(wpkh(@0/**))": "btc.bip49",
  "wpkh(@0/**)": "btc.bip84",
  "tr(@0/**)": "btc.bip86",
} as const;

const invalid = (message: string): LedgerError => new LedgerError("invalid-response", message);

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const PRINTABLE = (byte: number): boolean => byte >= 0x20 && byte <= 0x7e;

const asciiReply = (data: Uint8Array): string => {
  if (!data.every(PRINTABLE)) {
    throw invalid("a response string is not printable ASCII");
  }
  return new TextDecoder().decode(data);
};

const command = (ins: number, data: Uint8Array): Command => ({
  cla: CLA,
  ins,
  p1: 0x00,
  p2: PROTOCOL_VERSION,
  data,
});

/** `E1 05 00 01` → the 4-byte master fingerprint (doc/bitcoin.md GET_MASTER_FINGERPRINT). */
export async function btcMasterFingerprint(exchange: Exchange): Promise<Uint8Array> {
  const data = await transmit(
    exchange,
    "bitcoin",
    command(INS_GET_MASTER_FINGERPRINT, new Uint8Array(0)),
  );
  if (data.length !== 4) {
    throw invalid("the master fingerprint is not 4 bytes");
  }
  return Uint8Array.from(data);
}

/**
 * `E1 00 00 01` — `display ‖ n ‖ path` → the ASCII xpub at `path` (doc/bitcoin.md
 * GET_EXTENDED_PUBKEY). The returned extended key must decode as a mainnet xpub whose depth and
 * child index match the request — a wrong key is `invalid-response`.
 */
export async function btcExtendedPublicKey(
  exchange: Exchange,
  path: KeyPath,
  display: boolean,
): Promise<string> {
  const last = path.at(-1);
  if (last === undefined) {
    throw input("the derivation path is empty");
  }
  const data = await transmit(
    exchange,
    "bitcoin",
    command(
      INS_GET_EXTENDED_PUBKEY,
      concat(Uint8Array.of(display ? 1 : 0), encodePath(path, MAX_PATH_DEPTH)),
    ),
  );
  const xpub = asciiReply(data);
  const key = ((): HDKey => {
    try {
      return HDKey.fromExtendedKey(xpub, MAINNET_BIP32);
    } catch {
      throw invalid("the extended pubkey does not decode");
    }
  })();
  if (key.depth !== path.length || key.index !== last) {
    throw invalid("the extended pubkey does not match the requested path");
  }
  return xpub;
}

/** The local address for `policy` at `change`/`index` — the device reply must equal it. */
const expectedAddress = (policy: BitcoinPolicy, change: 0 | 1, index: number): string => {
  const { xpub } = policyKey(policy);
  return bitcoinAddressFromXpub(xpub, CHAINS_TEMPLATE[policy.template], MAINNET, change, index);
};

/**
 * `E1 03 00 01` — `display ‖ policyId ‖ 32×00 (default-wallet HMAC) ‖ change ‖ u32 index` → the
 * ASCII address (doc/bitcoin.md GET_WALLET_ADDRESS). doc/wallet.md caps the default-wallet index at
 * 50000; the reply must equal the address derived from the policy key locally.
 */
export async function btcWalletAddress(
  exchange: Exchange,
  policy: BitcoinPolicy,
  change: 0 | 1,
  index: number,
  display: boolean,
): Promise<string> {
  if (change !== 0 && change !== 1) {
    throw input("change must be 0 or 1");
  }
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ADDRESS_INDEX) {
    throw input("the address index is out of range");
  }
  const expected = expectedAddress(policy, change, index);
  const known = newKnown();
  knownWalletPolicy(known, policy);
  const { data } = await interact(
    exchange,
    command(
      INS_GET_WALLET_ADDRESS,
      concat(
        Uint8Array.of(display ? 1 : 0),
        policyId(policy),
        new Uint8Array(32),
        Uint8Array.of(change),
        u32(index),
      ),
    ),
    known,
    maxRounds(known),
  );
  const address = asciiReply(data);
  if (address !== expected) {
    throw invalid("the device address does not match the policy key");
  }
  return address;
}

/**
 * A `bip32Derivation`/`tapBip32Derivation` value — `fpr4 ‖ u32le path[]`, prefixed by a varint
 * tapleaf-hash list under BIP-371. Returns undefined when the entry does not parse.
 */
const derivationOf = (
  value: Uint8Array,
  taproot: boolean,
): { fingerprint: Uint8Array; path: ReadonlyArray<number> } | undefined => {
  try {
    const reader = new Reader(value);
    if (taproot) {
      reader.bytes(reader.varint() * 32);
    }
    const fingerprint = reader.bytes(4);
    const path: number[] = [];
    while (reader.remaining > 0) {
      // BIP-174 derivation steps are u32 little-endian (unlike the app's own big-endian APDU
      // path encoding).
      const step = reader.bytes(4);
      path.push(new DataView(step.buffer, step.byteOffset, 4).getUint32(0, true));
    }
    return { fingerprint, path };
  } catch {
    return undefined;
  }
};

/**
 * `path` must be `policy.account ‖ change ‖ index` with a non-hardened tail — the only keys a
 * default policy derives (`@0/**`). Returns the expected public key form (33-byte compressed, or
 * 32-byte x-only for the taproot template), or undefined when the entry does not name this policy.
 */
const policyChild = (
  path: ReadonlyArray<number>,
  parsed: ParsedPolicyKey,
  taproot: boolean,
): Uint8Array | undefined => {
  const { account, xpub } = parsed;
  if (path.length !== account.length + 2 || !account.every((step, i) => path[i] === step)) {
    return undefined;
  }
  const change = path.at(-2);
  const index = path.at(-1);
  if ((change !== 0 && change !== 1) || index === undefined || index >= 0x80_00_00_00) {
    return undefined;
  }
  // Only bip86's return form differs (x-only); the other templates share the compressed form.
  return bitcoinPubkeyFromXpub(xpub, taproot ? "btc.bip86" : "btc.bip84", MAINNET, change, index);
};

/**
 * The yielded `pubkey` must be the key the input's own derivation fields claim under the policy —
 * the ownership check doc/wallet.md's key origin performs on the device. For ECDSA the yield
 * carries the derivation entry's compressed pubkey; for a taproot key-path spend it carries the
 * _tweaked output key_ while `tapBip32Derivation` is keyed by the internal x-only key (BIP-371), so
 * the match is `tweak(derive(path))` — verified live against the pinned 2.5.1 app.
 */
const ownKey = (
  kvs: ReadonlyArray<KeyValue>,
  pubkey: Uint8Array,
  parsed: ParsedPolicyKey,
): void => {
  if (pubkey.length === 32) {
    for (const { key, value } of kvs) {
      if (key.length !== 33 || key[0] !== PSBT_IN_TAP_BIP32_DERIVATION) {
        continue;
      }
      const derivation = derivationOf(value, true);
      if (derivation === undefined || !equalBytes(derivation.fingerprint, parsed.fingerprint)) {
        continue;
      }
      const internal = policyChild(derivation.path, parsed, true);
      if (internal === undefined || !equalBytes(internal, key.subarray(1))) {
        continue;
      }
      const [tweaked] = taprootTweakPubkey(internal, new Uint8Array());
      if (equalBytes(tweaked, pubkey)) {
        return;
      }
    }
    throw invalid("the yielded pubkey does not belong to the wallet policy");
  }
  for (const { key, value } of kvs) {
    if (
      key.length !== 34 ||
      key[0] !== PSBT_IN_BIP32_DERIVATION ||
      !equalBytes(key.subarray(1), pubkey)
    ) {
      continue;
    }
    const derivation = derivationOf(value, false);
    if (derivation === undefined || !equalBytes(derivation.fingerprint, parsed.fingerprint)) {
      continue;
    }
    const expected = policyChild(derivation.path, parsed, false);
    if (expected !== undefined && equalBytes(expected, pubkey)) {
      return;
    }
  }
  throw invalid("the yielded pubkey does not belong to the wallet policy");
};

export type BitcoinYield = {
  readonly input: number;
  readonly publicKey: Uint8Array;
  /** DER ‖ sighash byte for ECDSA; a 64/65-byte Schnorr signature for taproot key path. */
  readonly signature: Uint8Array;
};

/**
 * One YIELD item: `varint tagOrInput ‖ u8 pubkeyAugmLen ‖ pubkeyAugm ‖ signature` (doc/bitcoin.md
 * SIGN_PSBT, src/handler/sign_psbt/sign_input.c yield_signature). Tags above 65535 are MuSig2
 * frames and a 64-byte pubkey augmentation is a tapscript spend — neither exists under the single-
 * key default policies this client supports, so both are `invalid-response`.
 */
const parseYield = (
  item: Uint8Array,
  inputs: ReadonlyArray<ReadonlyArray<KeyValue>>,
): { input: number; pubkey: Uint8Array; signature: Uint8Array; kvs: ReadonlyArray<KeyValue> } => {
  const reader = new Reader(item);
  const index = reader.varint();
  if (index > 0xff_ff) {
    throw invalid("a yielded tag is not a signature under a default policy");
  }
  const kvs = inputs[index];
  if (kvs === undefined) {
    throw invalid("a yielded input index is out of range");
  }
  const pubkey = reader.bytes(reader.u8());
  const signature = reader.rest();
  reader.end();
  if (pubkey.length === 64) {
    throw invalid("tapscript signatures are not supported");
  }
  if (pubkey.length === 33) {
    try {
      secp256k1.Signature.fromBytes(signature.subarray(0, -1), "der");
    } catch {
      throw invalid("the yielded ECDSA signature is not DER plus a sighash byte");
    }
    return { input: index, pubkey, signature, kvs };
  }
  if (pubkey.length === 32) {
    if (signature.length !== 64 && signature.length !== 65) {
      throw invalid("the yielded taproot signature is not 64 or 65 bytes");
    }
    return { input: index, pubkey, signature, kvs };
  }
  throw invalid("the yielded pubkey is not 32 or 33 bytes");
};

/**
 * `E1 04 00 01` — the merkleized global/input/output map commitments plus `policyId ‖ 32×00`
 * (doc/bitcoin.md SIGN_PSBT); signatures arrive through YIELD. Every yield is re-validated: input
 * index in range, pubkey shape, DER-plus-sighash or 64/65-byte signature, no duplicate (input,
 * pubkey) pair, and the key must belong to the policy.
 */
export async function btcSignPsbt(
  exchange: Exchange,
  psbt: Uint8Array,
  policy: BitcoinPolicy,
): Promise<ReadonlyArray<BitcoinYield>> {
  const parsed = policyKey(policy);
  const maps = psbtV2Maps(psbt);
  const inputCommitments = maps.inputs.map((m) => mapCommitment(m));
  const outputCommitments = maps.outputs.map((m) => mapCommitment(m));
  const known = newKnown();
  knownWalletPolicy(known, policy);
  knownMapping(known, maps.global);
  for (const map of maps.inputs) {
    knownMapping(known, map);
  }
  for (const map of maps.outputs) {
    knownMapping(known, map);
  }
  knownList(known, inputCommitments);
  knownList(known, outputCommitments);
  const { yielded } = await interact(
    exchange,
    command(
      INS_SIGN_PSBT,
      concat(
        mapCommitment(maps.global),
        varint(maps.inputs.length),
        merkleRoot(inputCommitments.map((c) => leafHash(c))),
        varint(maps.outputs.length),
        merkleRoot(outputCommitments.map((c) => leafHash(c))),
        policyId(policy),
        new Uint8Array(32),
      ),
    ),
    known,
    maxRounds(known),
  );
  const seen = new Set<string>();
  const out: BitcoinYield[] = [];
  for (const item of yielded) {
    const yield1 = parseYield(item, maps.inputs);
    const tag = `${String(yield1.input)}:${bytesToHex(yield1.pubkey)}`;
    if (seen.has(tag)) {
      throw invalid("a signature was yielded twice for the same input and key");
    }
    seen.add(tag);
    ownKey(yield1.kvs, yield1.pubkey, parsed);
    out.push({ input: yield1.input, publicKey: yield1.pubkey, signature: yield1.signature });
  }
  return out;
}

/**
 * `E1 10 00 01` — `n ‖ path ‖ varint len ‖ merkleRoot(64-byte chunks)` → exactly 65 bytes
 * (doc/bitcoin.md SIGN_MESSAGE). The first byte is `27 + 4 + parity` in the pinned source
 * (src/handler/sign_message.c — 31 or 32); r‖s follows.
 */
export async function btcSignMessage(
  exchange: Exchange,
  path: KeyPath,
  message: Uint8Array,
): Promise<{ readonly header: number; readonly signature: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < message.length; offset += MESSAGE_CHUNK) {
    chunks.push(message.subarray(offset, offset + MESSAGE_CHUNK));
  }
  const known = newKnown();
  knownList(known, chunks);
  const { data } = await interact(
    exchange,
    command(
      INS_SIGN_MESSAGE,
      concat(
        encodePath(path, MAX_PATH_DEPTH),
        varint(message.length),
        merkleRoot(chunks.map((c) => leafHash(c))),
      ),
    ),
    known,
    maxRounds(known),
  );
  if (data.length !== 65) {
    throw invalid("the message signature is not 65 bytes");
  }
  const [header] = data;
  if (header !== 31 && header !== 32) {
    throw invalid("the message signature header is invalid");
  }
  return { header, signature: data.subarray(1) };
}
