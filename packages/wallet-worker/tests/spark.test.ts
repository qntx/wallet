/**
 * Spark enclave end to end on the real Node host with the real spark.wasm: the enclave's pooled
 * signer must match a locally-created signer byte-for-byte, signatures must verify with the right
 * public keys, lock/delete semantics must hold, and a tampered wasm must fail integrity while
 * nostr keeps working.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { SigHash, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import type { SparkNetwork, SparkSigner } from "@qntx/spark/signer";
import { loadSparkWasm } from "@qntx/spark-wasm/browser";
import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import { MAX_REQUEST_BYTES, requestBytes } from "@qntx/wallet/protocol";
import type { ProtocolValue } from "@qntx/wallet/protocol";
import { spark } from "@qntx/wallet/spark";

import { createNodeWallet, createSoftwarePasskey } from "../src/node/index.ts";

const KERNEL_URL = new URL("../dist/kernel.node.js", import.meta.url);
const WASM_PATH = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@qntx",
  "spark-wasm",
  "dist",
  "spark.wasm",
);
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  vaultSalt: "qntx/vault",
};
const PASSWORD = "correct horse battery staple";
const ACCOUNTS = JSON.parse(
  await readFile(new URL("../../../vectors/spark-accounts.json", import.meta.url), "utf8"),
) as {
  mnemonic: string;
  vectors: ReadonlyArray<{
    groupIndex: number;
    network: SparkNetwork;
    identityPublicKey: string;
  }>;
};

const seed = pbkdf2(
  sha512,
  utf8ToBytes(ACCOUNTS.mnemonic.normalize("NFKD")),
  utf8ToBytes("mnemonic"),
  { c: 2048, dkLen: 64 },
);

async function localSigner(network: SparkNetwork, account: number): Promise<SparkSigner> {
  const crypto = await loadSparkWasm({ module: await readFile(WASM_PATH) });
  return createSparkSigner({
    crypto,
    accountKey: sparkAccountKey(seed, network, account),
    network,
    random: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  });
}

async function nodeWallet(kernelUrl: URL = KERNEL_URL): Promise<Wallet> {
  return createNodeWallet({
    passkey: PASSKEY_CONFIG,
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(hexToBytes("cc".repeat(32))),
    kernelUrl,
  });
}

function code(error: unknown): string {
  if (error instanceof WalletError) {
    return error.code;
  }
  throw error;
}

/** Hand-encoded spark_authn.Challenge {version, timestamp, nonce, public_key}. */
function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let n = value;
  while (n >= 0x80) {
    bytes.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}

function challenge(publicKey: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(32).fill(7);
  return concatBytes(
    concatBytes(Uint8Array.of(0x08), varint(1)), // version = 1
    concatBytes(Uint8Array.of(0x10), varint(1_700_000_000)), // timestamp
    concatBytes(Uint8Array.of(0x1a, 0x20), nonce),
    concatBytes(Uint8Array.of(0x22, 0x21), publicKey),
  );
}

function taprootTarget(): { transaction: Uint8Array; inputIndex: 0; prevouts: { script: Uint8Array; amount: number }[] } {
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: new Uint8Array(32).fill(3), index: 0 });
  tx.addOutput({
    script: concatBytes(Uint8Array.of(0x51, 0x20), new Uint8Array(32).fill(4)),
    amount: 900n,
  });
  return {
    transaction: tx.toBytes(),
    inputIndex: 0,
    prevouts: [
      {
        script: concatBytes(Uint8Array.of(0x51, 0x20), new Uint8Array(32).fill(5)),
        amount: 1_000,
      },
    ],
  };
}

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const prefix = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(prefix, prefix, data));
}

