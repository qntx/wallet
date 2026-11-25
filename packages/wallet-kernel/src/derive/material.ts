import type { Versions } from "@scure/bip32";

import type { KeyPath } from "@qntx/wallet-chains";

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
  /**
   * Whether the entry serving `path` was confirmed on the device itself — an on-device address
   * check the user approved. Material the kernel holds a secret for is its own, hence confirmed;
   * pinned material answers only for entries a `verify-address` matched. `device-required` when no
   * pinned entry serves the path.
   */
  readonly confirmed: (curve: "secp256k1" | "ed25519", path: KeyPath) => Promise<boolean>;
};
