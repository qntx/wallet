import { cmac } from "@noble/ciphers/aes.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { accessHash } from "../src/modules/card/protocol/access.ts";
import type { Argon2Cost, Argon2id } from "../src/modules/card/protocol/access.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import {
  cardId,
  PRODUCTION_ANCHORS,
  shortId,
  verifyCertificate,
} from "../src/modules/card/protocol/identity.ts";
import type { Anchor } from "../src/modules/card/protocol/identity.ts";
import { kdf, m2, unM2 } from "../src/modules/card/protocol/kdf.ts";
import type {
  Argon2id as KernelArgon2id,
  SecureInputResult,
} from "../src/platform.ts";
import { loadVectors } from "./helpers.ts";

const hex = hexToBytes;

/** Runs `fn` and returns the CardError it threw, rethrowing anything else. */
function cardError(fn: () => unknown): CardErrorCode | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof CardError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

function requireCase<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("test vector missing");
  }
  return value;
}

type CertVectors = {
  cas: ReadonlyArray<{ name: string; private: string; public: string }>;
  identities: ReadonlyArray<{
    name: string;
    private: string;
    public: string;
    compressed: string;
    id: string;
    short: string;
  }>;
  verify: ReadonlyArray<{ name: string; anchor: string; cert: string; valid: boolean }>;
};

const cert = loadVectors("card/cert.json") as CertVectors;
const anchorOf = (batch: string, key: string): Anchor => ({ batch, key: hex(key) });

describe("card identity", () => {
  it.each(cert.identities)("$name computes ID and short ID", (v) => {
    expect(bytesToHex(cardId(hex(v.compressed)))).toBe(v.id);
    expect(shortId(hex(v.compressed))).toBe(v.short);
  });

  it("rejects a non-33-byte identity", () => {
    expect(cardError(() => cardId(new Uint8Array(32)))).toBe("invalid-input");
  });
});

describe("verifyCertificate", () => {
  const anchors = cert.cas.map((ca) => anchorOf(ca.name, ca.public));
  const ca1 = requireCase(cert.cas[0]);
  const batchOf = (publicKey: string): string =>
    cert.cas.find((ca) => ca.public === publicKey)?.name ?? "test";
  const validCerts = cert.verify.filter((c) => c.valid);
  const invalidCerts = cert.verify.filter((c) => !c.valid);

  it.each(validCerts)("$name", (v) => {
    const result = verifyCertificate(hex(v.cert), [anchorOf(batchOf(v.anchor), v.anchor)]);
    expect(bytesToHex(result.identity)).toBe(v.cert.slice(0, 66));
    expect(result.batch).toBe(batchOf(v.anchor));
  });

  it.each(invalidCerts)("$name fails under the anchor it names", (v) => {
    expect(cardError(() => verifyCertificate(hex(v.cert), [anchorOf("x", v.anchor)]))).toBe(
      "card-not-genuine",
    );
  });

  // every malformed signature fails under every CA; "wrong-anchor" is a genuine ca1
  // certificate presented to the wrong anchor, so it still verifies under ca1
  it.each(invalidCerts.filter((c) => c.name !== "wrong-anchor"))(
    "$name fails under every CA",
    (v) => {
      expect(cardError(() => verifyCertificate(hex(v.cert), anchors))).toBe("card-not-genuine");
    },
  );

  it("wrong-anchor verifies under the real signer", () => {
    const v = requireCase(cert.verify.find((c) => c.name === "wrong-anchor"));
    expect(verifyCertificate(hex(v.cert), anchors).batch).toBe("ca1");
  });

  it("finds the matching anchor among several", () => {
    const v = requireCase(cert.verify.find((c) => c.name === "card2-under-ca1"));
    const ca2 = requireCase(cert.cas.find((ca) => ca.name === "ca2"));
    const reversed = [anchorOf("ca2", ca2.public), anchorOf("ca1", v.anchor)];
    expect(verifyCertificate(hex(v.cert), reversed).batch).toBe("ca1");
  });

  it("rejects when anchors are empty (PRODUCTION_ANCHORS)", () => {
    expect(PRODUCTION_ANCHORS).toHaveLength(0);
    const v = requireCase(validCerts[0]);
    expect(cardError(() => verifyCertificate(hex(v.cert), PRODUCTION_ANCHORS))).toBe(
      "card-not-genuine",
    );
  });

  it("rejects a malformed certificate length", () => {
    const v = requireCase(validCerts[0]);
    expect(cardError(() => verifyCertificate(hex(v.cert).subarray(0, 96), anchors))).toBe(
      "card-not-genuine",
    );
  });

  it("rejects a certificate whose subject is not a compressed point", () => {
    // oracle open.rejected `certificate-key-not-a-point`: `02 ‖ 0³²` signed by ca1 — the
    // signature verifies, but the subject is not a point and must fail first
    const v = requireCase(open.rejected.find((r) => r.name === "certificate-key-not-a-point"));
    const certBytes = hex(v.response).subarray(129, 226);
    expect(cardError(() => verifyCertificate(certBytes, anchors))).toBe("card-not-genuine");
  });

  it.each([
    ["short", hex("04326ee5")],
    ["compressed-prefix", hex(ca1.public).slice(0, 33)],
    [
      "compressed-point",
      hex(requireCase(cert.identities.find((i) => i.compressed !== "")).compressed),
    ],
    ["zero-point", hex("04".concat("00".repeat(64)))],
  ])("rejects an invalid anchor key (%s)", (_name, key) => {
    const v = requireCase(validCerts[0]);
    expect(
      cardError(() => verifyCertificate(hex(v.cert), [anchorOf("bad", bytesToHex(key))])),
    ).toBe("invalid-input");
  });
});

