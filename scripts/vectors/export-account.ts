/// <reference types="node" />
/**
 * Regenerates vectors/chains/export-account.json without importing kernel or wallet code: BIP-32
 * account material is derived with the npm `hdkey` package — independent of the kernel's
 *
 * @scure/bip32 — and SLIP-10 ed25519 with micro-key-producer. Covers the two public test
 * mnemonics: master fingerprint, the MetaMask evm.account node m/44'/60'/0', the evm/tron/solana
 * group-0 and group-1 leaves, and btc.account nodes for bip84+bip86 on mainnet plus bip84 on
 * testnet (coin type 1', tpub versions).
 *
 * Run from the repo root: bun scripts/vectors/export-account.ts
 */
import { writeFileSync } from "node:fs";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import HDKey from "hdkey";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const TESTNET = "bip122:00000000da84f2bafbbc53dee25a72ae";
const TESTNET_BIP32 = { public: 0x043587cf, private: 0x04358394 } as const;

const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "test test test test test test test test test test test junk",
];

const fp8 = (value: number): string => value.toString(16).padStart(8, "0");

const evmAddress = (publicKey: Uint8Array): string =>
  `0x${bytesToHex(keccak_256(secp256k1.Point.fromBytes(publicKey).toBytes(false).subarray(1)).subarray(12))}`;

const btcNode = (master: HDKey, purpose: number, coin: number, group: number) =>
  master.derive(`m/${String(purpose)}'/${String(coin)}'/${String(group)}'`);

type KeyRow = {
  readonly node: Record<string, unknown>;
  readonly groupIndex: number;
  readonly path: string;
  readonly curve: string;
  readonly publicKey: string;
  readonly chainCode?: string;
  readonly parentFingerprint?: string;
  readonly xpub?: string;
};

const accountRow = (
  node: Record<string, unknown>,
  groupIndex: number,
  path: string,
  hd: HDKey,
): KeyRow => ({
  node,
  groupIndex,
  path,
  curve: "secp256k1",
  publicKey: bytesToHex(hd.publicKey),
  chainCode: bytesToHex(hd.chainCode),
  parentFingerprint: fp8(hd.parentFingerprint),
});

const leafRow = (
  node: Record<string, unknown>,
  groupIndex: number,
  path: string,
  curve: string,
  publicKey: Uint8Array,
): KeyRow => ({ node, groupIndex, path, curve, publicKey: bytesToHex(publicKey) });

const wallet = (mnemonic: string): Record<string, unknown> => {
  const seed = mnemonicToSeedSync(mnemonic.normalize("NFKD"), "");
  const master = HDKey.fromMasterSeed(seed);
  const testMaster = HDKey.fromMasterSeed(seed, TESTNET_BIP32);
  const slip = Slip10.fromMasterSeed(seed);
  const keys: KeyRow[] = [
    accountRow({ kind: "evm.account" }, 0, "m/44'/60'/0'", master.derive("m/44'/60'/0'")),
  ];
  for (const groupIndex of [0, 1]) {
    keys.push(
      leafRow(
        { kind: "leaf", template: "evm.bip44" },
        groupIndex,
        `m/44'/60'/0'/0/${String(groupIndex)}`,
        "secp256k1",
        master.derive(`m/44'/60'/0'/0/${String(groupIndex)}`).publicKey,
      ),
      leafRow(
        { kind: "leaf", template: "tron.bip44" },
        groupIndex,
        `m/44'/195'/0'/0/${String(groupIndex)}`,
        "secp256k1",
        master.derive(`m/44'/195'/0'/0/${String(groupIndex)}`).publicKey,
      ),
      leafRow(
        { kind: "leaf", template: "solana.bip44-change" },
        groupIndex,
        `m/44'/501'/${String(groupIndex)}'/0'`,
        "ed25519",
        ed25519.getPublicKey(slip.derive(`m/44'/501'/${String(groupIndex)}'/0'`).privateKey),
      ),
    );
  }
  const main84 = btcNode(master, 84, 0, 0);
  const main86 = btcNode(master, 86, 0, 0);
  const test84 = btcNode(testMaster, 84, 1, 0);
  keys.push(
    {
      ...accountRow(
        { kind: "btc.account", template: "btc.bip84", network: MAINNET },
        0,
        "m/84'/0'/0'",
        main84,
      ),
      xpub: main84.publicExtendedKey,
    },
    {
      ...accountRow(
        { kind: "btc.account", template: "btc.bip86", network: MAINNET },
        0,
        "m/86'/0'/0'",
        main86,
      ),
      xpub: main86.publicExtendedKey,
    },
    {
      ...accountRow(
        { kind: "btc.account", template: "btc.bip84", network: TESTNET },
        0,
        "m/84'/1'/0'",
        test84,
      ),
      xpub: test84.publicExtendedKey,
    },
  );
  const hardhat = evmAddress(master.derive("m/44'/60'/0'/0/0").publicKey);
  if (mnemonic.startsWith("test") && hardhat !== "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266") {
    // https://hardhat.org/hardhat-network/docs/reference#initial-state — the first Hardhat
    // account is the test…junk m/44'/60'/0'/0/0 key.
    throw new Error(`Hardhat address mismatch: ${hardhat}`);
  }
  return { mnemonic, fingerprint: fp8(master.fingerprint), keys };
};

const out = {
  comment:
    "chain.exportAccount vectors generated by scripts/vectors/export-account.ts: BIP-32 via the npm hdkey package (independent of the kernel's @scure/bip32), SLIP-10 ed25519 via micro-key-producer. Master fingerprint, evm.account (MetaMask m/44'/60'/0'), evm/tron/solana leaves for groups 0 and 1, and btc.account bip84/bip86 mainnet plus bip84 testnet for both public test mnemonics. Never use for funds.",
  wallets: MNEMONICS.map(wallet),
};

writeFileSync("vectors/chains/export-account.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote vectors/chains/export-account.json");
