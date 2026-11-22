/**
 * Inner command builders (protocol.md §9.2–9.14). Every builder validates its host-side parameters
 * — `invalid-input` on anything out of range — and produces the plaintext record `INS ‖ P1 ‖ P2 ‖
 * data` a session wraps.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE } from "@noble/curves/utils.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";

import { CardError } from "./errors.ts";
import type { ExportHead, Offer } from "./transfer.ts";

export type CommandName =
  | "status"
  | "create"
  | "verify"
  | "change"
  | "erase"
  | "wait"
  | "public-key"
  | "sign-ecdsa"
  | "sign-bip340"
  | "ed25519-begin"
  | "ed25519-update"
  | "ed25519-finish"
  | "offer"
  | "export-head"
  | "export-payload"
  | "import-head"
  | "import-payload";

export type Inner = {
  readonly name: CommandName;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  readonly data: Uint8Array;
};

/** A BIP-32 derivation path: 1–10 component indices (§9.2). */
export type CardPath = ReadonlyArray<number>;

export type CreateParams =
  | {
      readonly mode: "generate";
      readonly accessHash: Uint8Array;
      readonly entropy: Uint8Array;
      readonly others: ReadonlyArray<Uint8Array>;
    }
  | {
      readonly mode: "import";
      readonly accessHash: Uint8Array;
      readonly seed: Uint8Array;
      readonly others: ReadonlyArray<Uint8Array>;
    };

const INS: Readonly<Record<CommandName, number>> = {
  status: 0x20,
  create: 0x21,
  verify: 0x22,
  change: 0x23,
  erase: 0x24,
  wait: 0x25,
  "public-key": 0x30,
  "sign-ecdsa": 0x31,
  "sign-bip340": 0x32,
  "ed25519-begin": 0x33,
  "ed25519-update": 0x33,
  "ed25519-finish": 0x33,
  offer: 0x40,
  "export-head": 0x41,
  "export-payload": 0x41,
  "import-head": 0x42,
  "import-payload": 0x42,
};

const PATH_HARDENED = 0x80000000;
const CHUNK = 236;

function inner(name: CommandName, p1: number, p2: number, data: Uint8Array): Inner {
  return { name, ins: INS[name], p1, p2, data };
}

function exact(what: string, value: Uint8Array, length: number): Uint8Array {
  if (value.length !== length) {
    throw new CardError("invalid-input", `${what} must be ${length} bytes`);
  }
  return value;
}

/** `path = depth ‖ u32(index)…`, depth 1–10 (§9.2); ed25519 paths must be all-hardened. */
function encodePath(path: CardPath, hardenedOnly: boolean): Uint8Array {
  if (path.length === 0 || path.length > 10) {
    throw new CardError("invalid-input", "path depth outside 1..10");
  }
  const out = new Uint8Array(1 + 4 * path.length);
  out[0] = path.length;
  const view = new DataView(out.buffer);
  for (const [position, index] of path.entries()) {
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
      throw new CardError("invalid-input", "path index outside 0..2^32-1");
    }
    if (hardenedOnly && index < PATH_HARDENED) {
      throw new CardError("invalid-input", "ed25519 path index is not hardened");
    }
    view.setUint32(1 + 4 * position, index);
  }
  return out;
}

/** `others` is 0–2 pairwise-distinct 16-byte member IDs (§9.4). */
export function checkOthers(others: ReadonlyArray<Uint8Array>): void {
  if (others.length > 2) {
    throw new CardError("invalid-input", "more than two other member IDs");
  }
  for (const [i, id] of others.entries()) {
    if (id.length !== 16) {
      throw new CardError("invalid-input", "member ID is not 16 bytes");
    }
    if (others.slice(i + 1).some((other) => equalBytes(other, id))) {
      throw new CardError("invalid-input", "member IDs are not pairwise distinct");
    }
  }
}

/**
 * The BIP-32 master public key a CREATE import seed yields. `invalid-input` when `HDKey` rejects
 * the seed — sent unchecked, the card would answer `6A80` (§9.4).
 */
export function masterPublicKey(seed: Uint8Array): Uint8Array {
  let key: HDKey;
  try {
    key = HDKey.fromMasterSeed(seed);
  } catch {
    throw new CardError("invalid-input", "seed does not yield a valid master key");
  }
  try {
    const { publicKey } = key;
    if (publicKey === null) {
      throw new CardError("invalid-input", "seed does not yield a valid master key");
    }
    return publicKey;
  } finally {
    key.wipePrivateData();
  }
}

