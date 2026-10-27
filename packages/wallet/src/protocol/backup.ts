/**
 * Backup-envelope wire validators (design/backup.mdx): the strict structural shape the kernel and
 * the host-side `parseBackupHeader` share — version 1, bounded fields, `obj` rejects unknown keys.
 * Cryptographic checks (the payload tag, factor unwrap) stay in the kernel; these rules only shape
 * the JSON.
 */
import type { Validator } from "./validate.ts";
import { arr, int, literal, obj, str, union } from "./validate.ts";

const MAX_FACTOR_CHARS = 512;
const MAX_STRING_BYTES = 64_000;
const MAX_PAYLOAD_CHARS = 1_400_000; // ~1 MiB of sealed bytes in base64url
const MAX_ENVELOPE_CHARS = 4_000_000;

export type BackupEnvelopeFactor =
  | { readonly kind: "passkey"; readonly credentialId: string; readonly sealedBek: string }
  | {
      readonly kind: "password";
      readonly iterations: 600_000;
      readonly salt: string;
      readonly sealedBek: string;
    };

export type BackupEnvelopeWire = {
  readonly version: 1;
  readonly createdAt: number;
  /** Raw JSON text — authenticated by the payload tag before it is parsed. */
  readonly header: string;
  readonly factors: ReadonlyArray<BackupEnvelopeFactor>;
  readonly payload: string;
};

export const backupEnvelope: Validator<BackupEnvelopeWire> = obj({
  version: literal(1),
  createdAt: int(0, Number.MAX_SAFE_INTEGER),
  header: str(MAX_STRING_BYTES),
  factors: arr(
    union(
      obj({
        kind: literal("passkey"),
        credentialId: str(MAX_FACTOR_CHARS),
        sealedBek: str(MAX_FACTOR_CHARS),
      }),
      obj({
        kind: literal("password"),
        iterations: literal(600_000),
        salt: str(128),
        sealedBek: str(MAX_FACTOR_CHARS),
      }),
    ),
    5,
    1,
  ),
  payload: str(MAX_PAYLOAD_CHARS),
});

export type BackupHeaderWallet = {
  readonly walletId: string;
  readonly origin: "mnemonic" | "passkey";
  readonly words: 12 | 15 | 18 | 21 | 24;
};

export type BackupHeaderWire = {
  readonly wallets: ReadonlyArray<BackupHeaderWallet>;
  readonly importedNostrKeyCount: number;
  readonly importedChainKeyCount: number;
};

export const backupHeader: Validator<BackupHeaderWire> = obj({
  wallets: arr(
    obj({
      walletId: str(128),
      origin: union(literal("mnemonic"), literal("passkey")),
      words: union(literal(12), literal(15), literal(18), literal(21), literal(24)),
    }),
    1000,
  ),
  importedNostrKeyCount: int(0, 10_000),
  importedChainKeyCount: int(0, 10_000),
});

/** The whole-envelope text bound — `backup.create` results and `backup.restore` params use it. */
export const backupEnvelopeText: Validator<string> = str(MAX_ENVELOPE_CHARS);
