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

import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";

import { pinnedMaterial } from "../src/derive/pinned.ts";
import { KernelError } from "../src/errors.ts";
import { seedKeys } from "../src/modules/chains/keys.ts";
import type { HardwarePin } from "../src/modules/signers/driver.ts";
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

const material = pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin, confirmed: [] });

const MASTER = HDKey.fromMasterSeed(SEED).publicKey;
if (MASTER === null) {
  throw new Error("no master key");
}

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
    await expect(code(async () => material.ed25519([...SOLANA_LEAF, HARDENED]))).resolves.toBe(
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
      confirmed: [],
      fingerprint: pin.fingerprint,
      keys: { nodes: [withoutParent], ed25519: pin.ed25519 },
    });
    await expect(
      code(async () => noParent.extendedPublicKey(BTC84_ACCOUNT, net.bip32)),
    ).resolves.toBe("device-required");
  });

  it("reports the pinned master fingerprint", async () => {
    await expect(material.fingerprint()).resolves.toStrictEqual(hash160(MASTER).subarray(0, 4));
  });

  it("a card-shaped pin (master, no parent) serves the master and derives the xpub parent fp", async () => {
    const keys = {
      nodes: [nodeAt(SEED, BTC84_ACCOUNT), nodeAt(SEED, [84 + HARDENED, HARDENED])].map(
        ({ parent: _parent, ...rest }) => rest,
      ),
      ed25519: [],
    };
    const cardPin = pinnedMaterial({ master: MASTER, keys, confirmed: "all" });
    await expect(cardPin.secp256k1([])).resolves.toStrictEqual(MASTER);
    // No parent pinned: the xpub's parent fp is hash160 of the cached m/84'/0' public key.
    const net = bitcoinNetwork("bip122:000000000019d6689c085ae165831e93");
    const oracle = HDKey.fromMasterSeed(SEED, net.bip32).derive("m/84'/0'/0'");
    await expect(cardPin.extendedPublicKey(BTC84_ACCOUNT, net.bip32)).resolves.toBe(
      oracle.publicExtendedKey,
    );
    // And a derived node carries the same fingerprint report: hash160(master)[0..4].
    await expect(cardPin.fingerprint()).resolves.toStrictEqual(hash160(MASTER).subarray(0, 4));
  });

  it("serializes the explicitly pinned parent fingerprint, never a derived one", async () => {
    const alien = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const pinned = pinnedMaterial({
      confirmed: [],
      fingerprint: pin.fingerprint,
      keys: {
        nodes: [{ ...nodeAt(SEED, BTC84_ACCOUNT), parent: alien }],
        ed25519: [],
      },
    });
    const net = bitcoinNetwork("bip122:000000000019d6689c085ae165831e93");
    const xpub = await pinned.extendedPublicKey(BTC84_ACCOUNT, net.bip32);
    const decoded = HDKey.fromExtendedKey(xpub, net.bip32);
    expect(decoded.parentFingerprint).toBe(new DataView(alien.buffer, 0, 4).getUint32(0));
  });

  it("a pin carrying neither master nor fingerprint is integrity, its keys device-required", async () => {
    const empty = pinnedMaterial({ keys: { nodes: [], ed25519: [] }, confirmed: [] });
    await expect(code(async () => empty.secp256k1([]))).resolves.toBe("device-required");
    await expect(code(async () => empty.ed25519(SOLANA_LEAF))).resolves.toBe("device-required");
    await expect(code(async () => empty.fingerprint())).resolves.toBe("integrity");
  });

  it("a fingerprint claim that contradicts the pinned master is integrity", async () => {
    const bad = pinnedMaterial({
      confirmed: [],
      master: MASTER,
      fingerprint: new Uint8Array([0, 0, 0, 0]),
      keys: pin,
    });
    await expect(code(async () => bad.fingerprint())).resolves.toBe("integrity");
    // A matching claim passes — the master still wins the answer.
    const fine = pinnedMaterial({
      master: MASTER,
      fingerprint: pin.fingerprint,
      keys: pin,
      confirmed: "all",
    });
    await expect(fine.fingerprint()).resolves.toStrictEqual(hash160(MASTER).subarray(0, 4));
  });
});

