// Cloud backup (design/backup.mdx, E1-d-3): a 32-byte BEK is retained in the vault as the
// `backup-key` record, so `backup.update` rewrites the cloud envelope without a fresh factor
// ceremony. `backup.enable` still re-verifies and wraps the new BEK under each backup factor;
// `backup.restore` adopts the envelope's BEK only when the restore establishes the vault and a
// kernel passkey ceremony unwrapped it — a forged envelope must never hijack the vault's future
// backups. The payload is compact
// binary secrets only — per wallet `origin(1) ‖ len(1) ‖ entropy`;
// `secretKey(32)`, per chain key `family(1) ‖ secretKey(32)` — sealed under the BEK with the
// vault envelope v1 format; each sealedBek rides the same seal under the factor's KEK.

import { equalBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";

import {
  backupEnvelope as backupEnvelopeValidator,
  backupEnvelopeReason,
  backupHeader as backupHeaderValidator,
  validate,
} from "@qntx/wallet/protocol";
import type {
  BackupEnvelopeFactor,
  BackupEnvelopeWire,
  BackupFactor,
  BackupUnlockFactor,
  BackupHeaderWallet,
  BackupHeaderWire,
  Factor,
  NullValue,
} from "@qntx/wallet/protocol";
import type { VaultWalletInfo } from "@qntx/wallet/types";

import { KEY_FAMILY_BYTE, keyIdOf } from "../derive/key-id.ts";
import type { KeyFamily } from "../derive/key-id.ts";
import { KernelError, UnsupportedFormatError } from "../errors.ts";
import { requirePasskey } from "../platform.ts";
import type { KernelPlatform, PasskeyResult, SecureInput } from "../platform.ts";
import {
  backupCredentialName,
  backupPasswordLabel,
  corePromptFor,
  promptLocale,
} from "../prompts.ts";
import type { BackupPasswordLabel } from "../prompts.ts";
import { wipe } from "../secret/secret.ts";
import type { Secret } from "../secret/secret.ts";
import { open as openEnvelope, seal } from "../vault/envelope.ts";
import {
  BACKUP_PASSWORD_COST,
  assertBackupPasswordPolicy,
  backupPasswordKek,
  backupPasswordTooShort,
} from "../vault/factors.ts";
import {
  encodeHeader,
  parseBackupKeyHeader,
  parseEntropyHeader,
  parseKeyHeader,
} from "../vault/headers.ts";
import type { StoredRecord } from "../vault/store.ts";
import { openRecord, openWalletSecret, sealRecord, verifyFactor } from "../vault/vault.ts";
import type { KernelContext } from "./context.ts";
import { keyMaterial as keyMaterialFor } from "./keys.ts";
import { normalizePassphrase } from "./passphrase.ts";
import {
  commitRecords,
  gate,
  mnemonicWords,
  walletInfoOf,
  walletMaterial,
  walletRecord,
} from "./wallets.ts";

/** Payload tag byte: wallet entry. */
const ORIGIN_BYTE: Readonly<Record<"passkey" | "mnemonic", number>> = {
  mnemonic: 1,
  passkey: 2,
};
const ORIGIN_NAME: ReadonlyArray<"passkey" | "mnemonic" | undefined> = [
  undefined,
  "mnemonic",
  "passkey",
];

const BACKUP_KEY_KIND = "backup-key";
const BACKUP_KEY_ID = "default";

const b64 = {
  enc: (b: Uint8Array): string => base64urlnopad.encode(b),
  dec: (s: string): Uint8Array => {
    try {
      return base64urlnopad.decode(s);
    } catch {
      throw new KernelError("integrity", "backup: invalid base64url field");
    }
  },
};

/**
 * The factor list re-serialized with fixed key order — the payload tag authenticates this canonical
 * form, so it does not depend on the wire text's field order. A dropped, added, altered or
 * reordered factor entry changes the digest and fails the payload open.
 */
function canonicalFactors(factors: ReadonlyArray<BackupEnvelopeFactor>): string {
  return JSON.stringify(
    factors.map((f) =>
      f.kind === "passkey"
        ? { kind: f.kind, credentialId: f.credentialId, sealedBek: f.sealedBek }
        : {
            kind: f.kind,
            kdf: f.kdf,
            memoryKiB: f.memoryKiB,
            passes: f.passes,
            lanes: f.lanes,
            salt: f.salt,
            sealedBek: f.sealedBek,
          },
    ),
  );
}

function payloadContext(header: string, factors: ReadonlyArray<BackupEnvelopeFactor>): string {
  return `qntx-wallet/backup/v1/payload/${bytesToHex(sha256(utf8ToBytes(header)))}/${bytesToHex(
    sha256(utf8ToBytes(canonicalFactors(factors))),
  )}`;
}

function factorContextOf(kind: string): string {
  return `qntx-wallet/backup/v1/factor/${kind}`;
}

/** Structural validation only — the payload tag is the header's authentication. */
function parseEnvelope(text: string): BackupEnvelopeWire {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KernelError("integrity", "backup: envelope is not JSON");
  }
  const reason = backupEnvelopeReason(value);
  if (reason !== undefined) {
    throw new UnsupportedFormatError(
      reason,
      reason === "older"
        ? "backup: the envelope was written by an older build"
        : "backup: the envelope needs a newer build",
    );
  }
  const envelope = validate(backupEnvelopeValidator, value);
  if (envelope === undefined) {
    throw new KernelError("integrity", "backup: malformed envelope");
  }
  if (envelope.factors.filter((f) => f.kind === "password").length > 1) {
    throw new KernelError("integrity", "backup: at most one password factor");
  }
  return envelope;
}

