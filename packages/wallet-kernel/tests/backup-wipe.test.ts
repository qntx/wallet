// Secret-wipe coverage for backup failures (L1, L2): every secret buffer a failed
// `backup.enable` or `backup.restore` touched must be zeroed — the wire factor secrets,
// the minted BEK, the opened payload plaintext and every copy the payload decoder made.
// The payload `open` is intercepted so tests can substitute a crafted plaintext; a
// `slice` spy catches any copy of the plaintext left non-zero.

import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";
import type { WalletErrorCode } from "@qntx/wallet/types";

import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("11".repeat(32));
const PRF_WALLET = hexToBytes("22".repeat(32));
const PRF_BACKUP = hexToBytes("33".repeat(32));
const PASSWORD = utf8ToBytes("correct horse battery");

/**
 * Intercept state: `override` replaces the payload plaintext; `opened` records each
 * buffer `open` returned for it together with a snapshot of its content at open time
 * (the buffer itself is wiped by the code under test — the snapshot is what copies
 * are compared against).
 */
const payloadOpen = vi.hoisted(() => ({
  override: undefined as Uint8Array | undefined,
  opened: [] as Array<{ buffer: Uint8Array; content: Uint8Array }>,
}));

vi.mock("../src/vault/envelope.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/vault/envelope.ts")>();
  return {
    ...original,
    open: (key: Uint8Array, sealed: Uint8Array, context: string, header: string): Uint8Array => {
      if (!context.startsWith("qntx-wallet/backup/v1/payload/")) {
        return original.open(key, sealed, context, header);
      }
      const plaintext = payloadOpen.override ?? original.open(key, sealed, context, header);
      payloadOpen.opened.push({ buffer: plaintext, content: Uint8Array.from(plaintext) });
      return plaintext;
    },
  };
});

function ok(response: KernelResponse): ProtocolValue {
  if ("ok" in response) {
    return response.ok;
  }
  throw new Error(`expected ok, got ${JSON.stringify(response)}`);
}

function errCode(response: KernelResponse): WalletErrorCode {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error("expected err");
}

function strField(value: ProtocolValue, key: string): string {
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const entry = (value as Record<string, ProtocolValue>)[key];
    if (typeof entry === "string") {
      return entry;
    }
  }
  throw new Error(`missing string field ${key}`);
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const entry = (value as Record<string, ProtocolValue>)[key];
    if (entry !== undefined) {
      return entry;
    }
  }
  throw new Error(`missing field ${key}`);
}

const zeroed = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

/** Whether `needle`'s bytes occur contiguously inside `haystack`. */
const contains = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
};

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(PRF_VAULT),
});

const backupPasskeyF = () => ({
  kind: "passkey" as const,
  ceremony: "host" as const,
  credentialId: CREDENTIAL_ID,
  prfBackup: new Uint8Array(PRF_BACKUP),
});

const backupPasswordF = () => ({
  kind: "password" as const,
  password: new Uint8Array(PASSWORD),
});

async function createPasskeyWallet(h: Harness): Promise<{ session: string; walletId: string }> {
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: PRF_WALLET,
      synced: true,
      factor: {
        kind: "passkey" as const,
        credentialId: CREDENTIAL_ID,
        prf: new Uint8Array(PRF_VAULT),
      },
    }),
  );
  const info = field(res, "wallet") as Record<string, ProtocolValue>;
  return { session: strField(res, "session"), walletId: String(info["walletId"]) };
}

async function createBackupEnvelope(
  h: Harness,
  session: string,
  factors: ReadonlyArray<unknown>,
): Promise<string> {
  await h.call("backup.enable", { verify: verifyPasskey(), factors }, session);
  const res = ok(await h.call("backup.update", null, session));
  return strField(res, "envelope");
}

