import { utf8ToBytes } from "@noble/hashes/utils.js";

import type { Pbkdf2 } from "../platform.ts";
import { wipe } from "../secret/secret.ts";
import { mnemonicFromEntropy } from "./mnemonic.ts";

/** BIP-39 seed: PBKDF2-HMAC-SHA512, 2048 rounds, 64 bytes. */
export async function seedFromMnemonic(
  mnemonic: string,
  passphrase: string,
  pbkdf2: Pbkdf2,
): Promise<Uint8Array> {
  const password = utf8ToBytes(mnemonic.normalize("NFKD"));
  const salt = utf8ToBytes(`mnemonic${passphrase}`.normalize("NFKD"));
  try {
    return await pbkdf2("sha512", password, salt, 2048, 64);
  } finally {
    wipe(password, salt);
  }
}

export async function seedFromEntropy(
  entropy: Uint8Array,
  passphrase: string,
  pbkdf2: Pbkdf2,
): Promise<Uint8Array> {
  return seedFromMnemonic(mnemonicFromEntropy(entropy), passphrase, pbkdf2);
}

/**
 * Derives the BIP-39 seed of `entropy` and `passphrase` ("" for none), runs `use`, wipes the seed
 * on every path. Does not own `entropy`.
 */
export async function withSeed<R>(
  pbkdf2: Pbkdf2,
  entropy: Uint8Array,
  passphrase: string,
  use: (seed: Uint8Array) => R | Promise<R>,
): Promise<R> {
  const seed = await seedFromEntropy(entropy, passphrase, pbkdf2);
  try {
    return await use(seed);
  } finally {
    wipe(seed);
  }
}