/** Runs only after the payload tag verified `header`'s raw text. */
function parseHeader(text: string): BackupHeaderWire {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new KernelError("integrity", "backup: header is not JSON");
  }
  const header = validate(backupHeaderValidator, value);
  if (header === undefined) {
    throw new KernelError("integrity", "backup: malformed header");
  }
  return header;
}

const PAYLOAD_WALLET = 0x01;
const PAYLOAD_KEY = 0x02;

/** Name for each payload family byte — the inverse of the shared KEY_FAMILY_BYTE table. */
const KEY_FAMILY_NAME: Readonly<Record<number, KeyFamily>> = {
  0x01: "evm",
  0x02: "solana",
  0x03: "bitcoin",
  0x04: "tron",
};

function encodePayload(
  wallets: ReadonlyArray<{
    origin: "passkey" | "mnemonic";
    entropy: Uint8Array;
  }>,
  keys: ReadonlyArray<{
    family: KeyFamily;
    secret: Uint8Array;
  }>,
): Uint8Array {
  const size =
    1 +
    wallets.reduce((acc, w) => acc + 3 + w.entropy.length, 0) +
    keys.reduce((acc, k) => acc + 3 + k.secret.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  out[off++] = 2; // payload version
  for (const w of wallets) {
    out[off++] = PAYLOAD_WALLET;
    out[off++] = ORIGIN_BYTE[w.origin] ?? 0;
    out[off++] = w.entropy.length;
    out.set(w.entropy, off);
    off += w.entropy.length;
  }
  for (const k of keys) {
    out[off++] = PAYLOAD_KEY;
    out[off++] = KEY_FAMILY_BYTE[k.family] ?? 0;
    out[off++] = k.secret.length;
    out.set(k.secret, off);
    off += k.secret.length;
  }
  return out;
}

function decodePayload(bytes: Uint8Array): {
  wallets: Array<{ origin: "passkey" | "mnemonic"; entropy: Uint8Array }>;
  keys: Array<{ family: KeyFamily; secret: Uint8Array }>;
} {
  if (bytes.length === 0 || bytes[0] !== 2) {
    throw new KernelError("integrity", "backup: bad payload version");
  }
  const wallets: Array<{ origin: "passkey" | "mnemonic"; entropy: Uint8Array }> = [];
  const keys: Array<{ family: KeyFamily; secret: Uint8Array }> = [];
  let off = 1;
  while (off < bytes.length) {
    const tag = bytes[off++];
    if (tag === PAYLOAD_WALLET || tag === PAYLOAD_KEY) {
      const ob = bytes[off];
      const len = bytes[off + 1];
      if (ob === undefined || len === undefined || off + 2 + len > bytes.length) {
        throw new KernelError("integrity", "backup: truncated payload");
      }
      off += 2;
      if (tag === PAYLOAD_KEY) {
        const family = KEY_FAMILY_NAME[ob];
        if (family === undefined) {
          throw new KernelError("integrity", "backup: unknown key family byte");
        }
        keys.push({ family, secret: bytes.subarray(off, off + len) });
      } else {
        const origin = ORIGIN_NAME[ob];
        if (origin === undefined) {
          throw new KernelError("integrity", "backup: unknown origin byte");
        }
        wallets.push({ origin, entropy: bytes.subarray(off, off + len) });
      }
      off += len;
    } else {
      throw new KernelError("integrity", "backup: unknown payload tag");
    }
  }
  return { wallets, keys };
}

/** The vault's public backup header plus the payload plaintexts — caller wipes via wipeContents. */
type BackupContents = {
  readonly wallets: ReadonlyArray<BackupHeaderWallet & { readonly entropy: Uint8Array }>;
  readonly keys: ReadonlyArray<{
    readonly keyId: string;
    readonly family: KeyFamily;
    readonly secret: Uint8Array;
  }>;
  readonly header: string;
};

function collectContents(ctx: KernelContext, dek: Secret): BackupContents {
  const wallets: Array<BackupHeaderWallet & { entropy: Uint8Array }> = [];
  try {
    for (const record of ctx.image.records) {
      if (record.kind !== "entropy") {
        continue;
      }
      const header = parseEntropyHeader(record.header);
      // The passphrase never leaves the vault: only the entropy goes into the payload.
      const { entropy, passphrase } = openWalletSecret(dek, record);
      passphrase?.fill(0);
      wallets.push({
        walletId: record.id,
        origin: header.origin,
        words: header.words,
        ...(header.passphrase === true ? { passphrase: true as const } : {}),
        entropy,
      });
    }
    const keys: Array<{
      keyId: string;
      family: KeyFamily;
      secret: Uint8Array;
    }> = [];
    for (const record of ctx.image.records) {
      if (record.kind !== "key") {
        continue;
      }
      const { family } = parseKeyHeader(record.header);
      keys.push({ keyId: record.id, family, secret: openRecord(dek, record) });
    }
    const header = JSON.stringify({
      wallets: wallets.map(({ walletId, origin, words, passphrase }) => ({
        walletId,
        origin,
        words,
        ...(passphrase === true ? { passphrase } : {}),
      })),
      ...(keys.length === 0 ? {} : { keys: keys.map(({ keyId, family }) => ({ keyId, family })) }),
    } satisfies BackupHeaderWire);
    return { wallets, keys, header };
  } catch (error) {
    for (const wallet of wallets) {
      wallet.entropy.fill(0);
    }
    throw error;
  }
}

function wipeContents(contents: BackupContents): void {
  for (const wallet of contents.wallets) {
    wallet.entropy.fill(0);
  }
  for (const key of contents.keys) {
    key.secret.fill(0);
  }
}

/**
 * Seals the BEK under every backup factor. Deterministic draw order: every password salt in
 * factor-array order, then every sealedBek nonce in factor-array order — no random draw follows an
 * await, so async scheduling (pbkdf2 suspending) can never reorder it.
 */
/**
 * Backup factor material once any passkey ceremony ran: a password or the PRF evidence, tagged with
 * the runtime whose ceremony produced it.
 */
type BackupMaterial =
  | {
      readonly kind: "password";
      readonly ceremony: "kernel" | "host";
      readonly password: Uint8Array;
    }
  | {
      readonly kind: "passkey";
      readonly ceremony: "kernel" | "host";
      readonly credentialId: Uint8Array;
      readonly prfBackup: Uint8Array;
    };

const PURPOSE_PROTECTION = 0x02;

/**
 * The backup PRF from one platform ceremony: user-verified with a 32-byte `first` output, else
 * `passkey-prf-unsupported`. The unused `second` output is wiped.
 */
function backupMaterialOf(result: PasskeyResult): BackupMaterial {
  result.second?.fill(0);
  if (!result.userVerified || result.first?.length !== 32) {
    result.first?.fill(0);
    throw new KernelError("passkey-prf-unsupported", "the passkey returned no verified PRF output");
  }
  return {
    kind: "passkey",
    ceremony: "kernel",
    credentialId: result.credentialId,
    prfBackup: result.first,
  };
}

/**
 * Resolves wire backup factors to material. A `kernel` passkey arm runs the platform ceremony here
 * (React Native): enabling registers a protection credential (purpose `0x02`, asserted once when
 * registration returns no PRF); restoring asserts one of `allowCredentials` — the envelope's own
 * passkey factors. Each platform accepts only its own ceremony shape.
 */
async function backupMaterial(
  ctx: KernelContext,
  factor: BackupFactor | BackupUnlockFactor,
  allowCredentials: ReadonlyArray<Uint8Array>,
  purpose: "enable" | "restore",
): Promise<BackupMaterial> {
  if (factor.kind === "password") {
    if ("password" in factor) {
      // Wire password — only a host without a keystore may carry it; on React Native the main
      // runtime must never hold it.
      if (ctx.platform.keystore !== undefined) {
        throw new KernelError(
          "unsupported",
          "on this platform the kernel collects the backup password itself",
        );
      }
      return { kind: "password", ceremony: "host", password: factor.password };
    }
    if (ctx.platform.keystore === undefined) {
      throw new KernelError(
        "unsupported",
        "this platform supplies the backup password over the wire",
      );
    }
    const { secureInput } = ctx.platform;
    if (secureInput === undefined) {
      throw new KernelError("unsupported", "this platform has no secure input");
    }
    return {
      kind: "password",
      ceremony: "kernel",
      password: await kernelBackupPassword(ctx, secureInput, purpose),
    };
  }
  if ((ctx.platform.passkey !== undefined) !== (factor.ceremony === "kernel")) {
    throw new KernelError("unsupported", "this platform runs passkey ceremonies elsewhere");
  }
  if (factor.ceremony === "host") {
    return {
      kind: "passkey",
      ceremony: "host",
      credentialId: factor.credentialId,
      prfBackup: factor.prfBackup,
    };
  }
  const passkey = requirePasskey(ctx.platform);
  const salts = { first: utf8ToBytes(factor.backupSalt) };
  if ("rpName" in factor) {
    const created = await passkey.create({
      rpId: factor.rpId,
      rpName: factor.rpName,
      userId: concatBytes(new Uint8Array([PURPOSE_PROTECTION]), ctx.platform.random(15)),
      userName: backupCredentialName(promptLocale(ctx.platform.keystore?.locale ?? "en")),
      salts,
    });
    return created.first === undefined
      ? backupMaterialOf(
          await passkey.get({ rpId: factor.rpId, allowCredentials: [created.credentialId], salts }),
        )
      : backupMaterialOf(created);
  }
  if (allowCredentials.length === 0) {
    throw new KernelError("not-found", "backup: the envelope has no passkey factor");
  }
  return backupMaterialOf(await passkey.get({ rpId: factor.rpId, allowCredentials, salts }));
}

/**
 * The kernel's backup-password ceremony: the bytes arrive through the secure input, never the wire.
 * Enable asks for the new password and a repeat — a mismatch or an entry under the 12-code-point
 * policy is re-asked with the reason in the label, three rounds at most. Restore asks once; a wrong
 * entry fails later at the envelope unwrap (`wrong-password`). Every buffer the input did not
 * return is wiped on every path.
 */
async function kernelBackupPassword(
  ctx: KernelContext,
  secureInput: SecureInput,
  purpose: "enable" | "restore",
): Promise<Uint8Array> {
  const locale = promptLocale(ctx.platform.keystore?.locale ?? "en");
  const ask = async (label: BackupPasswordLabel): Promise<Uint8Array> => {
    const result = await secureInput.request("backup-password", backupPasswordLabel(locale, label));
    if (!result.ok) {
      throw new KernelError(result.failure, `backup password input: ${result.failure}`);
    }
    return result.value;
  };
  if (purpose === "restore") {
    return ask("enter");
  }
  let complaint: BackupPasswordLabel = "choose";
  for (let round = 0; round < 3; round++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one entry at a time; each round depends on the last
    const first = await ask(complaint);
    let accepted = false;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- confirmation follows the first entry
      const second = await ask("again");
      let matched: boolean;
      try {
        matched = equalBytes(first, second);
      } finally {
        second.fill(0);
      }
      accepted = matched && !backupPasswordTooShort(first);
      complaint = matched ? "short" : "mismatch";
    } finally {
      if (!accepted) {
        first.fill(0);
      }
    }
    if (accepted) {
      return first;
    }
  }
  throw new KernelError("invalid-input", "backup password was not settled in three rounds");
}

