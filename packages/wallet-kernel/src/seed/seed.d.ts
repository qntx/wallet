import type { Pbkdf2 } from "../platform.ts";
/** BIP-39 seed: PBKDF2-HMAC-SHA512, 2048 rounds, 64 bytes. */
export declare function seedFromMnemonic(mnemonic: string, passphrase: string, pbkdf2: Pbkdf2): Promise<Uint8Array>;
export declare function seedFromEntropy(entropy: Uint8Array, pbkdf2: Pbkdf2): Promise<Uint8Array>;
