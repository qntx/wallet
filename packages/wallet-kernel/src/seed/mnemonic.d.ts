/** NFKD, trim, collapse whitespace runs to one space, lowercase. */
export declare function normalizeMnemonic(text: string): string;
/** Normalized BIP-39 (english wordlist, checksum enforced) → entropy. */
export declare function entropyFromMnemonic(text: string): Uint8Array;
/** 16/20/24/28/32 bytes of entropy → BIP-39 mnemonic (english wordlist). */
export declare function mnemonicFromEntropy(entropy: Uint8Array): string;