/**
 * Zeroes the secret bytes a backup factor carries — the password or a host ceremony's PRF output. A
 * kernel-ceremony factor has no wire secret; its material's `prfBackup` is still covered.
 */
function wipeBackupSecret(factor: BackupMaterial | BackupFactor | BackupUnlockFactor): void {
  if (factor.kind === "password") {
    if ("password" in factor) {
      factor.password.fill(0);
    }
  } else if ("prfBackup" in factor) {
    factor.prfBackup.fill(0);
  }
}

async function sealBackupFactors(
  platform: KernelPlatform,
  bek: Uint8Array,
  backupFactors: ReadonlyArray<BackupMaterial>,
): Promise<BackupEnvelopeFactor[]> {
  const salts = backupFactors.map((factor) =>
    factor.kind === "password" ? platform.random(16) : undefined,
  );
  const keks: Uint8Array[] = [];
  try {
    for (const [index, factor] of backupFactors.entries()) {
      if (factor.kind === "passkey") {
        keks.push(
          hkdf(
            sha256,
            factor.prfBackup,
            factor.credentialId,
            utf8ToBytes("qntx-wallet/kek/backup/v1"),
            32,
          ),
        );
        continue;
      }
      assertBackupPasswordPolicy(factor.password);
      const salt = salts[index];
      if (salt === undefined) {
        throw new KernelError("integrity", "backup: missing password salt");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- one KDF at a time; a failure wipes the KEKs already derived
      keks.push(await backupPasswordKek(factor.password, salt, platform.argon2id));
    }
  } catch (error) {
    for (const kek of keks) {
      kek.fill(0);
    }
    throw error;
  }
  return backupFactors.map((factor, index): BackupEnvelopeFactor => {
    const kek = keks[index];
    if (kek === undefined) {
      throw new KernelError("integrity", "backup: missing factor key");
    }
    let sealedBek: Uint8Array;
    try {
      sealedBek = seal(kek, bek, factorContextOf(factor.kind), "", platform.random);
    } finally {
      kek.fill(0);
    }
    if (factor.kind === "passkey") {
      return {
        kind: "passkey" as const,
        credentialId: b64.enc(factor.credentialId),
        sealedBek: b64.enc(sealedBek),
      };
    }
    const salt = salts[index];
    if (salt === undefined) {
      throw new KernelError("integrity", "backup: missing password salt");
    }
    return {
      kind: "password" as const,
      kdf: "argon2id" as const,
      ...BACKUP_PASSWORD_COST,
      salt: b64.enc(salt),
      sealedBek: b64.enc(sealedBek),
    };
  });
}

/** The backup record's public id: HKDF over the BEK — a verifier can never reach the BEK from it. */
function backupKeyIdOf(bek: Uint8Array): string {
  const id = hkdf(sha256, bek, new Uint8Array(0), utf8ToBytes("qntx-wallet/backup/v1/id"), 16);
  return bytesToHex(id);
}

function backupKeyRecord(
  ctx: KernelContext,
  dek: Secret,
  bek: Uint8Array,
  factors: ReadonlyArray<BackupEnvelopeFactor>,
): StoredRecord {
  const header = encodeHeader({
    id: backupKeyIdOf(bek),
    factors,
    createdAt: ctx.platform.now(),
  });
  return sealRecord(ctx.platform, dek, BACKUP_KEY_KIND, BACKUP_KEY_ID, header, bek);
}

/**
 * Enables cloud backup: re-verify, mint a fresh BEK and retain it sealed in the `backup-key`
 * record. Re-enabling replaces the record — a new BEK (and id) so stale envelopes and leaked old
 * factors can never unwrap future backups.
 */
export async function enableBackup(
  ctx: KernelContext,
  params: {
    verify: Factor;
    factors: ReadonlyArray<BackupFactor>;
  },
  requestSession: string | undefined,
): Promise<NullValue> {
  // The session check and verification run inside the wiping try: a wrong verify or a
  // missing session must not leave the caller's backup secrets in memory. Password and
  // host materials share the same buffers as the wire factors, so one loop covers both.
  const materials: BackupMaterial[] = [];
  let bek: Uint8Array | undefined;
  try {
    const { dek } = ctx.session.require(requestSession);
    await verifyFactor(ctx, params.verify, dek, corePromptFor(ctx.platform.keystore, "backup"));
    bek = ctx.platform.random(32);
    if (bek.length !== 32) {
      throw new KernelError("integrity", "random source returned a wrong-length BEK");
    }
    for (const factor of params.factors) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one system ceremony at a time
      materials.push(await backupMaterial(ctx, factor, [], "enable"));
    }
    const factors = await sealBackupFactors(ctx.platform, bek, materials);
    const record = backupKeyRecord(ctx, dek, bek, factors);
    // put-record replaces an existing backup-key row.
    await ctx.commit([{ op: "put-record", record }]);
    return null;
  } finally {
    bek?.fill(0);
    for (const secret of [...materials, ...params.factors]) {
      wipeBackupSecret(secret);
    }
  }
}

