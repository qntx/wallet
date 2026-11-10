import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { entropyToMnemonic, mnemonicToSeed } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { describe, expect, it } from "vite-plus/test";

import {
  entropyFromMnemonic,
  mnemonicBytes,
  normalizeMnemonic,
  splitMnemonic,
} from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { seededRandom } from "./harness.ts";
import { kernelError, loadVectors, subtlePbkdf2 } from "./helpers.ts";

const seededBytes = (seed: number): ((n: number) => Uint8Array) => seededRandom(seed).random;

// Each entry: [entropy hex, mnemonic, seed hex, xprv]. Passphrase "TREZOR".
type Bip39Vector = [entropy: string, mnemonic: string, seed: string, xprv: string];
const { english } = loadVectors("bip39.json") as { english: Bip39Vector[] };

describe("subtlePbkdf2", () => {
  it("matches @noble/hashes pbkdf2", async () => {
    const password = new Uint8Array([1, 2, 3]);
    const salt = new Uint8Array([4, 5, 6]);
    await expect(subtlePbkdf2("sha256", password, salt, 7, 32)).resolves.toStrictEqual(
      pbkdf2(sha256, password, salt, { c: 7, dkLen: 32 }),
    );
    await expect(subtlePbkdf2("sha512", password, salt, 7, 64)).resolves.toStrictEqual(
      pbkdf2(sha512, password, salt, { c: 7, dkLen: 64 }),
    );
  });
});

describe("bip39 vectors", () => {
  it.each(english)("entropy ⇄ mnemonic ⇄ seed: %s", async (entropy, mnemonic, seed) => {
    expect(bytesToHex(entropyFromMnemonic(mnemonic))).toBe(entropy);
    expect(mnemonicBytes(hexToBytes(entropy))).toStrictEqual(utf8ToBytes(mnemonic));
    await expect(
      seedFromEntropy(hexToBytes(entropy), "TREZOR", subtlePbkdf2),
    ).resolves.toStrictEqual(hexToBytes(seed));
  });
});

describe("normalizeMnemonic", () => {
  it("collapses extra whitespace and lowercases", () => {
    const [, mnemonic] = english[0]!;
    const messy = `  ${mnemonic.split(" ").join("   \t\n")}  `.toUpperCase();
    expect(normalizeMnemonic(messy)).toBe(mnemonic);
    expect(entropyFromMnemonic(messy)).toStrictEqual(entropyFromMnemonic(mnemonic));
  });
});

describe("entropyFromMnemonic rejects", () => {
  it("bad checksum", () => {
    const mnemonic = `${english[0]![1].split(" ").slice(0, -1).join(" ")} abandon`;
    expect(kernelError(() => entropyFromMnemonic(mnemonic))).toBe("invalid-input");
  });

  it("wrong word count", () => {
    const mnemonic = english[0]![1].split(" ").slice(0, 11).join(" ");
    expect(kernelError(() => entropyFromMnemonic(mnemonic))).toBe("invalid-input");
  });

  it("word outside the english wordlist", () => {
    const words = english[0]![1].split(" ");
    words[3] = "notaword";
    expect(kernelError(() => entropyFromMnemonic(words.join(" ")))).toBe("invalid-input");
  });
});

describe("mnemonicBytes", () => {
  const random = seededBytes(0x5eed);

  it.each([16, 20, 24, 28, 32])(
    "matches @scure/bip39 for random %d-byte entropy, never as a string",
    async (length) => {
      for (let i = 0; i < 64; i++) {
        const entropy = random(length);
        const expected = entropyToMnemonic(entropy, wordlist);
        const bytes = mnemonicBytes(entropy);
        expect(bytes).toStrictEqual(utf8ToBytes(expected));
        expect(splitMnemonic(bytes).map((w) => new TextDecoder().decode(w))).toStrictEqual(
          expected.split(" "),
        );
      }
      const entropy = random(length);
      await expect(seedFromEntropy(entropy, "pass", subtlePbkdf2)).resolves.toStrictEqual(
        await mnemonicToSeed(entropyToMnemonic(entropy, wordlist), "pass"),
      );
    },
  );

  it("rejects an unsupported entropy length", () => {
    expect(kernelError(() => mnemonicBytes(new Uint8Array(8)))).toBe("invalid-input");
  });
});

type PassphraseVector = { name: string; mnemonic: string; passphrase: string; seed: string };
const { passphrase: passphraseVectors } = loadVectors("bip39.json") as {
  passphrase: PassphraseVector[];
};

describe("bip39 passphrase vectors", () => {
  it.each(passphraseVectors)("$name: mnemonic + passphrase → seed", async (vector) => {
    const expected = hexToBytes(vector.seed);
    await expect(
      seedFromEntropy(entropyFromMnemonic(vector.mnemonic), vector.passphrase, subtlePbkdf2),
    ).resolves.toStrictEqual(expected);
  });

  it("composed and decomposed spellings share a seed; the passphrase changes it", () => {
    const seed = (name: string) => passphraseVectors.find((v) => v.name === name)?.seed;
    expect(seed("composed-accents")).toBe(seed("decomposed-accents"));
    expect(seed("leading-space")).not.toBe(seed("no-space"));
    expect(seed("ascii")).not.toBe(seed("no-space"));
  });
});
