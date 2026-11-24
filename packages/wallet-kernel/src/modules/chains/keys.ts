/**
 * Key sources — the kernel's bridge between a signing secret and a plan's tasks. `material` is the
 * only way public keys leave the secret (addresses, BTC ownership, fingerprints, xpubs are all
 * derived through it); `backend` answers one 64-byte signature per task through a family task
 * signer. BIP-32 and SLIP-10 nodes are cached by path and each child derives from its cached
 * parent, so a many-input PSBT derives the account node once; `wipe` zeroes every cached node.
 */
// oxlint-disable typescript/require-await -- every method satisfies a Promise-typed contract; the
// local sources resolve synchronously.
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import type { Versions } from "@scure/bip32";
import { hash160 } from "@scure/btc-signer/utils.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import type { KeyPath, SignTask } from "@qntx/wallet-chains";

import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";

const HARDENED = 0x80000000;

/** `m/…` notation of a task path — hardened indices print with `'`. */
export const pathString = (path: KeyPath): string =>
  `m${path.map((i) => (i >= HARDENED ? `/${i - HARDENED}'` : `/${i}`)).join("")}`;

/** Public-key and xpub access the kernel's checks need — never private key material. */
export type PublicMaterial = {
  /** The 33-byte compressed secp256k1 key at the path; `[]` is the master (or imported) key. */
  readonly secp256k1: (path: KeyPath) => Promise<Uint8Array>;
  /** The 32-byte SLIP-10 ed25519 key at the path. */
  readonly ed25519: (path: KeyPath) => Promise<Uint8Array>;
  /** The base58 account xpub at the path under the network's version bytes. HD only. */
  readonly extendedPublicKey: (path: KeyPath, versions: Versions) => Promise<string>;
  /** The 4-byte BIP-32 master fingerprint: hash160(master pubkey)[0..4]. HD only. */
  readonly fingerprint: () => Promise<Uint8Array>;
};

/** An account node's public fields, read back out of its own serialized extended public key. */
export type AccountKey = {
  readonly publicKey: Uint8Array;
  readonly chainCode: Uint8Array;
  readonly parentFingerprint: number;
};

export const accountKey = async (
  material: PublicMaterial,
  path: KeyPath,
  versions: Versions,
): Promise<AccountKey> => {
  const parsed = HDKey.fromExtendedKey(await material.extendedPublicKey(path, versions), versions);
  if (parsed.publicKey === null || parsed.chainCode === null) {
    throw new KernelError("integrity", "extended public key carries no node");
  }
  return {
    publicKey: parsed.publicKey,
    chainCode: parsed.chainCode,
    parentFingerprint: parsed.parentFingerprint,
  };
};

/** Supplies one 64-byte signature per task — the local seed backend today, a card later. */
export type SigningBackend = {
  readonly sign: (task: SignTask) => Promise<Uint8Array>;
};

/** A family task signer: the sign.ts entry points that hold the raw-key code. */
export type TaskSigner = (
  task: SignTask,
  privateKey: Uint8Array,
  auxRand: Uint8Array,
) => Uint8Array;

export type KeySource = {
  readonly material: PublicMaterial;
  readonly backend: (sign: TaskSigner) => SigningBackend;
  readonly wipe: () => void;
};