/**
 * Rewrites the cloud envelope under the retained BEK: one fresh payload nonce, factor entries
 * copied verbatim from the backup-key header. No factor input — the envelope can only ever be
 * opened by the factors chosen at enable time.
 */
export function updateBackup(
  ctx: KernelContext,
  _params: NullValue,
  requestSession: string | undefined,
): { envelope: string } {
  const { dek } = ctx.session.require(requestSession);
  const record = ctx.image.records.find(
    (r) => r.kind === BACKUP_KEY_KIND && r.id === BACKUP_KEY_ID,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "backup is not enabled");
  }
  const keyHeader = parseBackupKeyHeader(record.header);
  const bek = openRecord(dek, record);
  const contents = collectContents(ctx, dek);
  try {
    const plaintext = encodePayload(contents.wallets, contents.keys);
    // Exactly one random draw in the whole command: the payload seal nonce.
    const sealedPayload = seal(
      bek,
      plaintext,
      payloadContext(contents.header, keyHeader.factors),
      "",
      ctx.platform.random,
    );
    try {
      const envelope: BackupEnvelopeWire = {
        version: 3,
        createdAt: ctx.platform.now(),
        header: contents.header,
        factors: keyHeader.factors,
        payload: b64.enc(sealedPayload),
      };
      return { envelope: JSON.stringify(envelope) };
    } finally {
      sealedPayload.fill(0);
      plaintext.fill(0);
    }
  } finally {
    bek.fill(0);
    wipeContents(contents);
  }
}

