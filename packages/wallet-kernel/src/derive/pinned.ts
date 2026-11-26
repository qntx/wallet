/**
 * Pinned public material — the one `PublicMaterial` every external-custody wallet serves without a
 * secret. A card wallet pins the nodes a verified tap fetched (plus the master public key); a
 * hardware wallet pins the nodes pairing published (plus the claimed master fingerprint). The
 * resolution rules are one: `[]` answers the master when the pin carries it, otherwise
 * `device-required`; any other secp256k1 path resolves to an exact pinned node or by public
 * derivation under the deepest pinned prefix whose remaining indices are all non-hardened; ed25519
 * resolves exactly only (SLIP-10 has no public derivation). Whatever the pin cannot answer is
 * `device-required` — only the signer itself can produce it.
 *
 * Both record bodies carry the same `nodes` / `ed25519` sub-objects (`m/…` → `{key, chainCode,
 * parent?}` and `m/…` → pubkey hex); {@link parsePinnedNodes} and {@link parsePinnedEd25519} are the
 * shared strict codec — every failure is `integrity`.
 */
// oxlint-disable typescript/require-await -- every method satisfies the Promise-typed
// PublicMaterial contract; pinned material resolves synchronously.
import { equalBytes } from "@noble/ciphers/utils.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import type { Versions } from "@scure/bip32";
import { hash160 } from "@scure/btc-signer/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";

import { KernelError } from "../errors.ts";
import type { PublicMaterial } from "./material.ts";

const HARDENED = 0x80000000;
const MAX_NODES = 512;
const MAX_ED25519 = 256;
const HEX = /^[0-9a-f]+$/;

/** A pinned BIP-32 node: `m/…` path with its compressed public key and chain code. */
export type PinnedNode = {
  readonly path: KeyPath;
  readonly publicKey: Uint8Array;
  readonly chainCode: Uint8Array;
  /** The parent node's 4-byte fingerprint — needed to serialize this node's xpub. */
  readonly parent?: Uint8Array;
};

/** A pinned SLIP-10 ed25519 public key. */
export type PinnedEd25519 = {
  readonly path: KeyPath;
  readonly publicKey: Uint8Array;
};

/** The public key material an external-custody record pins, keyed by derivation path. */
export type PinnedKeys = {
  readonly nodes: ReadonlyArray<PinnedNode>;
  readonly ed25519: ReadonlyArray<PinnedEd25519>;
};

/** The pin one external-custody record resolves public material from. */
export type Pin = {
  /** The compressed master public key — card bodies carry it; hardware records do not. */
  readonly master?: Uint8Array;
  /**
   * The claimed master fingerprint — hardware headers carry it. When `master` is also present the
   * claim must match hash160(master)[0..4] or the pin is corrupt.
   */
  readonly fingerprint?: Uint8Array;
  readonly keys: PinnedKeys;
  /**
   * The pinned entries that passed an on-device check — `"all"` for a card (a genuine card's keys
   * are its own; the tap already proved custody), the confirmed path list for a hardware wallet.
   */
  readonly confirmed: "all" | ReadonlyArray<KeyPath>;
};

const failure = (): KernelError => new KernelError("integrity", "invalid pinned material");

const deviceRequired = (): KernelError =>
  new KernelError("device-required", "this key needs the external signer");

const asHexBytes = (value: unknown, length: number): Uint8Array => {
  if (typeof value !== "string" || value.length !== length * 2 || !HEX.test(value)) {
    throw failure();
  }
  return hexToBytes(value);
};

/** `m/…` → `KeyPath`; depth 1–10, hardened segments carry `'`, canonical decimal indices. */
export function pathFromString(text: string): KeyPath {
  if (!/^m(\/[0-9]+'?){1,10}$/.test(text)) {
    throw failure();
  }
  return text
    .slice(2)
    .split("/")
    .map((segment) => {
      const hardened = segment.endsWith("'");
      const digits = hardened ? segment.slice(0, -1) : segment;
      // Canonical decimal only — a leading zero would re-encode differently.
      if (digits.length > 1 && digits.startsWith("0")) {
        throw failure();
      }
      const index = Number(digits);
      if (!Number.isSafeInteger(index) || index > 0x7fffffff) {
        throw failure();
      }
      return hardened ? index + HARDENED : index;
    });
}

/** `KeyPath` → `m/…` — the inverse of {@link pathFromString}; the empty path is `m`. */
export function pathToString(path: KeyPath): string {
  return `m${path.map((i) => (i >= HARDENED ? `/${i - HARDENED}'` : `/${i}`)).join("")}`;
}

const asSecpPoint = (value: unknown): Uint8Array => {
  const bytes = asHexBytes(value, 33);
  try {
    secp256k1.Point.fromBytes(bytes);
  } catch {
    throw failure();
  }
  return bytes;
};

const asEd25519Point = (value: unknown): Uint8Array => {
  const bytes = asHexBytes(value, 32);
  try {
    ed25519.Point.fromBytes(bytes);
  } catch {
    throw failure();
  }
  return bytes;
};

const parseNode = (value: unknown): Omit<PinnedNode, "path"> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to an object above
  const node = value as Record<string, unknown>;
  const hasParent = Object.hasOwn(node, "parent");
  if (Object.keys(node).length !== (hasParent ? 3 : 2)) {
    throw failure();
  }
  return {
    publicKey: asSecpPoint(node["key"]),
    chainCode: asHexBytes(node["chainCode"], 32),
    ...(hasParent ? { parent: asHexBytes(node["parent"], 4) } : {}),
  };
};

