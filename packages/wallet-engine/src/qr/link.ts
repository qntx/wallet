/**
 * The path and fingerprint grammar a phone-linked account declares, and the UR `Keypath` wire shape
 * it encodes to — shared by the export, counterpart and watch-account code. Runtime stays free of
 * chain imports so the watch validation pulls no codecs.
 */
import type { Keypath } from "@qntx/ur/interop";
import type { BitcoinTemplate } from "@qntx/wallet-chains";

import { malformed } from "./errors.ts";

/** Master fingerprint as a UR carries it: 8 lowercase hex digits. */
export const QR_FINGERPRINT = /^[0-9a-f]{8}$/;

/** The one signing-key path shape per family a qr-linked account may claim. */
export const QR_LINK_PATHS: Readonly<Record<"evm" | "solana" | "tron" | "bitcoin", RegExp>> = {
  evm: /^m\/44'\/60'\/0'\/0\/\d+$/,
  solana: /^m\/44'\/501'\/\d+'\/0'$/,
  tron: /^m\/44'\/195'\/0'\/0\/\d+$/,
  bitcoin: /^m\/(44|49|84|86)'\/(0|1)'\/\d+'$/,
};

export const qrLinkPath = (family: "evm" | "solana" | "tron" | "bitcoin", path: string): boolean =>
  QR_LINK_PATHS[family].test(path);

/** The Bitcoin mainnet CAIP-2 id — the only network a QR PSBT maps deterministically. */
export const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93";

/** The Bitcoin testnet CAIP-2 id — the one testnet genesis an export's coin type can name. */
export const BITCOIN_TESTNET = "bip122:00000000da84f2bafbbc53dee25a72ae";

/** The `p` of an account path `m/p'/coin'/g'/c/i` gives the template it must be. */
export const PURPOSE_TEMPLATE: Record<number, BitcoinTemplate> = {
  44: "btc.bip44",
  49: "btc.bip49",
  84: "btc.bip84",
  86: "btc.bip86",
};

/** A `m/…` path as (index, hardened) steps, or `undefined` when a step is malformed. */
export const pathComponents = (
  path: string,
): ReadonlyArray<{ readonly index: number; readonly hardened: boolean }> | undefined => {
  if (!path.startsWith("m/")) {
    return undefined;
  }
  const out: Array<{ index: number; hardened: boolean }> = [];
  for (const step of path.slice(2).split("/")) {
    const hardened = step.endsWith("'");
    const digits = hardened ? step.slice(0, -1) : step;
    if (!/^\d+$/.test(digits)) {
      return undefined;
    }
    const index = Number(digits);
    if (!Number.isSafeInteger(index) || index >= 0x80000000) {
      return undefined;
    }
    out.push({ index, hardened });
  }
  return out;
};

/** A `m/…` path and master fingerprint as the UR `Keypath` wire shape. */
export const keypath = (path: string, sourceFingerprint: number): Keypath => {
  const steps = pathComponents(path) ?? malformed(`bad derivation path ${path}`);
  return {
    components: steps.map((s) => ({
      kind: "index" as const,
      index: s.index,
      hardened: s.hardened,
    })),
    sourceFingerprint,
    depth: steps.length,
  };
};
