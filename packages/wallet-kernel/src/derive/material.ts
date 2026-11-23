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
};
