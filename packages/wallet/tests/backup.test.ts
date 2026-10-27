import { describe, expect, it } from "vite-plus/test";

import { parseBackupHeader } from "../src/backup.ts";
import { WalletError } from "../src/types.ts";

const header = JSON.stringify({
  wallets: [{ walletId: "95fea534ed0f2996", origin: "mnemonic", words: 24 }],
  importedNostrKeyCount: 2,
  importedChainKeyCount: 0,
});

const envelope = JSON.stringify({
  version: 1,
  createdAt: 1_700_000_000_000,
  header,
  factors: [
    {
      kind: "password",
      iterations: 600_000,
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
    expect(parsed.importedNostrKeyCount).toBe(2);
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

  it("rejects a second password factor and non-600k iterations", () => {
    const obj = JSON.parse(envelope) as {
      factors: Array<Record<string, unknown>>;
    };
    obj.factors.push({
      kind: "password",
      iterations: 600_000,
      salt: "AAAA",
      sealedBek: "DDDD",
    });
    expect(() => parseBackupHeader(JSON.stringify(obj))).toThrow(WalletError);
    const bad = JSON.parse(envelope) as { factors: Array<{ iterations: number }> };
    bad.factors[0]!.iterations = 100_000;
    expect(() => parseBackupHeader(JSON.stringify(bad))).toThrow(WalletError);
  });
});
