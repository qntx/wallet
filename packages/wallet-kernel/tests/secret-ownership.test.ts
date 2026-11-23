/**
 * The kernel consumes and wipes each secret byte field it receives, so a secret that shares memory
 * with another field — the same object or an overlapping view of one buffer — would zero the other
 * field mid-request: a `chain.sign` prompt shows the message while the sign pass then signs zeros.
 * `respond` refuses such requests before any decode or prompt.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { assertExclusiveSecrets } from "../src/secret/ownership.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASS = "correct horse battery staple solana";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

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

function bytesField(value: ProtocolValue, key: string): Uint8Array {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError("expected bytes");
  }
  return v;
}

function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key}: not a string`);
  }
  return v;
}

const setup = async (h: Harness): Promise<{ session: string; walletId: string }> => {
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: { kind: "password", password: utf8ToBytes(PASS) },
    }),
  );
  return {
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
};

const messageRequest = (walletId: string, message: Uint8Array) =>
  normalizeSolana(
    {
      kind: "solana.message",
      network: NETWORK,
      account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
      message,
      format: "raw",
    },
    SOL_ADDRESS,
  );

describe("chain.sign", () => {
  it.each([
    {
      label: "same object",
      alias: (message: Uint8Array): Uint8Array => message,
    },
    {
      label: "overlapping view",
      alias: (message: Uint8Array): Uint8Array => new Uint8Array(message.buffer, 0, message.length),
    },
  ])("refuses when verify.password shares memory with the message ($label)", async ({ alias }) => {
    const h = createHarness();
    const { session, walletId } = await setup(h);
    // The buffer doubles as the text message and the verifying password, like a host that
    // hands the same bytes to both fields.
    const message = utf8ToBytes(PASS);
    const password = alias(message);
    const request = messageRequest(walletId, message);
    const response = await h.call(
      "chain.sign",
      { request, verify: { kind: "password", password } },
      session,
    );
    expect(errCode(response)).toBe("invalid-input");
    // Refused before the secret is consumed: the message keeps the bytes the prompt showed.
    expect(message).toStrictEqual(utf8ToBytes(PASS));
  });

  it("signs when the secret and the message are disjoint views of one buffer", async () => {
    const h = createHarness();
    const { session, walletId } = await setup(h);
    // A raw message is blind until the vault allows it.
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "password", password: utf8ToBytes(PASS) } },
        session,
      ),
    );
    const text = utf8ToBytes("hello solana");
    const passBytes = utf8ToBytes(PASS);
    const backing = new Uint8Array(text.length + passBytes.length);
    backing.set(text);
    backing.set(passBytes, text.length);
    const message = backing.subarray(0, text.length);
    const password = backing.subarray(text.length);
    const request = messageRequest(walletId, message);
    const response = ok(
      await h.call("chain.sign", { request, verify: { kind: "password", password } }, session),
    );
    expect(verifySolanaSignature(text, bytesField(response, "signature"), SOL_ADDRESS)).toBe(true);
  });
});

describe("wallet.importMnemonic", () => {
  it("refuses when mnemonic and passphrase share memory and writes nothing", async () => {
    const h = createHarness();
    await h.settle();
    const mnemonic = utf8ToBytes(MNEMONIC);
    const passphrase = new Uint8Array(mnemonic.buffer, 0, mnemonic.length);
    const response = await h.call("wallet.importMnemonic", {
      mnemonic,
      passphrase,
      factor: { kind: "password", password: utf8ToBytes(PASS) },
    });
    expect(errCode(response)).toBe("invalid-input");
    expect(mnemonic).toStrictEqual(utf8ToBytes(MNEMONIC));
    const image = await h.store.load();
    expect(image.records).toHaveLength(0);
    expect(image.factors).toHaveLength(0);
  });
});

describe("assertExclusiveSecrets", () => {
  const SHARED = "a secret field shares memory with another field";

  it("refuses a secret aliasing a public field anywhere in the params", () => {
    const bytes = utf8ToBytes("shared");
    expect(() =>
      assertExclusiveSecrets({
        outer: { inner: { password: bytes } },
        other: { nested: [{ field: bytes }] },
      }),
    ).toThrow(SHARED);
  });

  it("refuses an element of a secret array aliasing a public field", () => {
    const a = utf8ToBytes("one");
    const b = utf8ToBytes("two");
    expect(() => assertExclusiveSecrets({ answers: [a, b], field: b })).toThrow(SHARED);
  });

  it("refuses the same object reached twice under a secret key", () => {
    const shared = { password: utf8ToBytes("pw") };
    expect(() => assertExclusiveSecrets({ a: shared, b: shared })).toThrow(SHARED);
  });

  it("refuses the same bytes under two secret keys", () => {
    const bytes = utf8ToBytes("dual");
    expect(() => assertExclusiveSecrets({ password: bytes, prf: bytes })).toThrow(SHARED);
  });

  it("accepts disjoint views of one buffer, including abutting ranges", () => {
    const backing = new Uint8Array(32);
    expect(() =>
      assertExclusiveSecrets({ password: backing.subarray(0, 8), field: backing.subarray(8) }),
    ).not.toThrow();
    expect(() =>
      assertExclusiveSecrets({ password: backing.subarray(0, 8), field: backing.subarray(8, 8) }),
    ).not.toThrow();
  });

  it("accepts empty views inside a secret's range and empty secrets overlapping public bytes", () => {
    const backing = new Uint8Array(16);
    expect(() =>
      assertExclusiveSecrets({ password: backing.subarray(0, 8), field: backing.subarray(4, 4) }),
    ).not.toThrow();
    expect(() =>
      assertExclusiveSecrets({ password: backing.subarray(4, 4), field: backing.subarray(0, 8) }),
    ).not.toThrow();
  });

  it("accepts the same public bytes in two public fields", () => {
    const bytes = utf8ToBytes("public");
    expect(() => assertExclusiveSecrets({ first: bytes, second: bytes })).not.toThrow();
  });

  it("accepts unshared params", () => {
    expect(() =>
      assertExclusiveSecrets({
        request: { kind: "solana.message", message: utf8ToBytes("hello") },
        verify: { kind: "password", password: utf8ToBytes("pw") },
        answers: [utf8ToBytes("a"), utf8ToBytes("b")],
      }),
    ).not.toThrow();
  });

  // A request may carry six figures of byte leaves in one buffer: the check must stay linear so a
  // huge-but-legal request is not a kernel stall.
  const crowdedBlob = (backing: Uint8Array): Uint8Array[] => {
    const blob: Uint8Array[] = [];
    for (let i = 4; i < backing.length; i += 1) {
      blob.push(backing.subarray(i, i + 1));
    }
    return blob;
  };

  it("accepts 120 000 disjoint public views beside a secret view in one buffer", () => {
    const backing = new Uint8Array(120_004);
    const start = performance.now();
    assertExclusiveSecrets({ password: backing.subarray(0, 4), blob: crowdedBlob(backing) });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("refuses when one of 120 000 public views overlaps the secret", () => {
    const backing = new Uint8Array(120_004);
    const blob = crowdedBlob(backing);
    blob.push(backing.subarray(2, 4));
    const start = performance.now();
    expect(() => assertExclusiveSecrets({ password: backing.subarray(0, 4), blob })).toThrow(
      SHARED,
    );
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