/** The HD source: BIP-32 for secp256k1 schemes, SLIP-10 for ed25519, both lazy and path-cached. */
export const seedKeys = (seed: Uint8Array, random: (n: number) => Uint8Array): KeySource => {
  const secpNodes = new Map<string, HDKey>();
  const edNodes = new Map<string, Slip10>();
  let wiped = false;
  // Cached nodes keep the public half after wipePrivateData; the flag closes the source anyway.
  const alive = (): void => {
    if (wiped) {
      throw new KernelError("integrity", "key source is wiped");
    }
  };

  const secpNode = (path: KeyPath): HDKey => {
    alive();
    const key = path.join("/");
    const hit = secpNodes.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const node =
      path.length === 0
        ? HDKey.fromMasterSeed(seed)
        : secpNode(path.slice(0, -1)).deriveChild(path.at(-1) ?? 0);
    secpNodes.set(key, node);
    return node;
  };

  const edNode = (path: KeyPath): Slip10 => {
    alive();
    const key = path.join("/");
    const hit = edNodes.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const node =
      path.length === 0
        ? Slip10.fromMasterSeed(seed)
        : edNode(path.slice(0, -1)).deriveChild(path.at(-1) ?? 0);
    edNodes.set(key, node);
    return node;
  };

  const privateAt = (task: SignTask): Uint8Array => {
    if (task.scheme === "ed25519") {
      return edNode(task.path).privateKey;
    }
    const priv = secpNode(task.path).privateKey;
    if (priv === null) {
      throw new KernelError("integrity", "no private key at path");
    }
    return priv;
  };

  return {
    material: {
      secp256k1: async (path) => {
        const pub = secpNode(path).publicKey;
        if (pub === null) {
          throw new KernelError("integrity", "no public key at path");
        }
        return pub;
      },
      ed25519: async (path) => ed25519.getPublicKey(edNode(path).privateKey),
      fingerprint: async () => {
        const pub = secpNode([]).publicKey;
        if (pub === null) {
          throw new KernelError("integrity", "no public key at path");
        }
        return hash160(pub).subarray(0, 4);
      },
      // A fresh tree under the network's version bytes: xpubs serialize with them.
      extendedPublicKey: async (path, versions) => {
        alive();
        const master = HDKey.fromMasterSeed(seed, versions);
        try {
          const node = master.derive(pathString(path));
          try {
            return node.publicExtendedKey;
          } finally {
            node.wipePrivateData();
          }
        } finally {
          master.wipePrivateData();
        }
      },
    },
    backend: (sign) => ({
      sign: async (task) =>
        // Only BIP-340 consumes aux randomness; ECDSA and Ed25519 tasks draw none.
        sign(task, privateAt(task), task.scheme === "bip340" ? random(32) : new Uint8Array()),
    }),
    wipe: () => {
      wiped = true;
      for (const node of secpNodes.values()) {
        node.wipePrivateData();
      }
      for (const node of edNodes.values()) {
        wipe(node.privateKey);
      }
      secpNodes.clear();
      edNodes.clear();
    },
  };
};

/** The imported-key source: one raw key serves only path `[]` and only its own curve's tasks. */
export const importedKeys = (
  secret: Uint8Array,
  curve: "secp256k1" | "ed25519",
  random: (n: number) => Uint8Array,
): KeySource => {
  let wiped = false;
  const alive = (): void => {
    if (wiped) {
      throw new KernelError("integrity", "key source is wiped");
    }
  };
  return {
    material: {
      secp256k1: async (path) => {
        alive();
        if (curve !== "secp256k1" || path.length > 0) {
          throw new KernelError("integrity", "an imported key serves only its own curve at []");
        }
        return secp256k1.getPublicKey(secret, true);
      },
      ed25519: async (path) => {
        alive();
        if (curve !== "ed25519" || path.length > 0) {
          throw new KernelError("integrity", "an imported key serves only its own curve at []");
        }
        return ed25519.getPublicKey(secret);
      },
      extendedPublicKey: async () => {
        throw new KernelError("integrity", "imported keys have no extended public key");
      },
      fingerprint: async () => {
        throw new KernelError("integrity", "imported keys have no fingerprint");
      },
    },
    backend: (sign) => ({
      sign: async (task) => {
        alive();
        const ownCurve =
          curve === "secp256k1" ? task.scheme !== "ed25519" : task.scheme === "ed25519";
        if (task.path.length > 0 || !ownCurve) {
          throw new KernelError("integrity", "an imported key signs only its own tasks at []");
        }
        return sign(task, secret, task.scheme === "bip340" ? random(32) : new Uint8Array());
      },
    }),
    wipe: () => {
      wiped = true;
      wipe(secret);
    },
  };
};
