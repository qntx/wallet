import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import Slip10 from "micro-key-producer/slip10.js";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { Factor, NullValue } from "@qntx/wallet/protocol";

import { keyIdOf } from "../derive/key-id.ts";
import type { KeyFamily } from "../derive/key-id.ts";
import type { PublicMaterial } from "../derive/material.ts";
import { KernelError } from "../errors.ts";
import { corePromptFor } from "../prompts.ts";
import { encodeBase58Ascii, encodeHexAscii } from "../secret/encode.ts";
import type { Secret } from "../secret/secret.ts";
import { wipe } from "../secret/secret.ts";
import { encodeHeader, parseKeyHeader } from "../vault/headers.ts";
import type { StoredRecord } from "../vault/store.ts";
import {
  EXTERNAL_CUSTODY_KINDS,
  findRecord,
  openRecord,
  sealRecord,
  verifyFactor,
} from "../vault/vault.ts";
import type { KernelContext } from "./context.ts";
import { withWalletSeed } from "./vault.ts";

/** Own-derivation bound: the first 20 account groups on every mnemonic wallet are "own". */
const OWN_GROUP_BOUND = 20;

export type ImportedKeyInfo = {
  readonly keyId: string;
  readonly family: KeyFamily;
  readonly address: string;
  readonly createdAt: number;
};

function secp256k1Key(
  input: Uint8Array,
  family: "EVM" | "TRON",
  addressOf: (publicKey: Uint8Array) => string,
): { secret: Uint8Array; publicKey: Uint8Array; address: string } {
  if (input.length !== 32) {
    throw new KernelError(
      "invalid-input",
      `${family === "EVM" ? "an" : "a"} ${family} private key is exactly 32 bytes`,
    );
  }
  try {
    const publicKey = secp256k1.getPublicKey(input, true);
    return { secret: input, publicKey, address: addressOf(publicKey) };
  } catch {
    throw new KernelError("invalid-input", "not a valid secp256k1 private key");
  }
}

