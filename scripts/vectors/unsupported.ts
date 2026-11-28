/// <reference types="node" />
/**
 * Regenerates vectors/unsupported.json without importing kernel code: the persisted formats this
 * build classifies as `unsupported` with a direction, spelled out literally —
 *
 * - `vault`: full vault images (`{meta, records, factors}`, `sealed` as hex). `format` alone decides
 *   `older` (below VAULT_FORMAT 6 — e.g. the 0.13 meta that still carried
 *   `failedAttempts`/`lastFailureAt`) or `newer` (above it, or content inside format 6 this build
 *   has no reader for — a record kind no module owns). A non-integer format is `integrity`.
 * - `vaultDb` / `engineDb` / `publicDb`: IndexedDB database versions — below current `older`, above
 *   `newer`. There is no older vault or public database (both are at their first schema).
 * - `backup`: envelope JSON texts. `version` alone decides: below BACKUP_ENVELOPE_VERSION 3 `older`
 *   (v1 carried a PBKDF2 `iterations` password factor), above `newer`; a missing or non-integer
 *   version stays `integrity`.
 *
 * `expect` is `{status:"unsupported",reason}`, `"ok"` or `"integrity"`.
 *
 * Run from the repo root: bun scripts/vectors/unsupported.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const KEY_ID = "0123456789abcdef0123456789abcdef";
const SEALED = "deadbeef000000000000000000000000";

const unsupported = (reason: "older" | "newer") => ({ status: "unsupported", reason });

/** The current format: format, revision and keyId — counters live in the vault anchor. */
const meta = (format: number, revision = 4): Record<string, unknown> => ({
  format,
  revision,
  keyId: KEY_ID,
});

/** The 0.13 meta: format 3–5 still carried the failure counters inside the image. */
const legacyMeta = (format: number): Record<string, unknown> => ({
  ...meta(format),
  failedAttempts: 2,
  lastFailureAt: 1_700_000_000_000,
});

const image = (
  metaValue: unknown,
  records: unknown[] = [],
): { meta: unknown; records: unknown[]; factors: unknown[] } => ({
  meta: metaValue,
  records,
  factors: [],
});

const record = (kind: string, id: string, header: string): Record<string, unknown> => ({
  kind,
  id,
  header,
  sealed: SEALED,
});

const manifest = record("manifest", "default", "{}");

const vault = {
  current: 6,
  cases: [
    {
      name: "format-3",
      image: image(legacyMeta(3)),
      expect: unsupported("older"),
    },
    {
      name: "format-5",
      image: image(legacyMeta(5)),
      expect: unsupported("older"),
    },
    {
      name: "format-6",
      image: image(meta(6), [manifest]),
      expect: "ok",
    },
    {
      name: "format-7",
      image: image(meta(7)),
      expect: unsupported("newer"),
    },
    {
      name: "format-max-safe",
      image: image(meta(Number.MAX_SAFE_INTEGER)),
      expect: unsupported("newer"),
    },
    {
      name: "format-non-integer",
      image: image(meta(1.5)),
      expect: "integrity",
    },
    {
      name: "unknown-record-kind",
      image: image(meta(6), [manifest, record("frost-share", "id-1", "{}")]),
      expect: unsupported("newer"),
    },
  ],
};

const vaultDb = {
  current: 1,
  cases: [{ name: "version-2", version: 2, expect: unsupported("newer") }],
};

const envelope = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    createdAt: 1_700_000_000_000,
    header: JSON.stringify({
      wallets: [{ walletId: "95fea534ed0f2996", origin: "mnemonic", words: 24 }],
    }),
    payload: "cGF5bG9hZA",
    ...fields,
  });

const argon2idFactor = {
  kind: "password",
  kdf: "argon2id",
  memoryKiB: 65_536,
  passes: 3,
  lanes: 4,
  salt: "AAAA",
  sealedBek: "BBBB",
};

/** A v1 factor: the PBKDF2 password shape this build no longer reads. */
const pbkdf2Factor = { kind: "password", iterations: 600_000, salt: "AAAA", sealedBek: "BBBB" };

/** A structurally valid v3 envelope — the fixed one from vectors/backup.json. */
const validV3 = (() => {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../vectors/backup.json"), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || !("envelopes" in parsed)) {
    throw new Error("vectors/backup.json has no envelopes list");
  }
  const { envelopes } = parsed;
  if (!Array.isArray(envelopes)) {
    throw new TypeError("vectors/backup.json envelopes is not a list");
  }
  const text = envelopes.find((entry): entry is string => typeof entry === "string");
  const envelope: unknown = text === undefined ? undefined : JSON.parse(text);
  if (typeof envelope !== "object" || envelope === null || !("version" in envelope)) {
    throw new Error("vectors/backup.json envelopes[0] is not a version-3 envelope");
  }
  if (envelope.version !== 3 || typeof text !== "string") {
    throw new Error("vectors/backup.json envelopes[0] is not a version-3 envelope");
  }
  return text;
})();

const backup = {
  current: 3,
  cases: [
    {
      name: "v1-pbkdf2",
      envelope: envelope({ version: 1, factors: [pbkdf2Factor] }),
      expect: unsupported("older"),
    },
    {
      name: "v2",
      envelope: envelope({ version: 2, factors: [argon2idFactor] }),
      expect: unsupported("older"),
    },
    {
      name: "v3-valid",
      envelope: validV3,
      expect: "ok",
    },
    {
      name: "v4",
      envelope: envelope({ version: 4, factors: [argon2idFactor] }),
      expect: unsupported("newer"),
    },
    {
      name: "version-string",
      envelope: envelope({ version: "3", factors: [argon2idFactor] }),
      expect: "integrity",
    },
    {
      name: "version-missing",
      envelope: envelope({ factors: [argon2idFactor] }),
      expect: "integrity",
    },
  ],
};

const engineDb = {
  current: 2,
  cases: [
    { name: "version-1", version: 1, expect: unsupported("older") },
    { name: "version-2", version: 2, expect: "ok" },
    { name: "version-3", version: 3, expect: unsupported("newer") },
  ],
};

const publicDb = {
  current: 1,
  cases: [{ name: "version-2", version: 2, expect: unsupported("newer") }],
};

const out = resolve(import.meta.dirname, "../../vectors/unsupported.json");
writeFileSync(out, `${JSON.stringify({ vault, vaultDb, backup, engineDb, publicDb }, null, 2)}\n`);
console.log(`wrote ${out}`);