/** Deletes the retained BEK after re-verification; a missing record still succeeds. */
export async function disableBackup(
  ctx: KernelContext,
  params: { verify: Factor },
  requestSession: string | undefined,
): Promise<NullValue> {
  const { dek } = ctx.session.require(requestSession);
  await verifyFactor(
    ctx,
    params.verify,
    dek,
    corePromptFor(ctx.platform.keystore, "disable-backup"),
  );
  const record = ctx.image.records.find(
    (r) => r.kind === BACKUP_KEY_KIND && r.id === BACKUP_KEY_ID,
  );
  if (record === undefined) {
    return null;
  }
  await ctx.commit([{ op: "delete-record", kind: BACKUP_KEY_KIND, id: BACKUP_KEY_ID }]);
  return null;
}

/**
 * Whether an establishing restore may keep the envelope's BEK. Adopting it turns backup on, so it
 * needs what `backup.enable` needs: a user verification the main runtime cannot stand in for, by
 * the owner of a factor of this very envelope. A kernel ceremony is both — a user-verified
 * assertion or an entered password whose secret never leaves the kernel runtime. A wire password
 * and a host ceremony's PRF arrive over the wire: the main runtime may have minted the envelope
 * around them, and adopting its BEK would hand it every secret a later `backup.update` seals. A
 * kernel-entered password widens nothing — a main runtime that cannot read it unwraps nothing with
 * it, and one that can read it could have unwrapped the real envelope anyway.
 */