/**
 * The `nodes` sub-object both custody bodies carry: `m/…` → `{key, chainCode, parent?}` with at
 * most 512 entries — every key an on-curve secp256k1 point, every chain code 32 bytes.
 */
export function parsePinnedNodes(value: unknown): PinnedNode[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure();
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_NODES) {
    throw failure();
  }
  const nodes: PinnedNode[] = [];
  for (const [path, entry] of entries) {
    nodes.push({ path: pathFromString(path), ...parseNode(entry) });
  }
  return nodes;
}

/**
 * The `ed25519` sub-object both custody bodies carry: `m/…` → RFC 8032 public key hex with at most
 * 256 entries.
 */
export function parsePinnedEd25519(value: unknown): PinnedEd25519[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failure();
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ED25519) {
    throw failure();
  }
  return entries.map(([path, pub]) => ({
    path: pathFromString(path),
    publicKey: asEd25519Point(pub),
  }));
}

export const samePath = (a: KeyPath, b: KeyPath): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The node at `path`: an exact pinned node or one publicly derived under the deepest pinned prefix
 * whose remaining tail is fully non-hardened. `undefined` when only the signer can answer — the
 * master and hardened gaps never derive publicly.
 */
const nodeAt = (pin: Pin, path: KeyPath): HDKey | undefined => {
  const [ancestor] = pin.keys.nodes
    .filter(
      (node) =>
        node.path.length <= path.length &&
        samePath(node.path, path.slice(0, node.path.length)) &&
        path.slice(node.path.length).every((index) => index < HARDENED),
    )
    .sort((a, b) => b.path.length - a.path.length);
  if (ancestor === undefined) {
    return undefined;
  }
  let node = new HDKey({ publicKey: ancestor.publicKey, chainCode: ancestor.chainCode });
  for (const index of path.slice(ancestor.path.length)) {
    node = node.deriveChild(index);
  }
  return node;
};

/**
 * The pinned entry `path` resolves through — the deepest secp256k1 prefix with an all-non-hardened
 * tail (the same ancestor {@link nodeAt} picks), the exact ed25519 entry. `undefined` when the pin
 * cannot serve the path at all.
 */
export const servingPath = (
  pin: Pin,
  curve: "secp256k1" | "ed25519",
  path: KeyPath,
): KeyPath | undefined => {
  if (curve === "ed25519") {
    return pin.keys.ed25519.find((k) => samePath(k.path, path))?.path;
  }
  const [ancestor] = pin.keys.nodes
    .filter(
      (node) =>
        node.path.length <= path.length &&
        samePath(node.path, path.slice(0, node.path.length)) &&
        path.slice(node.path.length).every((index) => index < HARDENED),
    )
    .sort((a, b) => b.path.length - a.path.length);
  return ancestor?.path;
};

/** The BIP-32 master/parent fingerprint's first four bytes as the u32 device answers carry. */
export const fingerprintNumber = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);

/** The inverse of `fingerprintNumber`: a u32 fingerprint as its four big-endian bytes. */
export const fingerprintBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

/** The pin's public material; misses are `device-required`, corrupt pins are `integrity`. */
export const pinnedMaterial = (pin: Pin): PublicMaterial => ({
  secp256k1: async (path) => {
    if (path.length === 0) {
      if (pin.master === undefined) {
        throw deviceRequired();
      }
      return new Uint8Array(pin.master);
    }
    const key = nodeAt(pin, path)?.publicKey;
    if (key === undefined || key === null) {
      throw deviceRequired();
    }
    return new Uint8Array(key);
  },
  ed25519: async (path) => {
    const key = pin.keys.ed25519.find((k) => samePath(k.path, path));
    if (key === undefined) {
      throw deviceRequired();
    }
    return new Uint8Array(key.publicKey);
  },
  extendedPublicKey: async (path, versions: Versions) => {
    const node = path.length === 0 ? undefined : nodeAt(pin, path);
    if (node === undefined || node.publicKey === null || node.chainCode === null) {
      throw deviceRequired();
    }
    /* The parent fingerprint is the pinned claim when the exact node carries one; otherwise the
       parent path's public key — the master for depth 1, resolved through the same lookup — feeds
       hash160's first four bytes. */
    const pinned = pin.keys.nodes.find((entry) => samePath(entry.path, path));
    let parentFingerprint: number;
    if (pinned?.parent === undefined) {
      const parentPublic =
        path.length === 1 ? pin.master : (nodeAt(pin, path.slice(0, -1))?.publicKey ?? undefined);
      if (parentPublic === undefined || parentPublic === null) {
        throw deviceRequired();
      }
      parentFingerprint = fingerprintNumber(hash160(parentPublic));
    } else {
      parentFingerprint = fingerprintNumber(pinned.parent);
    }
    return new HDKey({
      versions,
      depth: path.length,
      index: path.at(-1) ?? 0,
      parentFingerprint,
      chainCode: node.chainCode,
      publicKey: node.publicKey,
    }).publicExtendedKey;
  },
  confirmed: async (curve, path) => {
    const serving = servingPath(pin, curve, path);
    if (serving === undefined) {
      throw deviceRequired();
    }
    return pin.confirmed === "all" || pin.confirmed.some((p) => samePath(p, serving));
  },
  fingerprint: async () => {
    if (pin.master !== undefined) {
      const derived = hash160(pin.master).slice(0, 4);
      if (pin.fingerprint !== undefined && !equalBytes(derived, pin.fingerprint)) {
        throw new KernelError("integrity", "pinned fingerprint does not match the master key");
      }
      return derived;
    }
    if (pin.fingerprint === undefined) {
      throw new KernelError("integrity", "the pin carries neither master key nor fingerprint");
    }
    return new Uint8Array(pin.fingerprint);
  },
});
