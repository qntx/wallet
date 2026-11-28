// Read-only envelope inspection for the host: lists what a backup restores before the factor
// ceremony runs. `header` is authenticated by the payload tag at restore time — this parser only
// validates structure (bounded lengths, unknown fields rejected via the shared validators), so
// nothing garbage reaches the kernel.

import { base64urlnopad } from "@scure/base";

import type { BackupHeaderKey, BackupHeaderWire } from "./protocol/index.ts";
import { backupEnvelope, backupEnvelopeReason, backupHeader, validate } from "./protocol/index.ts";
import { WalletError } from "./types.ts";
import type { Unsupported } from "./types.ts";

export type BackupHeaderWallet = BackupHeaderWire["wallets"][number];
export type { BackupHeaderKey } from "./protocol/index.ts";

export type BackupHeader = {
  readonly status: "ok";
  readonly createdAt: number;
  readonly wallets: ReadonlyArray<BackupHeaderWallet>;
  /** Imported keys carried by the payload; empty when there are none. */
  readonly keys: ReadonlyArray<BackupHeaderKey>;
  /** The factor kinds the envelope can be unwrapped with. */
  readonly factorKinds: ReadonlyArray<"passkey" | "password">;
};

/**
 * What a backup file's header inspection can report: a readable header, or `unsupported` — the
 * envelope was written by a build this one cannot read (`older`: restore from the mnemonic;
 * `newer`: update the app).
 */
export type BackupInspection = BackupHeader | Unsupported;

function integrity(msg: string): never {
  throw new WalletError("integrity", `backup: ${msg}`);
}

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return integrity(`${what} is not JSON`);
  }
}

/**
 * Validates the envelope and returns the header fields — no secrets, no writes. An envelope whose
 * `version` this build does not read returns `{ status: "unsupported", reason }` instead of
 * throwing (the version is checked right after the JSON parse, before strict validation); anything
 * malformed still throws `WalletError` integrity.
 */
export function parseBackupHeader(envelope: string): BackupInspection {
  if (envelope.length > 4_000_000) {
    integrity("envelope too large");
  }
  const value = json(envelope, "envelope");
  const reason = backupEnvelopeReason(value);
  if (reason !== undefined) {
    return { status: "unsupported", reason };
  }
  const parsed = validate(backupEnvelope, value);
  if (parsed === undefined) {
    integrity("malformed envelope");
  }
  const header = validate(backupHeader, json(parsed.header, "header"));
  if (header === undefined) {
    integrity("malformed header");
  }
  const factorKinds = parsed.factors.map((f) => f.kind);
  if (factorKinds.filter((k) => k === "password").length > 1) {
    integrity("at most one password factor");
  }
  return {
    status: "ok",
    createdAt: parsed.createdAt,
    wallets: header.wallets,
    keys: header.keys ?? [],
    factorKinds,
  };
}

/**
 * The passkey credential ids the envelope's factor entries name — the allow-list a restore's
 * passkey assertion is scoped to (a restored vault's own credentials are a different set).
 */
export function backupPasskeyCredentialIds(envelope: string): ReadonlyArray<Uint8Array> {
  const parsed = validate(backupEnvelope, json(envelope, "envelope"));
  if (parsed === undefined) {
    integrity("malformed envelope");
  }
  return parsed.factors.flatMap((factor) => {
    if (factor.kind !== "passkey") {
      return [];
    }
    try {
      return [base64urlnopad.decode(factor.credentialId)];
    } catch {
      return integrity("invalid credential encoding");
    }
  });
}