const adoptsBackupKey = (material: BackupMaterial): boolean => material.ceremony === "kernel";

/** Unwraps the BEK under the caller's factor. A failed open maps to the factor's wrong-* code. */
async function bekFromFactor(
  platform: KernelPlatform,
  envelope: BackupEnvelopeWire,
  backupFactor: BackupMaterial,
): Promise<Uint8Array> {
  if (backupFactor.kind === "passkey") {
    const entry = envelope.factors.find(
      (f): f is Extract<BackupEnvelopeWire["factors"][number], { kind: "passkey" }> =>
        f.kind === "passkey" && f.credentialId === b64.enc(backupFactor.credentialId),
    );
    if (entry === undefined) {
      throw new KernelError("not-found", "backup: no factor for this credential");
    }
    const kek = hkdf(
      sha256,
      backupFactor.prfBackup,
      backupFactor.credentialId,
      utf8ToBytes("qntx-wallet/kek/backup/v1"),
      32,
    );
    try {
      return openEnvelope(kek, b64.dec(entry.sealedBek), factorContextOf("passkey"), "");
    } catch {
      throw new KernelError("wrong-passkey", "backup: factor does not unwrap");
    } finally {
      kek.fill(0);
    }
  }
  const entry = envelope.factors.find(
    (f): f is Extract<BackupEnvelopeWire["factors"][number], { kind: "password" }> =>
      f.kind === "password",
  );
  if (entry === undefined) {
    throw new KernelError("not-found", "backup: no password factor");
  }
  const kek = await backupPasswordKek(
    backupFactor.password,
    b64.dec(entry.salt),
    platform.argon2id,
  );
  try {
    return openEnvelope(kek, b64.dec(entry.sealedBek), factorContextOf("password"), "");
  } catch {
    throw new KernelError("wrong-password", "backup: factor does not unwrap");
  } finally {
    kek.fill(0);
  }
}

