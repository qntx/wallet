// Cloud-backup envelope (design/backup.mdx, E1-d-3): one version-1 envelope per vault. The
// plaintext payload is compact binary secrets only — per wallet `origin(1) ‖ len(1) ‖ entropy`,
// per imported Nostr key `secretKey(32)`, per chain key `family(1) ‖ secretKey(32)`. The BEK is a
// fresh 32-byte random; payload and per-factor sealedBek ride the vault envelope v1 seal.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";

import {
  backupEnvelope as backupEnvelopeValidator,
  backupHeader as backupHeaderValidator,
  validate,
} from "@qntx/wallet/protocol";
import type {
  BackupEnvelopeFactor,
  BackupEnvelopeWire,
  BackupHeaderWallet,
  BackupHeaderWire,
  Factor,
} from "@qntx/wallet/protocol";
import type { WalletInfo } from "@qntx/wallet/types";

import { KernelError } from "../errors.ts";
import type { KernelPlatform } from "../platform.ts";
import { open as openEnvelope, seal } from "../vault/envelope.ts";
import { assertPasswordPolicy, passwordKek } from "../vault/factors.ts";
import { parseEntropyHeader } from "../vault/headers.ts";
import type { StoredRecord } from "../vault/store.ts";
import { openRecord, verifyFactor } from "../vault/vault.ts";
import type { KernelContext } from "./context.ts";
import { commitRecords, gate, walletInfoOf, walletMaterial, walletRecord } from "./wallets.ts";

const PASSWORD_ITERATIONS = 600_000;

/** Payload tag bytes: wallet entry, imported nostr key, chain key. */
const ORIGIN_BYTE: Readonly<Record<"passkey" | "mnemonic", number>> = {
  mnemonic: 1,
  passkey: 2,
};
const ORIGIN_NAME: ReadonlyArray<"passkey" | "mnemonic" | undefined> = [
  undefined,
  "mnemonic",
  "passkey",
];

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
const PAYLOAD_NOSTR = 0x02;
const PAYLOAD_CHAIN = 0x03;

function encodePayload(
  wallets: ReadonlyArray<{
    origin: "passkey" | "mnemonic";
    entropy: Uint8Array;
  }>,
  nostrSecrets: ReadonlyArray<Uint8Array>,
): Uint8Array {
  const size =
    1 + wallets.reduce((acc, w) => acc + 3 + w.entropy.length, 0) + nostrSecrets.length * 33;
  const out = new Uint8Array(size);
  let off = 0;
  out[off++] = 1; // payload version
  for (const w of wallets) {
    out[off++] = PAYLOAD_WALLET;
    out[off++] = ORIGIN_BYTE[w.origin] ?? 0;
    out[off++] = w.entropy.length;
    out.set(w.entropy, off);
    off += w.entropy.length;
  }
  for (const s of nostrSecrets) {
    out[off++] = PAYLOAD_NOSTR;
    out.set(s, off);
    off += s.length;
  }
  return out;
}

function decodePayload(bytes: Uint8Array): {
  wallets: Array<{ origin: "passkey" | "mnemonic"; entropy: Uint8Array }>;
  nostrSecrets: Uint8Array[];
} {
  if (bytes.length === 0 || bytes[0] !== 1) {
    throw new KernelError("integrity", "backup: bad payload version");
  }
  const wallets: Array<{ origin: "passkey" | "mnemonic"; entropy: Uint8Array }> = [];
  const nostrSecrets: Uint8Array[] = [];
  let off = 1;
  while (off < bytes.length) {
    const tag = bytes[off++];
    if (tag === PAYLOAD_WALLET) {
      if (off + 2 > bytes.length) {
        break;
      }
      const ob = bytes[off];
      const len = bytes[off + 1];
      if (ob === undefined || len === undefined || off + 2 + len > bytes.length) {
        throw new KernelError("integrity", "backup: truncated payload");
      }
      off += 2;
      const origin = ORIGIN_NAME[ob];
      if (origin === undefined) {
        throw new KernelError("integrity", "backup: unknown origin byte");
      }
      wallets.push({ origin, entropy: bytes.slice(off, off + len) });
      off += len;
    } else if (tag === PAYLOAD_NOSTR) {
      if (off + 32 > bytes.length) {
        throw new KernelError("integrity", "backup: truncated payload");
      }
      nostrSecrets.push(bytes.slice(off, off + 32));
      off += 32;
    } else if (tag === PAYLOAD_CHAIN) {
      if (off + 33 > bytes.length) {
        throw new KernelError("integrity", "backup: truncated payload");
      }
      off += 33; // family(1) ‖ secretKey(32) — chain keys are not restorable yet
    } else {
      throw new KernelError("integrity", "backup: unknown payload tag");
    }
  }
  if (off !== bytes.length) {
    throw new KernelError("integrity", "backup: payload length mismatch");
  }
  return { wallets, nostrSecrets };
}

export type BackupFactor =
  | { readonly kind: "password"; readonly password: Uint8Array }
  | {
      readonly kind: "passkey";
      readonly credentialId: Uint8Array;
      readonly prfBackup: Uint8Array;
    };

