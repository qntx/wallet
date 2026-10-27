// Read-only envelope inspection for the host: lists what a backup restores before the factor
// ceremony runs. `header` is authenticated by the payload tag at restore time — this parser only
// validates structure (bounded lengths, unknown fields rejected via the shared validators), so
// nothing garbage reaches the kernel.

import type { BackupHeaderWire } from "./protocol/index.ts";
import { backupEnvelope, backupHeader, validate } from "./protocol/index.ts";
import { WalletError } from "./types.ts";

export type BackupHeaderWallet = BackupHeaderWire["wallets"][number];

export type BackupHeader = {
  readonly version: 1;
  readonly createdAt: number;
  readonly wallets: ReadonlyArray<BackupHeaderWallet>;
  readonly importedNostrKeyCount: number;
  readonly importedChainKeyCount: number;
  /** The factor kinds the envelope can be unwrapped with. */
  readonly factorKinds: ReadonlyArray<"passkey" | "password">;
};

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

/** Strictly validates the envelope and returns the header fields — no secrets, no writes. */
export function parseBackupHeader(envelope: string): BackupHeader {
  if (envelope.length > 4_000_000) {
    integrity("envelope too large");
  }
  const parsed = validate(backupEnvelope, json(envelope, "envelope"));
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
    version: 1,
    createdAt: parsed.createdAt,
    wallets: header.wallets,
    importedNostrKeyCount: header.importedNostrKeyCount,
    importedChainKeyCount: header.importedChainKeyCount,
    factorKinds,
  };
}