/**
 * Restore is a merge, never an overwrite: existing wallet ids are skipped, everything else goes
 * down in one commit so a torn restore can't leave half the secrets.
 */
export async function restoreBackup(
  ctx: KernelContext,
  params: {
    envelope: string;
    backupFactor: BackupUnlockFactor;
    passphrases?: ReadonlyArray<{ walletId: string; passphrase: Uint8Array }>;
    factor?: Factor;
  },
  requestSession: string | undefined,
): Promise<{ wallets: VaultWalletInfo[]; passphraseRequired: string[]; session: string }> {
  const passphrases = new Map<string, Uint8Array>();
  try {
    return await restoreWithPassphrases(ctx, params, requestSession, passphrases);
  } finally {
    for (const passphrase of passphrases.values()) {
      passphrase.fill(0);
    }
    for (const entry of params.passphrases ?? []) {
      entry.passphrase.fill(0);
    }
    wipeBackupSecret(params.backupFactor);
  }
}

async function restoreWithPassphrases(
  ctx: KernelContext,
  params: {
    envelope: string;
    backupFactor: BackupUnlockFactor;
    passphrases?: ReadonlyArray<{ walletId: string; passphrase: Uint8Array }>;
    factor?: Factor;
  },
  requestSession: string | undefined,
  passphrases: Map<string, Uint8Array>,
): Promise<{ wallets: VaultWalletInfo[]; passphraseRequired: string[]; session: string }> {
  for (const entry of params.passphrases ?? []) {
    if (passphrases.has(entry.walletId)) {
      throw new KernelError("invalid-input", `duplicate passphrase for wallet ${entry.walletId}`);
    }
    passphrases.set(entry.walletId, normalizePassphrase(entry.passphrase));
  }
  const envelope = parseEnvelope(params.envelope);
  // The gate runs before any decryption: every check that needs no plaintext (the initial
  // factor on a fresh vault, the live session on an established one) comes first.
  const gated = gate(ctx, params.factor, requestSession);
  let committed = false;
  try {
    const credentials = envelope.factors.flatMap((f) =>
      f.kind === "passkey" ? [b64.dec(f.credentialId)] : [],
    );
    const material = await backupMaterial(ctx, params.backupFactor, credentials, "restore");
    try {
      const bek = await bekFromFactor(ctx.platform, envelope, material);
      try {
        // The payload tag authenticates the raw header text — parse the header only after this open.
        let plaintext: Uint8Array;
        try {
          plaintext = openEnvelope(
            bek,
            b64.dec(envelope.payload),
            payloadContext(envelope.header, envelope.factors),
            "",
          );
        } catch {
          throw new KernelError("integrity", "backup: payload authentication failed");
        }
        // One finally owns the plaintext and every decoded secret — the decoder returns
        // views into `plaintext`, so its wipe covers them and a decode throw leaves no copy.
        let decoded: ReturnType<typeof decodePayload> = { wallets: [], keys: [] };
        try {
          const header = parseHeader(envelope.header);
          decoded = decodePayload(plaintext);
          if (
            decoded.wallets.length !== header.wallets.length ||
            decoded.keys.length !== (header.keys?.length ?? 0)
          ) {
            throw new KernelError("integrity", "backup: payload does not match header");
          }

          const flagged = new Set(
            header.wallets.filter((w) => w.passphrase === true).map((w) => w.walletId),
          );
          for (const walletId of passphrases.keys()) {
            if (!flagged.has(walletId)) {
              throw new KernelError("invalid-input", `wallet ${walletId} has no passphrase`);
            }
          }

          const records: StoredRecord[] = [];
          const restored: VaultWalletInfo[] = [];
          const passphraseRequired: string[] = [];
          const now = ctx.platform.now();
          for (const [index, wallet] of decoded.wallets.entries()) {
            const expected = header.wallets[index];
            if (expected === undefined) {
              throw new KernelError("integrity", "backup: wallet count mismatch");
            }
            const words = mnemonicWords(wallet.entropy);
            if (words !== expected.words) {
              throw new KernelError("integrity", "backup: entropy length does not match header");
            }
            const passphrase = passphrases.get(expected.walletId);
            if (passphrase === undefined && expected.passphrase === true) {
              if (
                !ctx.image.records.some((r) => r.kind === "entropy" && r.id === expected.walletId)
              ) {
                passphraseRequired.push(expected.walletId);
              }
              continue;
            }
            // oxlint-disable-next-line no-await-in-loop -- wallets re-derive serially; order matches the header
            const material = await walletMaterial(
              ctx.platform,
              wallet.entropy,
              passphrase,
              wallet.origin,
              words,
            );
            if (passphrase !== undefined && material.walletId !== expected.walletId) {
              throw new KernelError(
                "invalid-input",
                `passphrase does not match wallet ${expected.walletId}`,
              );
            }
            if (material.walletId !== expected.walletId || material.origin !== expected.origin) {
              throw new KernelError("integrity", "backup: derived walletId does not match header");
            }
            if (ctx.image.records.some((r) => r.kind === "entropy" && r.id === material.walletId)) {
              continue; // already in the vault
            }
            // `backup` says how the user could recover without the vault: a passkey-origin wallet
            // still derives from the synced credential; a mnemonic-origin one must be re-marked
            // `none` because this device never saw the written words — the backup layer's own
            // state tracks that a cloud copy exists.
            const backup = material.origin === "passkey" ? "passkey" : "none";
            const record = walletRecord(ctx, gated.dek, material, backup, now);
            records.push(record);
            restored.push(walletInfoOf(material, backup, now));
          }
          for (const [index, key] of decoded.keys.entries()) {
            const expected = header.keys?.[index];
            if (expected === undefined) {
              throw new KernelError("integrity", "backup: key count mismatch");
            }
            const material = keyMaterialFor(key.family, key.secret);
            const keyId = keyIdOf(key.family, material.publicKey);
            if (keyId !== expected.keyId || key.family !== expected.family) {
              throw new KernelError("integrity", "backup: derived keyId does not match header");
            }
            if (ctx.image.records.some((r) => r.kind === "key" && r.id === keyId)) {
              continue; // already in the vault
            }
            try {
              records.push(
                sealRecord(
                  ctx.platform,
                  gated.dek,
                  "key",
                  keyId,
                  encodeHeader({ family: key.family, address: material.address, createdAt: now }),
                  material.secret,
                ),
              );
            } finally {
              // A keypair input produces a sliced seed copy distinct from `key.secret`.
              if (material.secret !== key.secret) {
                wipe(material.secret);
              }
            }
          }
          if (gated.uninitialized && adoptsBackupKey(material)) {
            // Adoption — only while the vault is being established, inside the same atomic
            // commit: a merge keeps the vault's own backup key (or none). Otherwise backup stays
            // off until the owner turns it on with `backup.enable`.
            records.push(backupKeyRecord(ctx, gated.dek, bek, envelope.factors));
          }
          const session = await commitRecords(ctx, gated, params.factor, records);
          committed = true;
          return { wallets: restored, passphraseRequired, session };
        } finally {
          plaintext.fill(0);
          for (const wallet of decoded.wallets) {
            wallet.entropy.fill(0);
          }
          for (const key of decoded.keys) {
            key.secret.fill(0);
          }
        }
      } finally {
        bek.fill(0);
      }
    } finally {
      wipeBackupSecret(material);
    }
  } catch (error) {
    // gate() minted a DEK nothing owns yet; commitRecords wipes it only past its own
    // commit and takes ownership on success — a failure in between leaks it here.
    if (!committed && gated.uninitialized) {
      gated.dek.wipe();
    }
    throw error;
  }
}