/**
 * The CREATE argument contract (§9.4), shared by `cmd.create` and `decode.created`: accessHash 32
 * bytes; entropy 32 bytes for `generate`, a 64-byte seed that yields a master key for `import`;
 * `others` per `checkOthers`.
 */
export function checkCreateParams(params: CreateParams): void {
  checkOthers(params.others);
  exact("accessHash", params.accessHash, 32);
  if (params.mode === "generate") {
    exact("entropy", params.entropy, 32);
  } else {
    exact("seed", params.seed, 64);
    masterPublicKey(params.seed);
  }
}

export const cmd = {
  status: (): Inner => inner("status", 0, 0, new Uint8Array(0)),
  create: (params: CreateParams): Inner => {
    checkCreateParams(params);
    const head =
      params.mode === "generate"
        ? concatBytes(params.accessHash, params.entropy)
        : concatBytes(params.accessHash, params.seed);
    return inner(
      "create",
      params.mode === "generate" ? 0 : 1,
      0,
      concatBytes(head, ...params.others),
    );
  },
  verify: (accessHash: Uint8Array): Inner =>
    inner("verify", 0, 0, exact("accessHash", accessHash, 32)),
  change: (newAccessHash: Uint8Array): Inner =>
    inner("change", 0, 0, exact("newAccessHash", newAccessHash, 32)),
  erase: (): Inner => inner("erase", 0, 0, new Uint8Array(0)),
  wait: (): Inner => inner("wait", 0, 0, new Uint8Array(0)),
  publicKey: (curve: "secp256k1" | "ed25519", path: CardPath): Inner =>
    inner("public-key", curve === "ed25519" ? 1 : 0, 0, encodePath(path, curve === "ed25519")),
  signEcdsa: (digest: Uint8Array, path: CardPath): Inner =>
    inner("sign-ecdsa", 0, 0, concatBytes(exact("digest", digest, 32), encodePath(path, false))),
  signBip340: (message: Uint8Array, tweak: Uint8Array, path: CardPath): Inner => {
    exact("message", message, 32);
    exact("tweak", tweak, 32);
    if (bytesToNumberBE(tweak) >= secp256k1.Point.Fn.ORDER) {
      throw new CardError("invalid-input", "tweak is not below the curve order");
    }
    return inner("sign-bip340", 0, 0, concatBytes(message, tweak, encodePath(path, false)));
  },
  ed25519Begin: (path: CardPath): Inner => inner("ed25519-begin", 0, 0, encodePath(path, true)),
  /** §9.11/§12.3: the stream `encode(R) ‖ encode(A) ‖ M` in ≤236-byte chunks; the last is finish. */
  ed25519Stream: (
    encodedR: Uint8Array,
    publicKey: Uint8Array,
    message: Uint8Array,
  ): ReadonlyArray<Inner> => {
    const stream = concatBytes(
      exact("encodedR", encodedR, 32),
      exact("publicKey", publicKey, 32),
      message,
    );
    const chunks: Inner[] = [];
    for (let offset = 0; offset < stream.length; offset += CHUNK) {
      const last = offset + CHUNK >= stream.length;
      chunks.push(
        inner(
          last ? "ed25519-finish" : "ed25519-update",
          last ? 0x02 : 0x01,
          0,
          stream.subarray(offset, Math.min(offset + CHUNK, stream.length)),
        ),
      );
    }
    return chunks;
  },
  offer: (): Inner => inner("offer", 0, 0, new Uint8Array(0)),
  export0: (certT: Uint8Array, offer: Offer): Inner =>
    inner(
      "export-head",
      0,
      0,
      concatBytes(
        exact("certT", certT, 97),
        exact("offer.linkKey", offer.linkKey, 65),
        exact("offer.signature", offer.signature, 64),
      ),
    ),
  export1: (accessHashT: Uint8Array): Inner =>
    inner("export-payload", 1, 0, exact("accessHashT", accessHashT, 32)),
  import0: (certS: Uint8Array, head: ExportHead): Inner =>
    inner(
      "import-head",
      0,
      0,
      concatBytes(
        exact("certS", certS, 97),
        exact("head.ephemeral", head.ephemeral, 65),
        exact("head.signature", head.signature, 64),
      ),
    ),
  import1: (payload: Uint8Array): Inner => {
    if (payload.length !== 160 && payload.length !== 176) {
      throw new CardError("invalid-input", "transfer payload is not 160 or 176 bytes");
    }
    return inner("import-payload", 1, 0, payload);
  },
};
