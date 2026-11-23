/**
 * The vault manifest: one record, sealed under the DEK, that commits to the vault's whole structure
 * — the format, the revision, the keyId and every other record and factor row byte for byte. Every
 * content commit rewrites it in the same transaction and every reload under a session checks it, so
 * a store writer without the DEK can neither put back a row the vault dropped (a retired backup
 * key, a disabled policy, a deleted wallet), nor delete, add or alter one, nor rewrite the format,
 * nor raise the revision the manifest binds. The floor catching an older committed image — still
 * consistent, manifest and all — lives outside the store in the vault anchor (vault/anchor.ts).
 *
 * Digest = SHA-256(lp("qntx-wallet/vault/v1/manifest") ‖ u32be(format) ‖ u64be(revision) ‖
 * lp(keyId) ‖ u32be(#records) ‖ per record: lp(kind) ‖ lp(id) ‖ lp(header) ‖ lp(sealed) ‖
 * u32be(#factors) ‖ per factor: lp(kind) ‖ lp(id) ‖ lp(header) ‖ lp(sealed)), where lp(x) =
 * u32be(byteLength(x)) ‖ x, strings are UTF-8, the manifest record itself is left out, records are
 * ordered by (kind, id) and factors by id, both in UTF-16 code-unit order.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../errors.ts";
import type { KernelPlatform } from "../platform.ts";
import type { Secret } from "../secret/secret.ts";
import { wipe } from "../secret/secret.ts";
import { open, recordContext, seal } from "./envelope.ts";
import { applyStoreOps } from "./memory.ts";
import type { StoredFactor, StoredRecord, StoreOp, VaultImage } from "./store.ts";

export const MANIFEST_KIND = "manifest";
export const MANIFEST_ID = "default";
/** The manifest has no public content. */
export const MANIFEST_HEADER = "{}";
const DOMAIN = "qntx-wallet/vault/v1/manifest";

export const isManifestRecord = (record: StoredRecord): boolean => record.kind === MANIFEST_KIND;

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** U64be as two u32 words — bare Hermes has no BigInt reliance here. */
function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x1_00_00_00_00));
  view.setUint32(4, value % 0x1_00_00_00_00);
  return out;
}

/** The structure digest of `image`, the manifest record itself excluded. */
export function manifestDigest(image: VaultImage): Uint8Array {
  const { meta } = image;
  if (meta === undefined) {
    throw new KernelError("integrity", "unreachable: manifest of an uninitialized vault");
  }
  const hash = sha256.create();
  const lp = (value: string | Uint8Array): void => {
    const bytes = typeof value === "string" ? utf8ToBytes(value) : value;
    hash.update(u32(bytes.length));
    hash.update(bytes);
  };
  const row = (entry: StoredRecord | StoredFactor): void => {
    lp(entry.kind);
    lp(entry.id);
    lp(entry.header);
    lp(entry.sealed);
  };
  lp(DOMAIN);
  hash.update(u32(meta.format));
  hash.update(u64(meta.revision));
  lp(meta.keyId);
  const records = image.records
    .filter((record) => !isManifestRecord(record))
    .sort((a, b) => byCodeUnits(a.kind, b.kind) || byCodeUnits(a.id, b.id));
  hash.update(u32(records.length));
  for (const record of records) {
    row(record);
  }
  const factors = [...image.factors].sort((a, b) => byCodeUnits(a.id, b.id));
  hash.update(u32(factors.length));
  for (const factor of factors) {
    row(factor);
  }
  return hash.digest();
}

/** Whether a commit changes what the manifest covers (and so must rewrite it). */
export function changesStructure(ops: ReadonlyArray<StoreOp>): boolean {
  return (
    !ops.some((op) => op.op === "clear") &&
    ops.some(
      (op) =>
        op.op === "init" ||
        op.op === "set-key-id" ||
        op.op === "put-record" ||
        op.op === "delete-record" ||
        op.op === "put-factor" ||
        op.op === "delete-factor",
    )
  );
}

/**
 * `ops` plus the manifest of the image they produce from `image`, sealed under `dek` — the DEK the
 * committed image is sealed under. The caller commits the result atomically.
 */
export function withManifest(
  platform: KernelPlatform,
  image: VaultImage,
  ops: ReadonlyArray<StoreOp>,
  dek: Secret,
): StoreOp[] {
  const next = applyStoreOps(image, ops);
  const digest = manifestDigest(next);
  try {
    const sealed = dek.use((key) =>
      seal(
        key,
        digest,
        recordContext(MANIFEST_KIND, MANIFEST_ID),
        MANIFEST_HEADER,
        platform.random,
      ),
    );
    const record = { kind: MANIFEST_KIND, id: MANIFEST_ID, header: MANIFEST_HEADER, sealed };
    return [...ops, { op: "put-record", record }];
  } finally {
    wipe(digest);
  }
}

/**
 * Checks `image` against its manifest under `dek`: exactly one manifest record that opens and whose
 * digest is the image's own. Anything else is a corruption-marked `integrity` failure.
 */
export function assertManifest(dek: Secret, image: VaultImage): void {
  const failure = new KernelError(
    "integrity",
    "vault structure failed authentication",
    undefined,
    true,
  );
  const manifests = image.records.filter(isManifestRecord);
  const [manifest] = manifests;
  if (manifest === undefined || manifests.length !== 1 || manifest.id !== MANIFEST_ID) {
    throw failure;
  }
  let sealed: Uint8Array;
  try {
    sealed = dek.use((key) =>
      open(key, manifest.sealed, recordContext(MANIFEST_KIND, MANIFEST_ID), manifest.header),
    );
  } catch {
    throw failure;
  }
  try {
    if (!equalBytes(sealed, manifestDigest(image))) {
      throw failure;
    }
  } finally {
    wipe(sealed);
  }
}
