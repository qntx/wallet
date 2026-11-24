/**
 * OPEN (protocol.md §8.1–8.2) and the §8.4 secure session. One request/response record pair per
 * inner command, AES-128 CBC + CMAC under the four session keys, u16 counters. The session is torn
 * down — keys wiped, every further call `session-broken` — on any framing or cryptographic failure,
 * after an inner `6F00`, or after the response that uses `ctr = 0xFFFF`.
 */
import { cbc, cmac, ecb } from "@noble/ciphers/aes.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";

import { ascii, readSw, u16, validUncompressedPoint, wipe } from "./bytes.ts";
import type { Inner } from "./commands.ts";
import { CardError } from "./errors.ts";
import { cardId, verifyCertificate } from "./identity.ts";
import type { Anchor } from "./identity.ts";
import { kdf, m2, unM2 } from "./kdf.ts";

const INS_OPEN = 0x10;
const INS_SESSION = 0x12;
const MAX_RANDOM_DRAWS = 8;
const COUNTER_MAX = 0xffff;
const LABEL_SESSION = ascii("qntx-card/v1/session");
const LABEL_KDF_SESSION = ascii("qntx-card/v1/kdf-session");

/** `00 A4 04 00 07 F0716E74780101 00` — SELECT the wallet applet by its AID (§6). */
export const SELECT_APDU: Uint8Array = hexToBytes("00a4040007f0716e7478010100");

/** The plaintext form an unwrapped response record takes: `data ‖ SW1 ‖ SW2` (§8.4). */
export type InnerResponse = {
  readonly data: Uint8Array;
  readonly sw: number;
};

export type Session = {
  /** The card's identity key A: cert `[0..33)`, a compressed secp256k1 point. */
  readonly identity: Uint8Array;
  /** The certificate exactly as the card presented it: `A ‖ r ‖ s`. */
  readonly cert: Uint8Array;
  /** `ID(A)` — the 16-byte card ID. */
  readonly cardId: Uint8Array;
  /** Batch name of the anchor that verified the certificate. */
  readonly batch: string;
  /** `SHA-256(cardEph)[0..8)` — what `recentEphemerals` compares against. */
  readonly ephemeralTag: Uint8Array;
  readonly closed: boolean;
  /** Wraps an inner command into its §8.4 SESSION command APDU. */
  wrap: (command: Inner) => Uint8Array;
  /** Unwraps a SESSION response APDU into `{ data, sw }`; tears the session down per §8.4. */
  unwrap: (rapdu: Uint8Array) => InnerResponse;
  /** Wipes the session keys; idempotent. */
  close: () => void;
};

/**
 * Draws a host ephemeral secret and returns the `80 10 00 00 41 hostEph 00` OPEN APDU. `random` is
 * the injected randomness; invalid draws are wiped and retried — after 8 the source is treated as
 * broken (`invalid-input`).
 */
export function openRequest(random: (n: number) => Uint8Array): {
  apdu: Uint8Array;
  secret: Uint8Array;
} {
  for (let draw = 0; draw < MAX_RANDOM_DRAWS; draw += 1) {
    const secret = random(32);
    if (!secp256k1.utils.isValidSecretKey(secret)) {
      wipe(secret);
      continue;
    }
    const hostEph = secp256k1.getPublicKey(secret, false);
    return {
      apdu: concatBytes(
        new Uint8Array([0x80, INS_OPEN, 0x00, 0x00, 0x41]),
        hostEph,
        new Uint8Array([0x00]),
      ),
      secret,
    };
  }
  throw new CardError("invalid-input", "random source did not yield a valid scalar");
}

/**
 * Verifies the card's OPEN response (`cardEph ‖ sig ‖ cert ‖ 9000`, §8.1) and derives the session
 * keys. `secret` and the ECDH output are wiped on every path; every failure of the response itself
 * is `card-not-genuine` — except a repeated `cardEph`, which is `card-fault`.
 */