describe("KDF (SP 800-56C one-step)", () => {
  const { cmac: cmacVectors, kdf: kdfVectors } = loadVectors("card/kdf.json") as {
    cmac: ReadonlyArray<{ key: string; message: string; tag: string }>;
    kdf: ReadonlyArray<{ z: string; label: string; ctx: string; len: number; out: string }>;
    kdf108: unknown;
  };

  it.each(cmacVectors)("CMAC vector $key / $message", (v) => {
    expect(bytesToHex(cmac(hex(v.message), hex(v.key)))).toBe(v.tag);
  });

  it.each(kdfVectors)("KDF vector $z", (v) => {
    expect(bytesToHex(kdf(hex(v.z), hex(v.label), hex(v.ctx), v.len))).toBe(v.out);
  });

  it.each([0, 65, -1])("rejects output length %s", (len) => {
    expect(
      cardError(() => kdf(new Uint8Array(32), new Uint8Array(0), new Uint8Array(0), len)),
    ).toBe("invalid-input");
  });
});

describe("M2 padding", () => {
  it.each([
    [0, 16],
    [1, 16],
    [15, 16],
    [16, 32],
    [31, 32],
    [239, 240],
  ])("pads %d bytes to %d", (len, expected) => {
    const data = new Uint8Array(len).fill(0x41);
    const padded = m2(data);
    expect(padded).toHaveLength(expected);
    expect(padded[len]).toBe(0x80);
    expect([...padded.subarray(len + 1)].every((b) => b === 0)).toBe(true);
    expect(unM2(padded)).toStrictEqual(data);
  });

  it("unpads a block containing only the marker", () => {
    expect(unM2(m2(new Uint8Array(0)))).toStrictEqual(new Uint8Array(0));
  });

  const badPadding = (lastNonZero: number, zeros: number): Uint8Array => {
    const b = new Uint8Array(Math.ceil((lastNonZero + 1 + zeros) / 16) * 16);
    b[lastNonZero] = 0x80;
    return b;
  };

  it.each([
    ["empty", new Uint8Array(0)],
    ["not-block-aligned", new Uint8Array(17)],
    ["all-zero", new Uint8Array(16)],
    [
      "wrong-marker",
      (() => {
        const b = new Uint8Array(16);
        b[0] = 0x81;
        return b;
      })(),
    ],
    ["overlong-padding", badPadding(0, 16)],
    ["sub-block marker", hex("80")],
    ["sub-block data", hex("0080")],
  ])("rejects %s", (_name, input) => {
    expect(unM2(input)).toBeUndefined();
  });
});

type AccessVectors = {
  accepted: ReadonlyArray<{ code: string; cardId: string; salt: string; accessHash: string }>;
  rejected: ReadonlyArray<{ name: string; code: string }>;
};

const { access, open } = loadVectors("card/oracle.json") as {
  access: AccessVectors;
  open: { rejected: ReadonlyArray<{ name: string; response: string }> };
};
const firstAccepted = requireCase(access.accepted[0]);
const realCostAccepted = requireCase(access.accepted[2]);

