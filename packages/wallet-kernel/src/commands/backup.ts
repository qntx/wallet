// Cloud backup (design/backup.mdx, E1-d-3): a 32-byte BEK is retained in the vault as the
// `backup-key` record, so `backup.update` rewrites the cloud envelope without a fresh factor
// ceremony. `backup.enable` still re-verifies and wraps the new BEK under each backup factor;
// `backup.restore` adopts the envelope's BEK only when the restore establishes the vault — a
// forged envelope must never hijack an existing vault's future backups. The payload is compact
// binary secrets only — per wallet `origin(1) ‖ len(1) ‖ entropy`;
// `secretKey(32)`, per chain key `family(1) ‖ secretKey(32)` — sealed under the BEK with the
// vault envelope v1 format; each sealedBek rides the same seal under the factor's KEK.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";

import {
  backupEnvelope as backupEnvelopeValidator,
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
import type { WalletInfo } from "@qntx/wallet/types";

import { keyIdOf } from "../derive/key-id.ts";
import { KernelError } from "../errors.ts";
import { requirePasskey } from "../platform.ts";
import type { KernelPlatform, PasskeyResult } from "../platform.ts";
import { backupCredentialName, corePromptFor, promptLocale } from "../prompts.ts";
import { wipe } from "../secret/secret.ts";
import type { Secret } from "../secret/secret.ts";
import { open as openEnvelope, seal } from "../vault/envelope.ts";
import { assertPasswordPolicy, passwordKek } from "../vault/factors.ts";
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

const PASSWORD_ITERATIONS = 600_000;

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

function payloadContext(header: string): string {
  return `qntx-wallet/backup/v1/payload/${bytesToHex(sha256(utf8ToBytes(header)))}`;
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

const KEY_FAMILY_NAME: Readonly<Record<number, "evm" | "solana" | "bitcoin">> = {
  0x01: "evm",
  0x02: "solana",
  0x03: "bitcoin",
};
const KEY_FAMILY_BYTE: Readonly<Record<"evm" | "solana" | "bitcoin", number>> = {
  evm: 0x01,
  solana: 0x02,
  bitcoin: 0x03,
};

function encodePayload(
  wallets: ReadonlyArray<{
    origin: "passkey" | "mnemonic";
    entropy: Uint8Array;
  }>,
  keys: ReadonlyArray<{
    family: "evm" | "solana" | "bitcoin";
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
  keys: Array<{ family: "evm" | "solana" | "bitcoin"; secret: Uint8Array }>;
} {
  if (bytes.length === 0 || bytes[0] !== 2) {
    throw new KernelError("integrity", "backup: bad payload version");
  }
  const wallets: Array<{ origin: "passkey" | "mnemonic"; entropy: Uint8Array }> = [];
  const keys: Array<{ family: "evm" | "solana" | "bitcoin"; secret: Uint8Array }> = [];
  let off = 1;
  while (off < bytes.length) {
    const tag = bytes[off++];
    if (tag === PAYLOAD_WALLET || tag === PAYLOAD_KEY) {
      if (off + 2 > bytes.length) {
        break;
      }
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
        keys.push({ family, secret: bytes.slice(off, off + len) });
      } else {
        const origin = ORIGIN_NAME[ob];
        if (origin === undefined) {
          throw new KernelError("integrity", "backup: unknown origin byte");
        }
        wallets.push({ origin, entropy: bytes.slice(off, off + len) });
      }
      off += len;
    } else {
      throw new KernelError("integrity", "backup: unknown payload tag");
    }
  }
  if (off !== bytes.length) {
    throw new KernelError("integrity", "backup: payload length mismatch");
  }
  return { wallets, keys };
}

/** The vault's public backup header plus the payload plaintexts — caller wipes via wipeContents. */
type BackupContents = {
  readonly wallets: ReadonlyArray<BackupHeaderWallet & { readonly entropy: Uint8Array }>;
  readonly keys: ReadonlyArray<{
    readonly keyId: string;
    readonly family: "evm" | "solana" | "bitcoin";
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
      family: "evm" | "solana" | "bitcoin";
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
/** Backup factor material once any passkey ceremony ran: a password or the PRF evidence. */
type BackupMaterial =
  | { readonly kind: "password"; readonly password: Uint8Array }
  | { readonly kind: "passkey"; readonly credentialId: Uint8Array; readonly prfBackup: Uint8Array };

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
  return { kind: "passkey", credentialId: result.credentialId, prfBackup: result.first };
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
): Promise<BackupMaterial> {
  if (factor.kind === "password") {
    return factor;
  }
  if ((ctx.platform.passkey !== undefined) !== (factor.ceremony === "kernel")) {
    throw new KernelError("unsupported", "this platform runs passkey ceremonies elsewhere");
  }
  if (factor.ceremony === "host") {
    return factor;
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

async function sealBackupFactors(
  platform: KernelPlatform,
  bek: Uint8Array,
  backupFactors: ReadonlyArray<BackupMaterial>,
): Promise<BackupEnvelopeFactor[]> {
  const salts = backupFactors.map((factor) =>
    factor.kind === "password" ? platform.random(16) : undefined,
  );
  const keks = await Promise.all(
    backupFactors.map(async (factor, index) => {
      if (factor.kind === "passkey") {
        return hkdf(
          sha256,
          factor.prfBackup,
          factor.credentialId,
          utf8ToBytes("qntx-wallet/kek/backup/v1"),
          32,
        );
      }
      assertPasswordPolicy(factor.password);
      const salt = salts[index];
      if (salt === undefined) {
        throw new KernelError("integrity", "backup: missing password salt");
      }
      return passwordKek(factor.password, salt, platform.pbkdf2);
    }),
  );
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
      iterations: PASSWORD_ITERATIONS,
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
  const { dek } = ctx.session.require(requestSession);
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(ctx.platform.keystore, "backup"),
  );
  const bek = ctx.platform.random(32);
  if (bek.length !== 32) {
    throw new KernelError("integrity", "random source returned a wrong-length BEK");
  }
  try {
    const materials: BackupMaterial[] = [];
    for (const factor of params.factors) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one system ceremony at a time
      materials.push(await backupMaterial(ctx, factor, []));
    }
    const factors = await sealBackupFactors(ctx.platform, bek, materials);
    const record = backupKeyRecord(ctx, dek, bek, factors);
    // put-record replaces an existing backup-key row.
    await ctx.commit([{ op: "put-record", record }]);
    return null;
  } finally {
    bek.fill(0);
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
      payloadContext(contents.header),
      "",
      ctx.platform.random,
    );
    try {
      const envelope: BackupEnvelopeWire = {
        version: 1,
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

/** Deletes the retained BEK; a missing record still succeeds. */
export async function disableBackup(
  ctx: KernelContext,
  _params: NullValue,
  requestSession: string | undefined,
): Promise<NullValue> {
  ctx.session.require(requestSession);
  const record = ctx.image.records.find(
    (r) => r.kind === BACKUP_KEY_KIND && r.id === BACKUP_KEY_ID,
  );
  if (record === undefined) {
    return null;
  }
  await ctx.commit([{ op: "delete-record", kind: BACKUP_KEY_KIND, id: BACKUP_KEY_ID }]);
  return null;
}

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
  const kek = await passwordKek(backupFactor.password, b64.dec(entry.salt), platform.pbkdf2);
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
): Promise<{ wallets: WalletInfo[]; passphraseRequired: string[]; session: string }> {
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
): Promise<{ wallets: WalletInfo[]; passphraseRequired: string[]; session: string }> {
  for (const entry of params.passphrases ?? []) {
    if (passphrases.has(entry.walletId)) {
      throw new KernelError("invalid-input", `duplicate passphrase for wallet ${entry.walletId}`);
    }
    passphrases.set(entry.walletId, normalizePassphrase(entry.passphrase));
  }
  const envelope = parseEnvelope(params.envelope);
  const credentials = envelope.factors.flatMap((f) =>
    f.kind === "passkey" ? [b64.dec(f.credentialId)] : [],
  );
  const bek = await bekFromFactor(
    ctx.platform,
    envelope,
    await backupMaterial(ctx, params.backupFactor, credentials),
  );
  try {
    // The payload tag authenticates the raw header text — parse the header only after this open.
    let plaintext: Uint8Array;
    try {
      plaintext = openEnvelope(bek, b64.dec(envelope.payload), payloadContext(envelope.header), "");
    } catch {
      throw new KernelError("integrity", "backup: payload authentication failed");
    }
    const header = parseHeader(envelope.header);
    const decoded = decodePayload(plaintext);
    if (
      decoded.wallets.length !== header.wallets.length ||
      decoded.keys.length !== (header.keys?.length ?? 0)
    ) {
      plaintext.fill(0);
      throw new KernelError("integrity", "backup: payload does not match header");
    }

    const flagged = new Set(
      header.wallets.filter((w) => w.passphrase === true).map((w) => w.walletId),
    );
    for (const walletId of passphrases.keys()) {
      if (!flagged.has(walletId)) {
        plaintext.fill(0);
        throw new KernelError("invalid-input", `wallet ${walletId} has no passphrase`);
      }
    }

    const gated = gate(ctx, params.factor, requestSession);
    const records: StoredRecord[] = [];
    const restored: WalletInfo[] = [];
    const passphraseRequired: string[] = [];
    let committed = false;
    try {
      try {
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
        if (gated.uninitialized) {
          // Adoption — only while the vault is being established, inside the same atomic
          // commit: a forged envelope merging into an existing vault can never hijack its
          // future backups.
          records.push(backupKeyRecord(ctx, gated.dek, bek, envelope.factors));
        }
        const session = await commitRecords(ctx, gated, params.factor, records);
        committed = true;
        return { wallets: restored, passphraseRequired, session };
      } catch (error) {
        // gate() minted a DEK nothing owns yet; commitRecords wipes it only past its own
        // commit and takes ownership on success — a failure in between leaks it here.
        if (!committed && gated.uninitialized) {
          gated.dek.wipe();
        }
        throw error;
      }
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
}
