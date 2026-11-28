import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { parseBackupHeader } from "../src/backup.ts";
import type { BackupHeader, BackupInspection } from "../src/backup.ts";
import { WalletError } from "../src/types.ts";

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/unsupported.json", import.meta.url)),
    "utf8",
  ),
) as {
  backup: {
    cases: Array<{
      name: string;
      envelope: string;
      expect: "ok" | "integrity" | { status: "unsupported"; reason: "older" | "newer" };
    }>;
  };
};

/** A parse expected to be readable — fail loudly if it is not. */
const headerOf = (text: string): BackupHeader => {
  const parsed = parseBackupHeader(text);
  if (parsed.status !== "ok") {
    throw new Error("expected a readable header");
  }
  return parsed;
};

/** The verdict of one vector case: "ok", "integrity" (it throws) or the direction object. */
const verdictOf = (text: string): "ok" | "integrity" | BackupInspection => {
  try {
    const parsed = parseBackupHeader(text);
    return parsed.status === "ok" ? "ok" : parsed;
  } catch (error) {
    if (error instanceof WalletError) {
      return "integrity";
    }
    throw error;
  }
};

const header = JSON.stringify({
  wallets: [{ walletId: "95fea534ed0f2996", origin: "mnemonic", words: 24 }],
});

const envelope = JSON.stringify({
  version: 3,
  createdAt: 1_700_000_000_000,
  header,
  factors: [
    {
      kind: "password",
      kdf: "argon2id",
      memoryKiB: 65_536,
      passes: 3,
      lanes: 4,
      salt: "AAAA",
      sealedBek: "BBBB",
    },
    { kind: "passkey", credentialId: "Y3JlZA", sealedBek: "CCCC" },
  ],
  payload: "cGF5bG9hZA",
});

describe("parseBackupHeader", () => {
  it("parses a valid envelope and reports factor kinds", () => {
    const parsed = headerOf(envelope);
    expect(parsed.wallets[0]?.walletId).toBe("95fea534ed0f2996");
    expect(parsed.wallets[0]?.origin).toBe("mnemonic");
    expect(parsed.factorKinds).toStrictEqual(["password", "passkey"]);
    expect(parsed.keys).toStrictEqual([]);
  });

  it("reports the header's imported keys", () => {
    const obj = JSON.parse(envelope) as { header: string };
    const h = JSON.parse(obj.header) as Record<string, unknown>;
    h["keys"] = [
      { keyId: "0123456789abcdef", family: "evm" },
      { keyId: "fedcba9876543210", family: "solana" },
    ];
    obj.header = JSON.stringify(h);
    const parsed = headerOf(JSON.stringify(obj));
    expect(parsed.keys).toStrictEqual([
      { keyId: "0123456789abcdef", family: "evm" },
      { keyId: "fedcba9876543210", family: "solana" },
    ]);
  });

  it("rejects an oversized envelope", () => {
    const big = envelope + " ".repeat(4_000_001);
    expect(() => parseBackupHeader(big)).toThrow(WalletError);
  });

  it("rejects an unknown top-level field", () => {
    const obj = JSON.parse(envelope) as Record<string, unknown>;
    obj["extra"] = 1;
    expect(() => parseBackupHeader(JSON.stringify(obj))).toThrow(WalletError);
  });

  it("rejects an unknown header field", () => {
    const obj = JSON.parse(envelope) as Record<string, unknown>;
    const h = JSON.parse(header) as Record<string, unknown>;
    h["publicKey"] = "aa";
    obj["header"] = JSON.stringify(h);
    expect(() => parseBackupHeader(JSON.stringify(obj))).toThrow(WalletError);
  });

  it("rejects a second password factor, a weaker cost and the PBKDF2 envelope", () => {
    const obj = JSON.parse(envelope) as {
      factors: Array<Record<string, unknown>>;
    };
    obj.factors.push({
      kind: "password",
      kdf: "argon2id",
      memoryKiB: 65_536,
      passes: 3,
      lanes: 4,
      salt: "AAAA",
      sealedBek: "DDDD",
    });
    expect(() => parseBackupHeader(JSON.stringify(obj))).toThrow(WalletError);
    const weak = JSON.parse(envelope) as { factors: Array<{ memoryKiB: number }> };
    weak.factors[0]!.memoryKiB = 19_456;
    expect(() => parseBackupHeader(JSON.stringify(weak))).toThrow(WalletError);
    const pbkdf2 = JSON.parse(envelope) as { factors: unknown[] };
    pbkdf2.factors[0] = { kind: "password", iterations: 600_000, salt: "AAAA", sealedBek: "BBBB" };
    expect(() => parseBackupHeader(JSON.stringify(pbkdf2))).toThrow(WalletError);
  });

  it.each(vectors.backup.cases)("vector $name", ({ envelope: text, expect: expected }) => {
    expect(verdictOf(text)).toStrictEqual(expected);
  });
});