describe("accessHash", () => {
  it.each(access.rejected)("rejects $name without calling Argon2id", async (v) => {
    let called = 0;
    const spy: Argon2id = async () => {
      called += 1;
      return Promise.resolve(new Uint8Array(32));
    };
    await expect(accessHash(utf8ToBytes(v.code), hex(firstAccepted.cardId), spy)).rejects.toThrow(
      CardError,
    );
    await expect(
      accessHash(utf8ToBytes(v.code), hex(firstAccepted.cardId), spy),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(called).toBe(0);
  });

  it("rejects a wrong-length cardId without calling Argon2id", async () => {
    const spy: Argon2id = async () => Promise.resolve(new Uint8Array(32));
    await expect(
      accessHash(utf8ToBytes("123456"), new Uint8Array(15), spy),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("rejects and wipes a wrong-length Argon2id output", async () => {
    const bad = new Uint8Array(31).fill(0x7a);
    const spy: Argon2id = async () => Promise.resolve(bad);
    await expect(
      accessHash(utf8ToBytes("123456"), hex(firstAccepted.cardId), spy),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect([...bad].every((b) => b === 0)).toBe(true);
  });

  const spyOn = () => {
    const seen: {
      password?: Uint8Array;
      buffer?: Uint8Array;
      salt?: Uint8Array;
      cost?: Argon2Cost;
      length?: number;
    } = {};
    const spy: Argon2id = async (password, salt, cost, length) => {
      seen.password = new Uint8Array(password); // snapshot; the live buffer is wiped on resolve
      seen.buffer = password;
      seen.salt = salt;
      seen.cost = cost;
      seen.length = length;
      return Promise.resolve(new Uint8Array(32).fill(0x5a));
    };
    return { seen, spy };
  };

  const hexOf = (b: Uint8Array | undefined): string =>
    b === undefined ? "<unset>" : bytesToHex(b);
  const allZero = (b: Uint8Array | undefined): boolean =>
    b !== undefined && [...b].every((x) => x === 0);

  it.each(access.accepted)("asks Argon2id for $code and wipes the password", async (v) => {
    const { seen, spy } = spyOn();
    const result = await accessHash(utf8ToBytes(v.code), hex(v.cardId), spy);
    expect([...result].every((b) => b === 0x5a)).toBe(true);
    expect(hexOf(seen.salt)).toBe(v.salt);
    expect(seen.password).toStrictEqual(utf8ToBytes(v.code));
    expect(seen.cost).toStrictEqual({ memoryKiB: 65_536, passes: 3, lanes: 4 });
    expect(seen).toHaveLength(32);
    expect(allZero(seen.buffer)).toBe(true);
  });

  it("matches the argon2-cffi oracle at the real cost", { timeout: 30_000 }, async () => {
    const v = realCostAccepted;
    const result = await accessHash(
      utf8ToBytes(realCostAccepted.code),
      hex(realCostAccepted.cardId),
      async (password, salt, cost, length) =>
        Promise.resolve(
          argon2id(password, salt, {
            m: cost.memoryKiB,
            t: cost.passes,
            p: cost.lanes,
            dkLen: length,
          }),
        ),
    );
    expect(bytesToHex(result)).toBe(v.accessHash);
  });

  it("hashes the SecureInputResult value bytes without touching the caller's buffer", {
    timeout: 30_000,
  }, async () => {
    const v = realCostAccepted;
    const input: SecureInputResult = { ok: true, value: utf8ToBytes(v.code) };
    if (!input.ok) {
      throw new Error("unreachable");
    }
    let password: Uint8Array | undefined;
    const real: Argon2id = (p, salt, cost, length) => {
      password = p;
      return Promise.resolve(
        argon2id(p, salt, { m: cost.memoryKiB, t: cost.passes, p: cost.lanes, dkLen: length }),
      );
    };
    const result = await accessHash(input.value, hex(v.cardId), real);
    expect(bytesToHex(result)).toBe(v.accessHash);
    expect(bytesToHex(input.value)).toBe(bytesToHex(utf8ToBytes(v.code)));
    expect(password !== undefined && [...password].every((b) => b === 0)).toBe(true);
  });

  it("accepts the kernel's Argon2id type", () => {
    const kernelArgon2id: KernelArgon2id = async () => Promise.resolve(new Uint8Array(32));
    const protocolArgon2id: Argon2id = kernelArgon2id;
    expect(protocolArgon2id).toBe(kernelArgon2id);
  });
});