describe("spark enclave on the node host", () => {
  it("derives the vector identity keys and leaf keys, signs verifiably", async () => {
    const wallet = await nodeWallet();
    const created = await wallet.wallets.importMnemonic({
      mnemonic: ACCOUNTS.mnemonic,
      factor: { kind: "password", password: PASSWORD },
    });

    // Identity keys for every vector row — byte-for-byte against the real wasm.
    for (const vector of ACCOUNTS.vectors) {
      const signer = spark(wallet).signer({
        walletId: created.walletId,
        groupIndex: vector.groupIndex,
        network: vector.network,
      });
      const identity = await signer.identityPublicKey();
      expect(bytesToHex(identity)).toBe(vector.identityPublicKey);
      const local = await localSigner(
        vector.network,
        vector.network === "mainnet" ? vector.groupIndex + 1 : vector.groupIndex,
      );
      expect(identity).toStrictEqual(await local.identityPublicKey());
      local.dispose();
    }

    const regtest0 = spark(wallet).signer({
      walletId: created.walletId,
      groupIndex: 0,
      network: "regtest",
    });
    const identity = await regtest0.identityPublicKey();
    const local = await localSigner("regtest", 0);

    // Leaf public keys match the local signer (and chunk past MAX_BATCH).
    const leafIds = Array.from(
      { length: 70 },
      (_, i) => `3f7b2e1c-1a2b-4c3d-8e4f-${String(i).padStart(12, "0")}`,
    );
    const enclaveKeys = await regtest0.publicKeys(
      leafIds.map((leafId) => ({ type: "leaf" as const, leafId })),
    );
    expect(enclaveKeys).toHaveLength(70);
    const localKeys = await local.publicKeys(
      leafIds.map((leafId) => ({ type: "leaf" as const, leafId })),
    );
    for (const [i, key] of enclaveKeys.entries()) {
      expect(bytesToHex(key)).toBe(bytesToHex(localKeys[i]!));
    }

    // signIdentity so-challenge: DER ECDSA over sha256(challenge) with the identity key.
    const challengeBytes = challenge(identity);
    const signature = await regtest0.signIdentity({
      kind: "so-challenge",
      challenge: challengeBytes,
    });
    const compact = secp256k1.Signature.fromBytes(signature, "der").toBytes();
    expect(secp256k1.verify(compact, sha256(challengeBytes), identity, { prehash: false })).toBe(
      true,
    );

    // signKeySpend: BIP-340 over the target sighash with the TapTweak-tweaked leaf key.
    const target = taprootTarget();
    const leafId = "3f7b2e1c-1a2b-4c3d-8e4f-000000000000";
    const [internalCompressed] = await regtest0.publicKeys([{ type: "leaf", leafId }]);
    const tx = Transaction.fromRaw(target.transaction, { allowUnknownOutputs: true });
    const sighash = tx.preimageWitnessV1(
      0,
      target.prevouts.map((p) => p.script),
      SigHash.DEFAULT,
      target.prevouts.map((p) => BigInt(p.amount)),
    );
    const internal = secp256k1.Point.fromBytes(internalCompressed!);
    const tweak = taggedHash("TapTweak", internalCompressed!.subarray(1));
    const tweaked = internal
      .add(secp256k1.Point.BASE.multiply(BigInt(`0x${bytesToHex(tweak)}`)))
      .toAffine();
    const xHex = tweaked.x.toString(16).padStart(64, "0");
    const sig = await regtest0.signKeySpend({ type: "leaf", leafId }, target);
    expect(schnorr.verify(sig, sighash, hexToBytes(xHex))).toBe(true);

    // prepareLightningReceive: one ECIES package per regtest operator.
    const receive = await regtest0.prepareLightningReceive();
    expect(receive.paymentHash).toHaveLength(32);
    const localOps = Object.keys(await local.prepareLightningReceive().then((r) => r.operatorPackages));
    expect(Object.keys(receive.operatorPackages).sort()).toStrictEqual(localOps.sort());
    local.dispose();

    // Lock: every spark.* call is "locked"; a fresh unlock restores the same identity.
    await wallet.vault.lock();
    await expect(regtest0.identityPublicKey()).rejects.toSatisfy(
      (e) => code(e) === "locked",
    );
    await wallet.vault.unlock({ kind: "password", password: PASSWORD });
    const again = await regtest0.identityPublicKey();
    expect(again).toStrictEqual(identity);

    // Delete the wallet: spark calls report not-found; nostr derived keys are unaffected.
    await wallet.wallets.delete(created.walletId, {
      kind: "password",
      password: PASSWORD,
    });
    await expect(regtest0.identityPublicKey()).rejects.toSatisfy(
      (e) => code(e) === "not-found",
    );
    await wallet.destroy();
  }, 180_000);

  it("a tampered spark.wasm fails integrity while nostr still works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wallet-spark-test-"));
    await copyFile(new URL("../dist/kernel.node.js", import.meta.url), join(dir, "kernel.node.js"));
    const wasm = new Uint8Array(await readFile(WASM_PATH));
    wasm[10] = (wasm[10] ?? 0) ^ 0xff;
    await writeFile(join(dir, "spark.wasm"), wasm);
    const wallet = await nodeWallet(new URL(`file://${join(dir, "kernel.node.js")}`));
    const created = await wallet.wallets.importMnemonic({
      mnemonic: ACCOUNTS.mnemonic,
      factor: { kind: "password", password: PASSWORD },
    });
    const signer = spark(wallet).signer({
      walletId: created.walletId,
      groupIndex: 0,
      network: "regtest",
    });
    await expect(signer.identityPublicKey()).rejects.toSatisfy(
      (e) => code(e) === "integrity",
    );
    // nostr is independent of the spark backend.
    const key = await nostr(wallet).deriveKey(created.walletId, 0);
    expect(key.publicKey).toHaveLength(64);
    await wallet.destroy();
  }, 120_000);

  it("a nostr-only session never loads spark.wasm", async () => {
    // The worker entry reads ./spark.wasm beside kernel.node.js only when backends.spark is
    // called — a kernel bundle shipped without the wasm file must serve nostr fine.
    const dir = await mkdtemp(join(tmpdir(), "wallet-spark-none-"));
    await copyFile(new URL("../dist/kernel.node.js", import.meta.url), join(dir, "kernel.node.js"));
    const wallet = await nodeWallet(new URL(`file://${join(dir, "kernel.node.js")}`));
    const created = await wallet.wallets.importMnemonic({
      mnemonic: ACCOUNTS.mnemonic,
      factor: { kind: "password", password: PASSWORD },
    });
    const key = await nostr(wallet).deriveKey(created.walletId, 0);
    expect(key.publicKey).toHaveLength(64);
    await expect(
      spark(wallet)
        .signer({ walletId: created.walletId, groupIndex: 0, network: "regtest" })
        .identityPublicKey(),
    ).rejects.toSatisfy((e) => code(e) === "unavailable");
    await wallet.destroy();
  }, 120_000);

  it("library objects carrying extra keys (protobuf-es $typeName) are projected to the wire shape", async () => {
    // decorate rebuilds every plain object with surplus keys — the shape a SparkClient actually
    // hands the signer (protobuf-es messages carry `$typeName`); the proxy must strip them.
    const decorate = (value: unknown): unknown => {
      if (value instanceof Uint8Array || typeof value !== "object" || value === null) {
        return value;
      }
      if (Array.isArray(value)) {
        return value.map(decorate);
      }
      const out: Record<string, unknown> = { $typeName: "spark.Fake", junkField: 0 };
      for (const [k, v] of Object.entries(value)) {
        out[k] = decorate(v);
      }
      return out;
    };

    const wallet = await nodeWallet();
    const created = await wallet.wallets.importMnemonic({
      mnemonic: ACCOUNTS.mnemonic,
      factor: { kind: "password", password: PASSWORD },
    });
    const signer = spark(wallet).signer({
      walletId: created.walletId,
      groupIndex: 0,
      network: "regtest",
    });
    const identity = await signer.identityPublicKey();
    const leafId = "3f7b2e1c-1a2b-4c3d-8e4f-000000000000";
    const leafKey = { type: "leaf" as const, leafId };

    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        console.log(`STEP FAILED ${name}:`, error instanceof Error ? error.message : error);
        throw error;
      }
    };
    const keys = await step("publicKeys", () =>
      signer.publicKeys([decorate(leafKey) as typeof leafKey]),
    );
    expect(keys).toHaveLength(1);

    const challengeBytes = challenge(identity);
    await step("signIdentity", () =>
      signer.signIdentity(
        decorate({ kind: "so-challenge", challenge: challengeBytes }) as never,
      ),
    );

    const target = decorate(taprootTarget()) as ReturnType<typeof taprootTarget>;
    await step("signKeySpend", () =>
      signer.signKeySpend(decorate(leafKey) as typeof leafKey, target),
    );

    // FROST round: a real commitment from this signer plus a simulated operator group —
    // valid scalars/points like the spark repo's frostGroup fixture, decorated with extras.
    const [commitment] = await signer.newCommitments(1);
    let verifyingKey: Uint8Array | undefined;
    for (let s = 2n; verifyingKey === undefined; s++) {
      const point = secp256k1.Point.BASE.multiply(s);
      if ((point.toAffine().y & 1n) === 0n) {
        verifyingKey = point.toBytes(true);
      }
    }
    const be32 = (v: bigint): string => v.toString(16).padStart(64, "0");
    const operatorCommitments = [1n, 2n].map((id, i) => ({
      identifier: be32(id),
      commitment: {
        hiding: secp256k1.Point.BASE.multiply(0x1000n + BigInt(i) * 7n).toBytes(true),
        binding: secp256k1.Point.BASE.multiply(0x2000n + BigInt(i) * 7n).toBytes(true),
      },
    }));
    const share = await step("signFrost", () =>
      signer.signFrost([
        decorate({
          key: leafKey,
          target: taprootTarget(),
          verifyingKey,
          commitment,
          operatorCommitments,
        }) as never,
      ]),
    );
    expect(share[0]).toHaveLength(32);

    const prepared = await step("prepareTransfer", () =>
      signer.prepareTransfer(
        decorate({
          transferId: "3f7b2e1c-1a2b-4c3d-8e4f-0000000000ff",
          leaves: [{ leafId, key: leafKey, receiverIdentityPublicKey: identity }],
        }) as never,
      ),
    );
    expect(prepared.leaves).toHaveLength(1);
    const ciphers = prepared.leaves.map((l) => l.secretCipher);
    const received = await step("receivedPublicKeys", () =>
      signer.receivedPublicKeys(ciphers),
    );
    expect(received).toHaveLength(1);
    const claim = await step("prepareClaim", () =>
      signer.prepareClaim(
        decorate({
          transferId: "3f7b2e1c-1a2b-4c3d-8e4f-0000000000fe",
          leaves: ciphers.map((secretCipher, i) => ({
            leafId: `3f7b2e1c-1a2b-4c3d-8e4f-00000000009${i}`,
            secretCipher,
          })),
        }) as never,
      ),
    );
    expect(Object.keys(claim.operatorPackages).length).toBeGreaterThan(0);
    const receive = await step("prepareLightningReceive", () =>
      signer.prepareLightningReceive(),
    );
    expect(Object.keys(receive.operatorPackages).length).toBeGreaterThan(0);

    // An unknown discriminant must fail in the proxy, before any kernel request.
    await expect(
      signer.publicKeys([{ type: "bogus" as never, leafId } as never]),
    ).rejects.toSatisfy((e) => e instanceof WalletError && e.code === "invalid-input");
    await expect(
      signer.signIdentity({ kind: "bogus" } as never),
    ).rejects.toSatisfy((e) => e instanceof WalletError && e.code === "invalid-input");
    await wallet.destroy();
  }, 120_000);

  it("256-leaf prepareTransfer fits the request cap", async () => {
    const local = await localSigner("regtest", 0);
    const account = { walletId: "0011223344556677", groupIndex: 0, network: "regtest" };
    const receiverIdentityPublicKey = await local.identityPublicKey();
    const leaves = Array.from({ length: 256 }, (_, i) => ({
      leafId: `3f7b2e1c-1a2b-4c3d-8e4f-${String(i).padStart(12, "0")}`,
      key: { type: "leaf" as const, leafId: `3f7b2e1c-1a2b-4c3d-8e4f-${String(i).padStart(12, "0")}` },
      receiverIdentityPublicKey,
    }));
    const params: ProtocolValue = { account, request: { transferId: leaves[0]!.leafId, leaves } };
    const requestSize = requestBytes(params);
    const result = await local.prepareTransfer({
      transferId: leaves[0]!.leafId,
      leaves,
    });
    const resultSize = requestBytes(result);
    local.dispose();
    expect(requestSize).toBeLessThan(MAX_REQUEST_BYTES);
    expect(resultSize).toBeLessThan(MAX_REQUEST_BYTES);
    console.log(`256-leaf prepareTransfer: request ${requestSize} B, result ${resultSize} B`);
  }, 120_000);
});