export function openResponse(
  secret: Uint8Array,
  request: Uint8Array,
  response: Uint8Array,
  anchors: ReadonlyArray<Anchor>,
  recentEphemerals: ReadonlyArray<Uint8Array>,
): Session {
  let shared: Uint8Array | undefined;
  try {
    if (!secp256k1.utils.isValidSecretKey(secret)) {
      throw new CardError("invalid-input", "host ephemeral is not a valid scalar");
    }
    const hostEph = secp256k1.getPublicKey(secret, false);
    const expectedRequest = concatBytes(
      new Uint8Array([0x80, INS_OPEN, 0x00, 0x00, 0x41]),
      hostEph,
      new Uint8Array([0x00]),
    );
    if (!equalBytes(request, expectedRequest)) {
      throw new CardError("invalid-input", "request does not carry the host ephemeral");
    }
    if (response.length >= 2 && readSw(response) === 0x6283) {
      // §4.3 — the card never finished personalisation init; the wallet never initialises one.
      throw new CardError("card-not-genuine", "the card is not initialised", 0x6283);
    }
    if (response.length !== 228 || response.at(-2) !== 0x90 || response.at(-1) !== 0x00) {
      throw new CardError(
        "card-not-genuine",
        "OPEN response is not 226 bytes + 9000",
        response.length >= 2 ? readSw(response) : undefined,
      );
    }
    const cardEph = response.subarray(0, 65);
    const signature = response.subarray(65, 129);
    const cert = response.subarray(129, 226);
    const { identity, batch } = verifyCertificate(cert, anchors);
    if (!validUncompressedPoint(cardEph)) {
      throw new CardError("card-not-genuine", "cardEph is not a valid uncompressed point");
    }
    const transcriptHash = sha256(concatBytes(LABEL_SESSION, hostEph, cardEph, identity));
    if (!secp256k1.verify(signature, transcriptHash, identity, { prehash: false, lowS: false })) {
      throw new CardError("card-not-genuine", "session signature does not verify");
    }
    const ephemeralTag = sha256(cardEph).subarray(0, 8);
    if (recentEphemerals.some((seen) => equalBytes(seen, ephemeralTag))) {
      throw new CardError("card-fault", "cardEph repeats a recently seen value");
    }
    shared = secp256k1.getSharedSecret(secret, cardEph, true);
    const keys = kdf(shared.subarray(1, 33), LABEL_KDF_SESSION, transcriptHash, 64);
    return sessionFromKeys(keys, identity, cert, batch, ephemeralTag);
  } finally {
    wipe(secret);
    if (shared !== undefined) {
      wipe(shared);
    }
  }
}

class CardSession implements Session {
  readonly identity: Uint8Array;
  readonly cert: Uint8Array;
  readonly cardId: Uint8Array;
  readonly batch: string;
  readonly ephemeralTag: Uint8Array;
  #keys: Uint8Array | undefined;
  #sent = 0;
  #received = 0;

  constructor(
    keys: Uint8Array,
    identity: Uint8Array,
    cert: Uint8Array,
    batch: string,
    ephemeralTag: Uint8Array,
  ) {
    this.#keys = keys;
    this.identity = identity;
    this.cert = cert;
    this.cardId = cardId(identity);
    this.batch = batch;
    this.ephemeralTag = ephemeralTag;
  }

  get closed(): boolean {
    return this.#keys === undefined;
  }

  wrap(command: Inner): Uint8Array {
    checkInner(command);
    const keys = this.#open();
    if (this.#sent > COUNTER_MAX) {
      this.#break("command counter exhausted");
    }
    const counter = this.#sent;
    const kce = keys.subarray(0, 16);
    const plaintext = concatBytes(
      new Uint8Array([command.ins, command.p1, command.p2]),
      command.data,
    );
    const padded = m2(plaintext);
    wipe(plaintext);
    let ciphertext: Uint8Array;
    try {
      ciphertext = cbc(kce, recordIv(kce, 0x01, counter), { disablePadding: true }).encrypt(padded);
    } finally {
      wipe(padded);
    }
    const tag = cmac(concatBytes(u16(counter), ciphertext), keys.subarray(16, 32)).subarray(0, 8);
    this.#sent = counter + 1;
    return concatBytes(
      new Uint8Array([0x80, INS_SESSION, 0x00, 0x00, ciphertext.length + tag.length]),
      ciphertext,
      tag,
      new Uint8Array([0x00]),
    );
  }