function solanaKey(input: Uint8Array): {
  secret: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  const seed = input.length === 64 ? input.slice(0, 32) : input;
  if (seed.length !== 32) {
    throw new KernelError("invalid-input", "a Solana key is a 32-byte seed or a 64-byte keypair");
  }
  const publicKey = ed25519.getPublicKey(seed);
  if (input.length === 64 && !equalBytes(input.slice(32), publicKey)) {
    throw new KernelError(
      "invalid-input",
      "the keypair's public half does not match its secret half",
    );
  }
  return { secret: seed, publicKey, address: solanaAddressFromPublicKey(publicKey) };
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The decoded secret, its public key and its chain address — input is wiped by the caller. */
export function isKeyFamily(family: string): family is KeyFamily {
  return family === "evm" || family === "solana" || family === "bitcoin" || family === "tron";
}

export function keyMaterial(
  family: KeyFamily,
  secret: Uint8Array,
): { secret: Uint8Array; publicKey: Uint8Array; address: string } {
  if (family === "evm") {
    return secp256k1Key(secret, "EVM", evmAddressFromPublicKey);
  }
  if (family === "solana") {
    return solanaKey(secret);
  }
  if (family === "tron") {
    return secp256k1Key(secret, "TRON", tronAddressFromPublicKey);
  }
  throw new KernelError("invalid-input", `keys are not supported on ${family}`);
}

const keyHeaderOf = (family: KeyFamily, address: string, createdAt: number): string =>
  encodeHeader({ family, address, createdAt });

const keyInfoOf = (record: StoredRecord): ImportedKeyInfo => {
  const header = parseKeyHeader(record.header);
  return { keyId: record.id, ...header };
};

/**
 * Every address a wallet can derive inside the first OWN_GROUP_BOUND groups — EVM bip44, Solana
 * bip44-change plus TRON bip44. A key matching one of them is a second handle on an account the
 * wallet already owns, so import refuses it. External-custody wallets (card and hardware) answer
 * from their pinned public material; a path the record did not pin (`device-required`) is skipped —
 * anything else throws.
 */
async function ownAddresses(ctx: KernelContext, dek: Secret) {
  const addresses = new Set<string>();
  const externalAddresses = async (record: StoredRecord): Promise<void> => {
    // The owning module claimed the sealed body at unlock; the pin answers from its live state.
    let material: PublicMaterial;
    try {
      material = ctx.externalMaterial(record);
    } catch (error) {
      // An inert record (a device kind this build does not know) serves no material to collect.
      if (error instanceof KernelError && error.code === "unsupported") {
        return;
      }
      throw error;
    }
    {
      const h = 0x80000000; // hardened bit — the own paths match leafPath in modules/chains
      const collect = (
        settled: ReadonlyArray<PromiseSettledResult<Uint8Array>>,
        toAddress: (key: Uint8Array) => string,
      ): void => {
        for (const result of settled) {
          if (result.status === "fulfilled") {
            addresses.add(toAddress(result.value));
          } else if (
            !(result.reason instanceof KernelError && result.reason.code === "device-required")
          ) {
            throw result.reason instanceof Error ? result.reason : new Error("derivation failed");
          }
        }
      };
      const groups = Array.from({ length: OWN_GROUP_BOUND }, (_, group) => group);
      const [evm, tron, solana] = await Promise.all([
        Promise.allSettled(
          groups.map(async (group) => material.secp256k1([44 + h, 60 + h, h, 0, group])),
        ),
        Promise.allSettled(
          groups.map(async (group) => material.secp256k1([44 + h, 195 + h, h, 0, group])),
        ),
        Promise.allSettled(
          groups.map(async (group) => material.ed25519([44 + h, 501 + h, group + h, h])),
        ),
      ]);
      collect(evm, (key) => evmAddressFromPublicKey(key).toLowerCase());
      collect(tron, tronAddressFromPublicKey);
      collect(solana, solanaAddressFromPublicKey);
    }
  };
  await Promise.all(
    ctx.image.records
      .filter((r) => EXTERNAL_CUSTODY_KINDS.has(r.kind))
      .map(async (record) => externalAddresses(record)),
  );
  const entropyRecords = ctx.image.records.filter((r) => r.kind === "entropy");
  await Promise.all(
    entropyRecords.map(async (record) =>
      withWalletSeed(ctx.platform.pbkdf2, dek, record, (seed) => {
        const master = HDKey.fromMasterSeed(seed);
        const solanaRoot = Slip10.fromMasterSeed(seed);
        try {
          for (let group = 0; group < OWN_GROUP_BOUND; group += 1) {
            const evmChild = master.derive(`m/44'/60'/0'/0/${group}`);
            const tronChild = master.derive(`m/44'/195'/0'/0/${group}`);
            const solChild = solanaRoot.derive(`m/44'/501'/${group}'/0'`);
            try {
              const pub = evmChild.publicKey;
              if (pub !== null) {
                addresses.add(evmAddressFromPublicKey(pub).toLowerCase());
              }
              const tronPub = tronChild.publicKey;
              if (tronPub !== null) {
                addresses.add(tronAddressFromPublicKey(tronPub));
              }
              addresses.add(solanaAddressFromPublicKey(ed25519.getPublicKey(solChild.privateKey)));
            } finally {
              evmChild.wipePrivateData();
              tronChild.wipePrivateData();
              wipe(solChild.privateKey);
            }
          }
        } finally {
          master.wipePrivateData();
          wipe(solanaRoot.privateKey);
        }
        return undefined;
      }),
    ),
  );
  return addresses;
}

export async function importKey(
  ctx: KernelContext,
  params: { family: string; secret: Uint8Array },
  requestSession: string | undefined,
): Promise<ImportedKeyInfo> {
  const { dek } = ctx.session.require(requestSession);
  if (!isKeyFamily(params.family)) {
    throw new KernelError("invalid-input", `unknown family ${params.family}`);
  }
  const { family } = params;
  try {
    const material = keyMaterial(family, params.secret);
    try {
      const keyId = keyIdOf(family, material.publicKey);
      if (ctx.image.records.some((r) => r.kind === "key" && r.id === keyId)) {
        throw new KernelError("conflict", "the key is already imported");
      }
      const own = await ownAddresses(ctx, dek);
      if (own.has(material.address.toLowerCase()) || own.has(material.address)) {
        throw new KernelError(
          "conflict",
          "the key is an account of a wallet already in this vault",
        );
      }
      const createdAt = ctx.platform.now();
      const record = sealRecord(
        ctx.platform,
        dek,
        "key",
        keyId,
        keyHeaderOf(family, material.address, createdAt),
        material.secret,
      );
      await ctx.commit([{ op: "put-record", record }]);
      return { keyId, family, address: material.address, createdAt };
    } finally {
      wipe(material.secret);
    }
  } finally {
    // A 64-byte keypair input survives `material.secret` — wipe the request bytes like the
    // mnemonic paths do.
    wipe(params.secret);
  }
}

export function listKeys(ctx: KernelContext): ReadonlyArray<ImportedKeyInfo> {
  return ctx.image.records.filter((r) => r.kind === "key").map(keyInfoOf);
}

export async function removeKey(
  ctx: KernelContext,
  params: { verify: Factor; keyId: string },
  requestSession: string | undefined,
): Promise<NullValue> {
  const { dek } = ctx.session.require(requestSession);
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(ctx.platform.keystore, "remove-private-key"),
  );
  findRecord(ctx.image, "key", params.keyId);
  await ctx.commit([{ op: "delete-record", kind: "key", id: params.keyId }]);
  return null;
}

/**
 * The secret in the family's canonical encoding — `0x`-prefixed hex for EVM, base58 for Solana,
 * bare hex for TRON — as wipeable ASCII bytes. The encoders live in `src/secret/encode.ts` because
 * the library encoders return strings, and a private key held in a JS string can never be zeroed.
 */
export async function exportKey(
  ctx: KernelContext,
  params: { verify: Factor; keyId: string },
  requestSession: string | undefined,
): Promise<Uint8Array> {
  const { dek } = ctx.session.require(requestSession);
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(ctx.platform.keystore, "export-private-key"),
  );
  const record = findRecord(ctx.image, "key", params.keyId);
  const header = parseKeyHeader(record.header);
  const secret = openRecord(dek, record);
  try {
    if (header.family === "evm") {
      return encodeHexAscii(secret, "0x");
    }
    if (header.family === "solana") {
      return encodeBase58Ascii(secret);
    }
    if (header.family === "tron") {
      return encodeHexAscii(secret, "");
    }
    throw new KernelError("invalid-input", `keys are not supported on ${header.family}`);
  } finally {
    wipe(secret);
  }
}
