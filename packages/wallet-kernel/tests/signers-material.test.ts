/**
 * `pinnedMaterial` against independent oracles: exact pinned nodes, non-hardened tails derived
 * publicly by @scure/bip32 from the test seed (the pin is that seed's account nodes), hardened
 * tails and the master key as `device-required`, ed25519 exact-only, the account xpub under the
 * network's version bytes, and the claimed fingerprint.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hash160 } from "@scure/btc-signer/utils.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";

import { KernelError } from "../src/errors.ts";
import type { HardwarePin } from "../src/modules/signers/driver.ts";
import { pinnedMaterial } from "../src/modules/signers/material.ts";
import { edAt, masterFingerprint, nodeAt, SOLANA_LEAF } from "./signers-fake.ts";

const HARDENED = 0x80000000;
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = mnemonicToSeedSync(MNEMONIC);

const EVM_ACCOUNT = [44 + HARDENED, 60 + HARDENED, HARDENED];
const BTC84_ACCOUNT = [84 + HARDENED, HARDENED, HARDENED];

const pin: HardwarePin = {
  fingerprint: masterFingerprint(SEED),
  nodes: [nodeAt(SEED, EVM_ACCOUNT), nodeAt(SEED, BTC84_ACCOUNT)],
  ed25519: [edAt(SEED, SOLANA_LEAF)],
};

const material = pinnedMaterial(pin);

const code = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    return (error as KernelError).code;
  }
  throw new Error("expected the call to fail");
};

describe("pinnedMaterial", () => {
  it("serves an exact pinned node", async () => {
    await expect(material.secp256k1(EVM_ACCOUNT)).resolves.toStrictEqual(
      HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'").publicKey,
    );
  });

  it("derives a non-hardened tail publicly, matching the seed's own derivation", async () => {
    const path = [...EVM_ACCOUNT, 0, 5];
    const expected = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/0/5").publicKey;
    await expect(material.secp256k1(path)).resolves.toStrictEqual(expected);
    // A deeper tail still derives under the same account node.
    await expect(material.secp256k1([...EVM_ACCOUNT, 1, 0, 2])).resolves.toStrictEqual(
      HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'/1/0/2").publicKey,
    );
  });

  it("requires the device for a hardened tail, an unpinned path and the master key", async () => {
    await expect(code(async () => material.secp256k1([...EVM_ACCOUNT, 0, HARDENED]))).resolves.toBe(
      "device-required",
    );
    await expect(
      code(async () => material.secp256k1([44 + HARDENED, 118 + HARDENED])),
    ).resolves.toBe("device-required");
    await expect(code(async () => material.secp256k1([]))).resolves.toBe("device-required");
    await expect(code(async () => material.ed25519([]))).resolves.toBe("device-required");
  });

  it("serves ed25519 at its exact pinned path only", async () => {
    await expect(material.ed25519(SOLANA_LEAF)).resolves.toStrictEqual(
      ed25519.getPublicKey(Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey),
    );
    // The sibling hardened leaf and any softer path are device-required — no public derivation.
    await expect(
      code(async () => material.ed25519([44 + HARDENED, 501 + HARDENED, HARDENED, 1 + HARDENED])),
    ).resolves.toBe("device-required");
    await expect(code(async () => material.ed25519([44 + HARDENED, 501 + HARDENED]))).resolves.toBe(
      "device-required",
    );
  });

  it("serves the account xpub under the network's version bytes", async () => {
    const net = bitcoinNetwork("bip122:000000000019d6689c085ae165831e93");
    // The independent oracle: serialize the seed's own account node with the same versions.
    const direct = HDKey.fromMasterSeed(SEED, net.bip32).derive("m/84'/0'/0'").publicExtendedKey;
    await expect(material.extendedPublicKey(BTC84_ACCOUNT, net.bip32)).resolves.toBe(direct);
  });

  it("requires the device for an xpub at an unpinned or parentless node", async () => {
    const net = bitcoinNetwork("bip122:000000000019d6689c085ae165831e93");
    await expect(
      code(async () => material.extendedPublicKey([49 + HARDENED, HARDENED, HARDENED], net.bip32)),
    ).resolves.toBe("device-required");
    await expect(code(async () => material.extendedPublicKey([], net.bip32))).resolves.toBe(
      "device-required",
    );
    const { parent, ...withoutParent } = nodeAt(SEED, BTC84_ACCOUNT);
    void parent;
    const noParent = pinnedMaterial({
      fingerprint: pin.fingerprint,
      nodes: [withoutParent],
      ed25519: pin.ed25519,
    });
    await expect(
      code(async () => noParent.extendedPublicKey(BTC84_ACCOUNT, net.bip32)),
    ).resolves.toBe("device-required");
  });

  it("reports the pinned master fingerprint", async () => {
    const master = HDKey.fromMasterSeed(SEED).publicKey;
    if (master === null) {
      throw new Error("no master key");
    }
    await expect(material.fingerprint()).resolves.toStrictEqual(hash160(master).subarray(0, 4));
  });
});