  unwrap(rapdu: Uint8Array): InnerResponse {
    const keys = this.#open();
    if (this.#received >= this.#sent) {
      this.#break("no command awaiting a response");
    }
    if (rapdu.length < 2) {
      this.#break("response is shorter than a status word");
    }
    const sw = readSw(rapdu);
    if (sw !== 0x9000) {
      this.#break("secure-messaging status is not 9000", sw);
    }
    const bodyLength = rapdu.length - 10; // ciphertext ‖ tag(8) ‖ sw(2)
    // bodies shorter than one block still fail: %16 catches nonzero lengths, a length-0 body
    // fails the MAC check below (no card MACs an empty ciphertext for this counter)
    if (bodyLength % 16 !== 0 || bodyLength > 240) {
      this.#break("response ciphertext has an invalid length");
    }
    const ciphertext = rapdu.subarray(0, bodyLength);
    const tag = rapdu.subarray(bodyLength, -2);
    const counter = this.#received;
    const expected = cmac(concatBytes(u16(counter), ciphertext), keys.subarray(48, 64)).subarray(
      0,
      8,
    );
    if (!equalBytes(tag, expected)) {
      this.#break("response MAC does not verify");
    }
    const kre = keys.subarray(32, 48);
    const padded = cbc(kre, recordIv(kre, 0x02, counter), { disablePadding: true }).decrypt(
      ciphertext,
    );
    try {
      const plaintext = unM2(padded);
      if (plaintext === undefined || plaintext.length < 2) {
        this.#break("response padding is malformed");
      }
      this.#received = counter + 1;
      const response: InnerResponse = {
        data: new Uint8Array(plaintext.subarray(0, -2)),
        sw: readSw(plaintext),
      };
      if (response.sw === 0x6f00 || counter === COUNTER_MAX) {
        this.#teardown();
      }
      return response;
    } finally {
      wipe(padded);
    }
  }

  close(): void {
    this.#teardown();
  }

  #open(): Uint8Array {
    const keys = this.#keys;
    if (keys === undefined) {
      this.#break("session is closed");
    }
    return keys;
  }

  #teardown(): void {
    const keys = this.#keys;
    this.#keys = undefined;
    if (keys !== undefined) {
      wipe(keys);
    }
  }

  #break(message: string, sw?: number): never {
    this.#teardown();
    throw new CardError("session-broken", message, sw);
  }
}

/**
 * Opens a session directly from the four concatenated session keys (`K_ce ‖ K_cm ‖ K_re ‖ K_rm`, 64
 * bytes) — the constructor `openResponse` uses after the ECDH exchange and KDF. It is exported from
 * session.ts so tests can drive sessions without an OPEN exchange; index.ts does not re-export it.
 * Takes ownership of `keys` and wipes it on close and on every teardown path.
 */
export function sessionFromKeys(
  keys: Uint8Array,
  identity: Uint8Array,
  cert: Uint8Array,
  batch: string,
  ephemeralTag: Uint8Array,
): Session {
  if (
    keys.length !== 64 ||
    identity.length !== 33 ||
    cert.length !== 97 ||
    ephemeralTag.length !== 8
  ) {
    throw new CardError("invalid-input", "session material has wrong lengths");
  }
  return new CardSession(
    keys,
    new Uint8Array(identity),
    new Uint8Array(cert),
    batch,
    new Uint8Array(ephemeralTag),
  );
}

/** `IV = AES-ECB(key, direction ‖ 13×0x00 ‖ u16(counter))` (§8.4). */
function recordIv(key: Uint8Array, direction: number, counter: number): Uint8Array {
  const block = new Uint8Array(16);
  block[0] = direction;
  block.set(u16(counter), 14);
  return ecb(key, { disablePadding: true }).encrypt(block);
}

function checkInner(command: Inner): void {
  const bytes = [command.ins, command.p1, command.p2];
  if (
    bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff) ||
    command.data.length > 236
  ) {
    throw new CardError("invalid-input", "inner command fields are out of range");
  }
}
