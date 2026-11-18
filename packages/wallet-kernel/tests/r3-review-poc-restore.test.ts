/**
 * R3 review proof-of-concept tests: every `POC Fx:` test asserts the CURRENT behaviour, so it
 * passes today and fails once the finding is fixed. They must not be "fixed" by editing them —
 * a failure after a product change is the intended signal.
 *
 * F7 lives in its own file: the vi.mock below wraps `open` for every backup envelope operation in
 * this file and would record unrelated opens in the shared PoC file.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";

const captured = vi.hoisted(() => ({
  opened: [] as Array<{ context: string; out: Uint8Array }>,
}));

vi.mock("../src/vault/envelope.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/vault/envelope.ts")>();
  return {
    ...mod,
    // Passthrough that records every plaintext `open` returns, so the test can assert the
    // decrypted backup payload still holds secrets after a late-failing restore.
    open: (...args: Parameters<typeof mod.open>) => {
      const out = mod.open(...args);
      captured.opened.push({ context: args[2], out });
      return out;
    },
  };
});

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = new Uint8Array(32).fill(0x11);
const PRF_WALLET = new Uint8Array(32).fill(0x22);
const PASSWORD = utf8ToBytes("correct horse battery");

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}

const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const zeroed = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

const vaultPasswordFactor = () => ({
  kind: "password" as const,
  password: new Uint8Array(PASSWORD),
});

const backupPassword = () => ({
  kind: "password" as const,
  password: new Uint8Array(PASSWORD),
});

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF_VAULT),
});

async function createPasskeyWallet(h: Harness): Promise<{ session: string }> {
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: new Uint8Array(CREDENTIAL_ID),
      prfWallet: new Uint8Array(PRF_WALLET),
      synced: true,
      factor: { kind: "passkey", credentialId: new Uint8Array(CREDENTIAL_ID), prf: new Uint8Array(PRF_VAULT) },
    }),
  );
  return { session: strField(res, "session") };
}

async function setupEnvelope(seed: number): Promise<string> {
  const a = createHarness({ seed });
  await a.settle();
  const { session } = await createPasskeyWallet(a);
  ok(
    await a.call(
      "backup.enable",
      { verify: verifyPasskey(), factors: [backupPassword()] },
      session,
    ),
  );
  const out = ok(await a.call("backup.update", null, session));
  return strField(out, "envelope");
}

/** Records (src → slice-copy) pairs for every Uint8Array.slice during the wrapped call. */
async function withSliceSpy<T>(body: () => Promise<T>): Promise<{
  result: T;
  slices: Array<{ src: Uint8Array; out: Uint8Array }>;
}> {
  const slices: Array<{ src: Uint8Array; out: Uint8Array }> = [];
  const orig = Uint8Array.prototype.slice;
  const spy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (
    this: Uint8Array,
    ...args: Parameters<Uint8Array["slice"]>
  ) {
    const out = orig.apply(this, args);
    slices.push({ src: this, out });
    return out;
  });
  try {
    const result = await body();
    return { result, slices };
  } finally {
    spy.mockRestore();
  }
}

/** The payload plaintexts `open` returned — the payload context distinguishes them from BEKs. */
const payloadPlaintexts = (): Uint8Array[] =>
  captured.opened
    .filter((o) => o.context.startsWith("qntx-wallet/backup/v1/payload/"))
    .map((o) => o.out);

describe("POC F7: a restore failing after the payload opened leaks decrypted bytes", () => {
  it("POC F7: gate's already-initialized throw skips the plaintext/entropy wipe", async () => {
    const envelope = await setupEnvelope(7);
    captured.opened.length = 0;

    const b = createHarness({ seed: 8 });
    await b.settle();
    const { session: bSession } = await createPasskeyWallet(b);

    const { result, slices } = await withSliceSpy(() =>
      b.call(
        "backup.restore",
        {
          envelope,
          backupFactor: backupPassword(),
          factor: vaultPasswordFactor(),
        },
        bSession,
      ),
    );
    expect(errCode(result)).toBe("invalid-input");

    // Vulnerable: the decrypted payload is still in memory — version byte and wallet entropy intact.
    const payloads = payloadPlaintexts();
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(p[0]).toBe(0x02);
      expect(zeroed(p)).toBe(false);
    }
    // So are the entropy copies decodePayload sliced out of it.
    const entropyCopies = slices.filter((s) => payloads.includes(s.src));
    expect(entropyCopies.length).toBeGreaterThan(0);
    expect(entropyCopies.some((s) => !zeroed(s.out))).toBe(true);
  });

  it("POC F7: an unflagged-wallet passphrase zeroes the plaintext but not the entropy slices", async () => {
    const envelope = await setupEnvelope(9);
    const parsed = JSON.parse(envelope) as { header: string };
    const header = JSON.parse(parsed.header) as { wallets: Array<{ walletId: string }> };
    const walletId = header.wallets[0]?.walletId;
    expect(walletId).toBeDefined();
    captured.opened.length = 0;

    const b = createHarness({ seed: 10 });
    await b.settle();
    const { result, slices } = await withSliceSpy(() =>
      b.call("backup.restore", {
        envelope,
        backupFactor: backupPassword(),
        passphrases: [{ walletId: walletId ?? "", passphrase: utf8ToBytes("hunter2") }],
        factor: vaultPasswordFactor(),
      }),
    );
    expect(errCode(result)).toBe("invalid-input");

    // The plaintext itself was wiped at the check, but the sliced entropy copies were not.
    const payloads = payloadPlaintexts();
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(zeroed(p)).toBe(true);
    }
    const entropyCopies = slices.filter((s) => payloads.includes(s.src));
    expect(entropyCopies.length).toBeGreaterThan(0);
    expect(entropyCopies.some((s) => !zeroed(s.out))).toBe(true);
  });
});
