import { describe, expect, it } from "vite-plus/test";

import { parseBackupHeader } from "../src/backup.ts";
import { WalletError } from "../src/types.ts";

const header = JSON.stringify({
  wallets: [{ walletId: "95fea534ed0f2996", origin: "mnemonic", words: 24 }],
});

const envelope = JSON.stringify({
  version: 2,
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
    const parsed = parseBackupHeader(envelope);
    expect(parsed.version).toBe(1);
    expect(parsed.wallets[0]?.walletId).toBe("95fea534ed0f2996");
    expect(parsed.wallets[0]?.origin).toBe("mnemonic");
    expect(parsed.factorKinds).toStrictEqual(["password", "passkey"]);
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
    const legacy = JSON.parse(envelope) as { version: number; factors: unknown[] };
    legacy.version = 1;
    legacy.factors[0] = { kind: "password", iterations: 600_000, salt: "AAAA", sealedBek: "BBBB" };
    expect(() => parseBackupHeader(JSON.stringify(legacy))).toThrow(WalletError);
  });
});
