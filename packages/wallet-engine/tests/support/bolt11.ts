/* oxlint-disable eslint/no-bitwise -- byte packing for BOLT-11 tagged fields */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

// Minimal BOLT-11 encoder for tests: emits the tagged fields core/bolt11.ts decodes
// (p, s, d or h, x, c, r, n) and a real recoverable signature, so produced invoices pass
// signature verification.

const TAG_PAYMENT_HASH = 1;
const TAG_ROUTE_HINT = 3;
const TAG_EXPIRY = 6;
const TAG_FALLBACK = 9;
const TAG_DESCRIPTION = 13;
const TAG_PAYMENT_SECRET = 16;
const TAG_PAYEE = 19;
const TAG_DESCRIPTION_HASH = 23;
const TAG_MIN_FINAL_CLTV = 24;

const HRP_PREFIX: Record<string, string> = {
  mainnet: "lnbc",
  regtest: "lnbcrt",
  testnet: "lntb",
  signet: "lntbs",
};

export type TestRouteHintHop = {
  readonly publicKey: Uint8Array;
  readonly shortChannelId: Uint8Array;
};

export function bytesToWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) {
    words.push((acc << (5 - bits)) & 31);
  }
  return words;
}

/** 5-bit words → bytes, zero-padding the last partial byte (the decoder's signed form). */
export function wordsToBytesPadded(words: ReadonlyArray<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil((words.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (const word of words) {
    acc = ((acc << 5) | word) & 0xffffffff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out[index] = (acc >>> bits) & 0xff;
      index++;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out[index] = (acc << (8 - bits)) & 0xff;
  }
  return out;
}

/**
 * Bech32-encodes `hrp` + `dataWords` plus a 65-byte BOLT-11 signature. Given `signature` the bytes
 * are appended verbatim; otherwise a real recoverable signature over the hrp+data preimage is
 * produced with `secretKey` (recovery id overridable for malformed-signature probes).
 */
export function encodeRawBolt11(options: {
  readonly hrp: string;
  readonly dataWords: ReadonlyArray<number>;
  readonly secretKey?: Uint8Array | undefined;
  readonly recoveryId?: number | undefined;
  readonly signature?: Uint8Array | undefined;
}): string {
  const words = [...options.dataWords];
  let recoverable = options.signature;
  if (recoverable === undefined) {
    if (options.secretKey === undefined) {
      throw new Error("encodeRawBolt11 needs secretKey or signature");
    }
    const preimage = concatBytes(utf8ToBytes(options.hrp), wordsToBytesPadded(options.dataWords));
    const signature = secp256k1.sign(sha256(preimage), options.secretKey, {
      prehash: false,
      format: "recovered",
    });
    // noble packs recovery first; BOLT-11 appends it last.
    recoverable = new Uint8Array(65);
    recoverable.set(signature.subarray(1), 0);
    recoverable[64] = options.recoveryId ?? signature[0] ?? 0;
  }
  words.push(...bytesToWords(recoverable));
  return bech32.encode(options.hrp, words, false).toLowerCase();
}

/** Minimal big-endian base-32 words — BOLT-11 integer fields are words, not bytes. */
function minimalIntWords(value: number): number[] {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`test invoice: non-positive field value ${value}`);
  }
  const words: number[] = [];
  let v = value;
  while (v > 0) {
    words.unshift(v & 31);
    v = Math.floor(v / 32);
  }
  return words;
}

export function encodeTestBolt11(options: {
  readonly network?: "mainnet" | "regtest" | "testnet" | "signet" | undefined;
  /** Invoice amount in millisatoshis; omit for an amountless invoice. */
  readonly amountMsat?: bigint | undefined;
  readonly timestamp?: number | undefined;
  readonly paymentHash: Uint8Array;
  readonly paymentSecret?: Uint8Array | undefined;
  readonly description?: string | undefined;
  readonly descriptionHash?: Uint8Array | undefined;
  readonly expirySeconds?: number | undefined;
  readonly minFinalCltvExpiry?: number | undefined;
  readonly routeHints?: ReadonlyArray<ReadonlyArray<TestRouteHintHop>> | undefined;
  readonly fallbacks?: ReadonlyArray<{ version: number; program: Uint8Array }> | undefined;
  /**
   * Raw tagged fields emitted right after the timestamp, before the standard fields — for
   * malformed-field tests (e.g. a wrong-length `p` ahead of the real one).
   */
  readonly leadingFields?: ReadonlyArray<{ tag: number; data: ReadonlyArray<number> }> | undefined;
  /** Word data for the `p` field instead of `paymentHash`, for wrong-length probes. */
  readonly paymentHashData?: ReadonlyArray<number> | undefined;
  readonly secretKey: Uint8Array;
}): string {
  const prefix = HRP_PREFIX[options.network ?? "regtest"];
  // msat → pico-BTC: 1 p = 10 msat, so the hrp carries amountMsat × 10 p.
  const hrp = `${String(prefix)}${options.amountMsat === undefined ? "" : `${options.amountMsat * 10n}p`}`;

  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const words: number[] = [];
  for (let i = 6; i >= 0; i--) {
    words.push(Math.floor(timestamp / 32 ** i) & 31);
  }

  const field = (tag: number, data: ReadonlyArray<number>): void => {
    words.push(tag, Math.floor(data.length / 32), data.length % 32, ...data);
  };

  for (const leading of options.leadingFields ?? []) {
    field(leading.tag, leading.data);
  }

  field(TAG_PAYMENT_HASH, options.paymentHashData ?? bytesToWords(options.paymentHash));
  field(TAG_PAYMENT_SECRET, bytesToWords(options.paymentSecret ?? new Uint8Array(32).fill(2)));
  if (options.descriptionHash === undefined) {
    field(TAG_DESCRIPTION, bytesToWords(new TextEncoder().encode(options.description ?? "test")));
  } else {
    field(TAG_DESCRIPTION_HASH, bytesToWords(options.descriptionHash));
  }
  if (options.expirySeconds !== undefined) {
    field(TAG_EXPIRY, minimalIntWords(options.expirySeconds));
  }
  if (options.minFinalCltvExpiry !== undefined) {
    field(TAG_MIN_FINAL_CLTV, minimalIntWords(options.minFinalCltvExpiry));
  }
  for (const hint of options.routeHints ?? []) {
    const bytes: number[] = [];
    for (const hop of hint) {
      // fee_base_msat, fee_proportional_millionths, cltv_expiry_delta — zeroes suffice for tests.
      bytes.push(...hop.publicKey, ...hop.shortChannelId, ...new Uint8Array(10));
    }
    field(TAG_ROUTE_HINT, bytesToWords(new Uint8Array(bytes)));
  }
  for (const fallback of options.fallbacks ?? []) {
    field(TAG_FALLBACK, [fallback.version, ...bytesToWords(fallback.program)]);
  }
  const payee = secp256k1.getPublicKey(options.secretKey, true);
  field(TAG_PAYEE, bytesToWords(payee));

  return encodeRawBolt11({ hrp, dataWords: words, secretKey: options.secretKey });
}