export async function createBackup(
  ctx: KernelContext,
  params: {
    verify: Factor;
    factors: ReadonlyArray<BackupFactor>;
  },
  requestSession: string | undefined,
): Promise<{ envelope: string }> {
  const { dek } = ctx.session.require(requestSession);
  await verifyFactor(ctx.platform, ctx.image, params.verify, dek);

  // Wallet entropies + imported nostr secrets out of the sealed records.
  const wallets: Array<BackupHeaderWallet & { entropy: Uint8Array }> = [];
  const nostrSecrets: Uint8Array[] = [];
  for (const record of ctx.image.records) {
    if (record.kind === "entropy") {
      const header = parseEntropyHeader(record.header);
      const plaintext = openRecord(dek, record);
      try {
        wallets.push({
          walletId: record.id,
          origin: header.origin,
          words: header.words,
          entropy: plaintext,
        });
      } catch (error) {
        plaintext.fill(0);
        throw error;
      }
    }
  }
  const moduleSecrets = ctx.modules.flatMap((module) => module.backupSecrets(ctx.image, dek));
  nostrSecrets.push(...moduleSecrets);

  const headerData: BackupHeaderWire = {
    wallets: wallets.map(({ walletId, origin, words }) => ({ walletId, origin, words })),
    importedNostrKeyCount: nostrSecrets.length,
    importedChainKeyCount: 0,
  };
  const header = JSON.stringify(headerData);
  const bek = ctx.platform.random(32);
  if (bek.length !== 32) {
    throw new KernelError("integrity", "random source returned a wrong-length BEK");
  }
  const payloadPlaintext = encodePayload(wallets, nostrSecrets);
  const sealedPayload = seal(
    bek,
    payloadPlaintext,
    payloadContext(header),
    "",
    ctx.platform.random,
  );
  try {
    // Deterministic draw order: BEK, the payload seal nonce, every password salt in
    // factor-array order, then every sealedBek nonce in factor-array order. No random draw
    // follows an await, so async scheduling (pbkdf2 suspending) can never reorder it.
    const salts = params.factors.map((factor) =>
      factor.kind === "password" ? ctx.platform.random(16) : undefined,
    );
    const keks = await Promise.all(
      params.factors.map(async (factor, index) => {
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
        return passwordKek(factor.password, salt, ctx.platform.pbkdf2);
      }),
    );
    const factors = params.factors.map((factor, index): BackupEnvelopeFactor => {
      const kek = keks[index];
      if (kek === undefined) {
        throw new KernelError("integrity", "backup: missing factor key");
      }
      let sealedBek: Uint8Array;
      try {
        sealedBek = seal(kek, bek, factorContextOf(factor.kind), "", ctx.platform.random);
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
    const envelope: BackupEnvelopeWire = {
      version: 1,
      createdAt: ctx.platform.now(),
      header,
      factors,
      payload: b64.enc(sealedPayload),
    };
    return { envelope: JSON.stringify(envelope) };
  } finally {
    bek.fill(0);
    payloadPlaintext.fill(0);
    sealedPayload.fill(0);
    for (const w of wallets) {
      w.entropy.fill(0);
    }
    for (const s of nostrSecrets) {
      s.fill(0);
    }
  }
}

/** Unwraps the BEK under the caller's factor. A failed open maps to the factor's wrong-* code. */
async function bekFromFactor(
  platform: KernelPlatform,
  envelope: BackupEnvelopeWire,
  backupFactor: BackupFactor,
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
 * Restore is a merge, never an overwrite: existing wallet and imported-key ids are skipped,
 * everything else goes down in one commit so a torn restore can't leave half the secrets.
 */
export async function restoreBackup(
  ctx: KernelContext,
  params: { envelope: string; backupFactor: BackupFactor; factor?: Factor },
  requestSession: string | undefined,
): Promise<{ wallets: WalletInfo[]; session: string }> {
  const envelope = parseEnvelope(params.envelope);
  const bek = await bekFromFactor(ctx.platform, envelope, params.backupFactor);
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
      decoded.nostrSecrets.length !== header.importedNostrKeyCount ||
      decoded.wallets.length !== header.wallets.length
    ) {
      plaintext.fill(0);
      throw new KernelError("integrity", "backup: payload does not match header");
    }

    const gated = gate(ctx, params.factor, requestSession);
    const records: StoredRecord[] = [];
    const restored: WalletInfo[] = [];
    try {
      const now = ctx.platform.now();
      for (const [index, wallet] of decoded.wallets.entries()) {
        const expected = header.wallets[index];
        if (expected === undefined) {
          throw new KernelError("integrity", "backup: wallet count mismatch");
        }
        // oxlint-disable-next-line no-await-in-loop -- wallets re-derive serially; order matches the header
        const material = await walletMaterial(
          ctx.platform,
          wallet.entropy,
          wallet.origin,
          expected.words === 24 ? 24 : 12,
        );
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
      for (const module of ctx.modules) {
        records.push(
          ...module.backupRecords(ctx.platform, ctx.image, gated.dek, decoded.nostrSecrets, now),
        );
      }
      const session = await commitRecords(ctx, gated, params.factor, records);
      return { wallets: restored, session };
    } finally {
      plaintext.fill(0);
      for (const wallet of decoded.wallets) {
        wallet.entropy.fill(0);
      }
      for (const secretKey of decoded.nostrSecrets) {
        secretKey.fill(0);
      }
    }
  } finally {
    bek.fill(0);
  }
}