/** Every buffer `Uint8Array.prototype.slice` produced while `run` executed. */
async function slicedDuring(run: () => Promise<unknown>): Promise<Uint8Array[]> {
  const sliced: Uint8Array[] = [];
  const original = Uint8Array.prototype.slice;
  const spy = vi
    .spyOn(Uint8Array.prototype, "slice")
    .mockImplementation(function (this: Uint8Array, start?: number, end?: number) {
      const copy = original.call(this, start, end);
      sliced.push(copy);
      return copy;
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return sliced;
}

/** Every opened payload plaintext is zero, and no slice of its content survived non-zero. */
function expectPlaintextWiped(sliced: ReadonlyArray<Uint8Array>): void {
  expect(payloadOpen.opened.length).toBeGreaterThan(0);
  for (const { buffer, content } of payloadOpen.opened) {
    expect(zeroed(buffer)).toBe(true);
    const copies = sliced.filter((copy) => contains(content, copy));
    expect(copies.every(zeroed)).toBe(true);
  }
}

/** A payload entry: tag(1) ‖ origin-or-family(1) ‖ length(1) ‖ secret. */
const entry = (tag: number, kind: number, secret: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([tag, kind, secret.length]), secret);

afterEach(() => {
  payloadOpen.override = undefined;
  payloadOpen.opened.length = 0;
});

describe("backup.enable secret wiping", () => {
  it("wipes the wire backup secrets when verification fails", async () => {
    const h = createHarness();
    await h.settle();
    const { session } = await createPasskeyWallet(h);
    const password = new Uint8Array(PASSWORD);
    const prfBackup = new Uint8Array(PRF_BACKUP);
    const badVerify = {
      kind: "passkey" as const,
      credentialId: CREDENTIAL_ID,
      prf: hexToBytes("99".repeat(32)),
    };
    expect(
      errCode(
        await h.call(
          "backup.enable",
          {
            verify: badVerify,
            factors: [
              { kind: "password", password },
              { kind: "passkey", ceremony: "host", credentialId: CREDENTIAL_ID, prfBackup },
            ],
          },
          session,
        ),
      ),
    ).toBe("wrong-passkey");
    expect(zeroed(password)).toBe(true);
    expect(zeroed(prfBackup)).toBe(true);
  });

  it("wipes the wire backup secrets when there is no session", async () => {
    const h = createHarness();
    await h.settle();
    await createPasskeyWallet(h);
    const password = new Uint8Array(PASSWORD);
    const prfBackup = new Uint8Array(PRF_BACKUP);
    expect(
      errCode(
        await h.call(
          "backup.enable",
          {
            verify: verifyPasskey(),
            factors: [
              { kind: "password", password },
              { kind: "passkey", ceremony: "host", credentialId: CREDENTIAL_ID, prfBackup },
            ],
          },
          "00".repeat(16),
        ),
      ),
    ).toBe("locked");
    expect(zeroed(password)).toBe(true);
    expect(zeroed(prfBackup)).toBe(true);
  });
});

describe("backup.restore secret wiping", () => {
  const envelopeWithPasswordFactor = async () => {
    const a = createHarness({ seed: 7 });
    await a.settle();
    const { session, walletId } = await createPasskeyWallet(a);
    const envelope = await createBackupEnvelope(a, session, [backupPasswordF(), backupPasskeyF()]);
    return { envelope, walletId };
  };

  const restoringHarness = async () => {
    const b = createHarness({ seed: 8 });
    await b.settle();
    const { session } = await createPasskeyWallet(b);
    return { b, session };
  };

  it("opens no plaintext when the gate fails on an initialized vault", async () => {
    const { envelope } = await envelopeWithPasswordFactor();
    const { b, session } = await restoringHarness();
    expect(
      errCode(
        await b.call(
          "backup.restore",
          {
            envelope,
            backupFactor: backupPasswordF(),
            factor: backupPasswordF(),
          },
          session,
        ),
      ),
    ).toBe("invalid-input");
    // The gate ran before any decryption: the payload `open` never produced a plaintext.
    expect(payloadOpen.opened).toHaveLength(0);
  });

  it("wipes the plaintext and every copy when a passphrase names an unflagged wallet", async () => {
    const { envelope, walletId } = await envelopeWithPasswordFactor();
    const { b, session } = await restoringHarness();
    const sliced = await slicedDuring(async () => {
      expect(
        errCode(
          await b.call(
            "backup.restore",
            {
              envelope,
              backupFactor: backupPasswordF(),
              passphrases: [{ walletId, passphrase: utf8ToBytes("spare") }],
            },
            session,
          ),
        ),
      ).toBe("invalid-input");
    });
    expectPlaintextWiped(sliced);
  });

  it("wipes the plaintext and every copy when the payload mismatches the header", async () => {
    const { envelope } = await envelopeWithPasswordFactor();
    const { b, session } = await restoringHarness();
    // Two wallet entries against a one-wallet header — a count mismatch after the open.
    payloadOpen.override = concatBytes(
      new Uint8Array([2]),
      entry(0x01, 0x02, hexToBytes("ab".repeat(16))),
      entry(0x01, 0x02, hexToBytes("cd".repeat(16))),
    );
    const sliced = await slicedDuring(async () => {
      expect(
        errCode(
          await b.call(
            "backup.restore",
            { envelope, backupFactor: backupPasswordF() },
            session,
          ),
        ),
      ).toBe("integrity");
    });
    expectPlaintextWiped(sliced);
  });

  it("wipes the plaintext when the payload itself fails to decode", async () => {
    const { envelope } = await envelopeWithPasswordFactor();
    const { b, session } = await restoringHarness();
    // version(1) ‖ a wallet tag truncated mid-entry — decodePayload throws after pushing a view.
    payloadOpen.override = new Uint8Array([2, 0x01]);
    const sliced = await slicedDuring(async () => {
      expect(
        errCode(
          await b.call(
            "backup.restore",
            { envelope, backupFactor: backupPasswordF() },
            session,
          ),
        ),
      ).toBe("integrity");
    });
    expectPlaintextWiped(sliced);
  });
});
