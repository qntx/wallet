/**
 * BIP-388 default wallet policies (doc/wallet.md "Default wallets" and "Serialization"; the
 * reference WalletPolicy/DefaultWalletPolicy is bitcoin_client_js/src/lib/policy.ts). Only the four
 * single-key templates the app accepts without registration are supported, so a serialized policy
 * always has an empty name and exactly one key. Key strings use the origin form the app tests pin
 * (`[f5acc2fd/84'/1'/0']tpub…` — app-bitcoin-new tests/test_sign_psbt.py).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";

import type { BitcoinTemplate, KeyPath } from "@qntx/wallet-chains";

import { input, varint } from "../bytes.ts";
import { leafHash, merkleRoot } from "./merkle.ts";

export type BitcoinDescriptorTemplate =
  | "pkh(@0/**)"
  | "sh(wpkh(@0/**))"
  | "wpkh(@0/**)"
  | "tr(@0/**)";

export type BitcoinPolicy = {
  readonly template: BitcoinDescriptorTemplate;
  /** `[fingerprinthex/purpose'/coin'/account']` + the account xpub (BIP-388 key origin). */
  readonly key: string;
};

const HARDENED = 0x80_00_00_00;
// doc/wallet.md: "the BIP-44 account level must be at most 100" (MAX_BIP44_ACCOUNT_RECOMMENDED).
const MAX_ACCOUNT = 100;

const TEMPLATES = {
  "btc.bip44": { template: "pkh(@0/**)", purpose: 44 },
  "btc.bip49": { template: "sh(wpkh(@0/**))", purpose: 49 },
  "btc.bip84": { template: "wpkh(@0/**)", purpose: 84 },
  "btc.bip86": { template: "tr(@0/**)", purpose: 86 },
} as const satisfies Readonly<
  Record<BitcoinTemplate, { template: BitcoinDescriptorTemplate; purpose: number }>
>;

/** BIP-32 mainnet version bytes (BIP32_PUBKEY_VERSION in the pinned Makefile, COIN=bitcoin). */
export const MAINNET_BIP32 = { public: 0x04_88_b2_1e, private: 0x04_88_ad_e4 } as const;

export const xpubKey = (xpub: string): HDKey => {
  try {
    return HDKey.fromExtendedKey(xpub, MAINNET_BIP32);
  } catch {
    throw input("the policy key is not a mainnet xpub");
  }
};

export const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * `[fingerprinthex/purpose'/coin'/account']xpub` for a default wallet. `account` must be the three
 * hardened steps of the matching BIP (purpose matching the template, coin 0' or 1', account' at
 * most 100 per doc/wallet.md) and `xpub` a mainnet extended public key at that depth.
 */
export function defaultPolicy(
  template: BitcoinTemplate,
  fingerprint: Uint8Array,
  account: KeyPath,
  xpub: string,
): BitcoinPolicy {
  const spec = (
    TEMPLATES as Readonly<Record<string, { template: BitcoinDescriptorTemplate; purpose: number }>>
  )[template];
  if (spec === undefined) {
    throw input("unknown bitcoin account template");
  }
  if (fingerprint.length !== 4) {
    throw input("the master fingerprint is not 4 bytes");
  }
  const [purpose, coin, index] = account;
  if (
    purpose === undefined ||
    coin === undefined ||
    index === undefined ||
    account.length !== 3 ||
    !account.every(
      (step) => Number.isSafeInteger(step) && step >= HARDENED && step <= 0xff_ff_ff_ff,
    )
  ) {
    throw input("the account path is not three hardened steps");
  }
  if (purpose - HARDENED !== spec.purpose) {
    throw input("the account purpose does not match the template");
  }
  if (coin - HARDENED !== 0 && coin - HARDENED !== 1) {
    throw input("the account coin type is not 0' or 1'");
  }
  if (index - HARDENED > MAX_ACCOUNT) {
    throw input("the account index is above 100");
  }
  if (xpubKey(xpub).depth !== account.length) {
    throw input("the xpub depth does not match the account path");
  }
  const origin = account.map((step) => `${String(step - HARDENED)}'`).join("/");
  return { template: spec.template, key: `[${bytesToHex(fingerprint)}/${origin}]${xpub}` };
}

const TEMPLATE_NAMES = new Set<string>([
  "pkh(@0/**)",
  "sh(wpkh(@0/**))",
  "wpkh(@0/**)",
  "tr(@0/**)",
]);

const KEY_RE = /^\[([0-9a-f]{8})((?:\/\d+'){3})\](.+)$/;

export type ParsedPolicyKey = {
  readonly fingerprint: Uint8Array;
  /** The three hardened account steps the origin names. */
  readonly account: ReadonlyArray<number>;
  readonly xpub: string;
};

/**
 * Parse `policy.key` back into origin and xpub. A default policy's key always carries origin
 * information (doc/wallet.md: compulsory for keys the device must treat as internal), so a key
 * without it — or with a path that is not exactly three hardened steps — is `invalid-input`.
 */
export function policyKey(policy: BitcoinPolicy): ParsedPolicyKey {
  if (!TEMPLATE_NAMES.has(policy.template)) {
    throw input("unknown wallet policy template");
  }
  const match = KEY_RE.exec(policy.key);
  if (match === null) {
    throw input("the policy key has no valid origin");
  }
  const [, fpr, origin, xpub] = match;
  if (fpr === undefined || origin === undefined || xpub === undefined) {
    throw input("the policy key has no valid origin");
  }
  const fingerprint = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    fingerprint[i] = Number.parseInt(fpr.slice(2 * i, 2 * i + 2), 16);
  }
  const account = origin
    .slice(1)
    .split("/")
    .map((step) => {
      const n = Number(step.slice(0, -1));
      if (n > 0x7f_ff_ff_ff) {
        throw input("a policy origin step is not a hardened index");
      }
      return n + HARDENED;
    });
  if (xpubKey(xpub).depth !== account.length) {
    throw input("the policy key origin does not match its xpub");
  }
  return { fingerprint, account, xpub };
}

const WALLET_POLICY_V2 = 0x02; // policy.ts WALLET_POLICY_V2 / doc/wallet.md serialization version

/**
 * `02 ‖ 00 (empty name) ‖ varint templateLen ‖ sha256(template) ‖ varint 1 ‖ merkleRoot(keys)` —
 * doc/wallet.md "Serialization" for a default (nameless, single-key) wallet.
 */
export function serializePolicy(policy: BitcoinPolicy): Uint8Array {
  const template = ascii(policy.template);
  const keyRoot = merkleRoot([leafHash(ascii(policy.key))]);
  const out = new Uint8Array(1 + 1 + varint(template.length).length + 32 + 1 + 32);
  out[0] = WALLET_POLICY_V2;
  out[1] = 0; // empty name
  out.set(varint(template.length), 2);
  out.set(sha256(template), 2 + varint(template.length).length);
  out.set(varint(1), 2 + varint(template.length).length + 32);
  out.set(keyRoot, 2 + varint(template.length).length + 32 + 1);
  return out;
}

/** The 32-byte wallet policy id — `sha256(serializePolicy)` (doc/wallet.md). */
export function policyId(policy: BitcoinPolicy): Uint8Array {
  return sha256(serializePolicy(policy));
}