describe("pinnedMaterial.confirmed", () => {
  const evmLeaf = (group: number): KeyPath => [44 + HARDENED, 60 + HARDENED, HARDENED, 0, group];

  it("reports the serving entry's flag — a leaf under a confirmed account node confirms", async () => {
    const unconfirmed = pinnedMaterial({
      fingerprint: pin.fingerprint,
      keys: pin,
      confirmed: [],
    });
    await expect(unconfirmed.confirmed("secp256k1", evmLeaf(0))).resolves.toBe(false);
    /* The serving entry of a group-7 leaf is the same m/44'/60'/0' node — confirming it
       confirms every leaf it serves, whichever group. */
    const confirmed = pinnedMaterial({
      fingerprint: pin.fingerprint,
      keys: pin,
      confirmed: [EVM_ACCOUNT],
    });
    await expect(confirmed.confirmed("secp256k1", evmLeaf(0))).resolves.toBe(true);
    await expect(confirmed.confirmed("secp256k1", evmLeaf(7))).resolves.toBe(true);
    // A different entry's confirmation does not leak onto this one.
    const other = pinnedMaterial({
      fingerprint: pin.fingerprint,
      keys: pin,
      confirmed: [[84 + HARDENED, HARDENED, HARDENED]],
    });
    await expect(other.confirmed("secp256k1", evmLeaf(0))).resolves.toBe(false);
  });

  it("a leaf under nested entries confirms by its deepest serving entry only", async () => {
    /* A pin holding both an account node and a non-hardened child beneath it serves the
       leaf through the deeper entry: confirming the shallow parent does not reach the leaf,
       and confirming the deep entry is exactly what reaches it. */
    const PARENT = [44 + HARDENED, 195 + HARDENED];
    const CHILD = [44 + HARDENED, 195 + HARDENED, 0];
    const LEAF = [...CHILD, 0, 5];
    const nested = (confirmed: KeyPath[] | "all") =>
      pinnedMaterial({
        fingerprint: pin.fingerprint,
        keys: {
          nodes: [nodeAt(SEED, PARENT), nodeAt(SEED, CHILD)],
          ed25519: [],
        },
        confirmed,
      });
    await expect(nested([PARENT]).confirmed("secp256k1", LEAF)).resolves.toBe(false);
    await expect(nested([CHILD]).confirmed("secp256k1", LEAF)).resolves.toBe(true);
    // The leaf itself still derives publicly under the deepest ancestor.
    const derived = HDKey.fromMasterSeed(SEED).derive("m/44'/195'/0/0/5");
    await expect(nested([]).secp256k1(LEAF)).resolves.toStrictEqual(derived.publicKey);
  });

  it("no serving entry is device-required, and card material confirms everything", async () => {
    const unconfirmed = pinnedMaterial({
      fingerprint: pin.fingerprint,
      keys: pin,
      confirmed: [],
    });
    await expect(code(async () => unconfirmed.confirmed("secp256k1", [HARDENED]))).resolves.toBe(
      "device-required",
    );
    await expect(
      code(async () =>
        unconfirmed.confirmed("ed25519", [44 + HARDENED, 501 + HARDENED, HARDENED, 1 + HARDENED]),
      ),
    ).resolves.toBe("device-required");
    const confirmedEd = pinnedMaterial({
      fingerprint: pin.fingerprint,
      keys: pin,
      confirmed: [SOLANA_LEAF],
    });
    await expect(confirmedEd.confirmed("ed25519", SOLANA_LEAF)).resolves.toBe(true);
    const card = pinnedMaterial({
      master: MASTER,
      keys: pin,
      confirmed: "all",
    });
    await expect(card.confirmed("secp256k1", evmLeaf(0))).resolves.toBe(true);
    await expect(card.confirmed("ed25519", SOLANA_LEAF)).resolves.toBe(true);
  });

  it("seed material confirms every path — the kernel holds the secret", async () => {
    const keys = seedKeys(SEED, (n) => new Uint8Array(n).fill(1));
    try {
      await expect(keys.material.confirmed("secp256k1", evmLeaf(0))).resolves.toBe(true);
      await expect(keys.material.confirmed("ed25519", SOLANA_LEAF)).resolves.toBe(true);
    } finally {
      keys.wipe();
    }
  });
});
