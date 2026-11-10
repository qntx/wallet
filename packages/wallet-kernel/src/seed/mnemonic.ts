import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { KernelError } from "../errors.ts";
import { wipe } from "../secret/secret.ts";

const WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

/** NFKD, trim, collapse whitespace runs to one space, lowercase. */
export function normalizeMnemonic(text: string): string {
  return text.normalize("NFKD").trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/** Normalized BIP-39 (english wordlist, checksum enforced) → entropy. */
export function entropyFromMnemonic(text: string): Uint8Array {
  const mnemonic = normalizeMnemonic(text);
  if (!WORD_COUNTS.has(mnemonic.split(" ").length)) {
    throw new KernelError("invalid-input", "mnemonic must have 12, 15, 18, 21 or 24 words");
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new KernelError("invalid-input", "invalid mnemonic");
  }
  return mnemonicToEntropy(mnemonic, wordlist);
}

/** Each wordlist entry as UTF-8. English words are ASCII, so they are already NFKD-normalized. */
const WORD_BYTES: ReadonlyArray<Uint8Array> = wordlist.map((word) => utf8ToBytes(word));

/**
 * 16/20/24/28/32 bytes of entropy → its BIP-39 mnemonic (english wordlist) as normalized UTF-8: the
 * words joined by single spaces, exactly the PBKDF2 password BIP-39 specifies. Built from the
 * 11-bit indices directly, so no JS string ever holds the mnemonic; the caller wipes the result.
 */
export function mnemonicBytes(entropy: Uint8Array): Uint8Array {
  if (!ENTROPY_LENGTHS.has(entropy.length)) {
    throw new KernelError("invalid-input", "entropy must be 16, 20, 24, 28 or 32 bytes");
  }
  const checksum = sha256(entropy);
  const entropyBits = entropy.length * 8;
  const indices = new Uint16Array((entropyBits + entropyBits / 32) / 11);
  try {
    for (const word of indices.keys()) {
      let index = 0;
      for (let bit = word * 11; bit < word * 11 + 11; bit++) {
        const source = bit < entropyBits ? entropy : checksum;
        const at = bit < entropyBits ? bit : bit - entropyBits;
        // oxlint-disable-next-line eslint/no-bitwise -- BIP-39 packs 11-bit word indices MSB first
        index = (index << 1) | (((source[at >> 3] ?? 0) >> (7 - (at & 7))) & 1);
      }
      indices[word] = index;
    }
    const words = Array.from(indices, (index) => WORD_BYTES[index] ?? new Uint8Array());
    const out = new Uint8Array(words.reduce((length, w) => length + w.length, words.length - 1));
    let offset = 0;
    for (const [i, word] of words.entries()) {
      if (i > 0) {
        out[offset++] = 0x20;
      }
      out.set(word, offset);
      offset += word.length;
    }
    return out;
  } finally {
    wipe(checksum);
    indices.fill(0);
  }
}

/** The words of a `mnemonicBytes` result, as views into it (no copies). */
export function splitMnemonic(mnemonic: Uint8Array): Uint8Array[] {
  const words: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= mnemonic.length; i++) {
    if (i === mnemonic.length || mnemonic[i] === 0x20) {
      words.push(mnemonic.subarray(start, i));
      start = i + 1;
    }
  }
  return words;
}
