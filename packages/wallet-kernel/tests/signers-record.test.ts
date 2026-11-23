/**
 * The `hardware-wallet` record codec: header and body round trips, every malformed-input rejection,
 * and the wallet id formula recomputed independently from the literal domain prefix.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { KernelError } from "../src/errors.ts";
import type { PinnedKeys } from "../src/modules/signers/driver.ts";
import {
  encodeHardwareBody,
  encodeHardwareHeader,
  hardwareWalletId,
  parseHardwareBody,
  parseHardwareHeader,
  pathFromString,
  pathToString,
} from "../src/modules/signers/record.ts";
import type { HardwareHeader } from "../src/modules/signers/record.ts";

const HARDENED = 0x80000000;
const FINGERPRINT = hexToBytes("a1b2c3d4");
// A valid secp256k1 compressed key and its chain code for body fixtures.
const POINT = secp256k1.getPublicKey(new Uint8Array(32).fill(7), true);
const CHAIN = new Uint8Array(32).fill(9);
const ED_POINT = ed25519.getPublicKey(new Uint8Array(32).fill(11));

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no-throw";
  } catch (error) {
    return error instanceof KernelError ? error.code : "not-a-kernel-error";
  }
};

const header: HardwareHeader = {
  device: "keystone",
  fingerprint: FINGERPRINT,
  model: "Keystone 3 Pro",
  firmware: "3.2.2",
  createdAt: 1_700_000_000_000,
};

const bodyKeys: PinnedKeys = {
  nodes: [
    {
      path: [44 + HARDENED, 60 + HARDENED, HARDENED],
      publicKey: POINT,
      chainCode: CHAIN,
      parent: FINGERPRINT,
    },
    { path: [84 + HARDENED, HARDENED, HARDENED], publicKey: POINT, chainCode: CHAIN },
  ],
  ed25519: [{ path: [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED], publicKey: ED_POINT }],
};

describe("hardware-wallet header codec", () => {
  it("round-trips with and without the optional strings", () => {
    expect(parseHardwareHeader(encodeHardwareHeader(header))).toStrictEqual(header);
    const minimal: HardwareHeader = {
      device: "keystone",
      fingerprint: FINGERPRINT,
      createdAt: 5,
    };
    expect(parseHardwareHeader(encodeHardwareHeader(minimal))).toStrictEqual(minimal);
  });

  it("rejects a bad device, a bad fingerprint and missing or extra keys", () => {
    const base = { device: "keystone", fingerprint: "a1b2c3d4", createdAt: 1 };
    for (const text of [
      JSON.stringify({ ...base, device: "ledger" }),
      JSON.stringify({ ...base, device: 1 }),
      JSON.stringify({ ...base, fingerprint: "a1b2c3" }),
      JSON.stringify({ ...base, fingerprint: "A1B2C3D4" }),
      JSON.stringify({ ...base, fingerprint: "zzzzzzzz" }),
      JSON.stringify({ ...base, fingerprint: [1, 2, 3, 4] }),
      JSON.stringify({ device: "keystone", fingerprint: "a1b2c3d4" }),
      JSON.stringify({ ...base, extra: 1 }),
      "not json",
      JSON.stringify(["keystone", "a1b2c3d4"]),
    ]) {
      expect(code(() => parseHardwareHeader(text))).toBe("integrity");
    }
  });

  it("rejects a model or firmware string outside printable ASCII 64", () => {
    const base = { device: "keystone", fingerprint: "a1b2c3d4", createdAt: 1 };
    expect(code(() => parseHardwareHeader(JSON.stringify({ ...base, model: "Keystone\n3" })))).toBe(
      "integrity",
    );
    expect(
      code(() => parseHardwareHeader(JSON.stringify({ ...base, firmware: "x".repeat(65) }))),
    ).toBe("integrity");
  });
});

describe("hardware-wallet body codec", () => {
  it("round-trips nodes, parents and ed25519 entries", () => {
    expect(parseHardwareBody(encodeHardwareBody(bodyKeys))).toStrictEqual(bodyKeys);
    expect(parseHardwareBody(encodeHardwareBody({ nodes: [], ed25519: [] }))).toStrictEqual({
      nodes: [],
      ed25519: [],
    });
  });

  const body = (value: unknown): Uint8Array => utf8ToBytes(JSON.stringify(value));
  const nodeEntry = (extra?: Record<string, unknown>) => ({
    key: bytesToHex(POINT),
    chainCode: bytesToHex(CHAIN),
    ...extra,
  });

  it("rejects missing or extra top-level keys and non-JSON input", () => {
    expect(code(() => parseHardwareBody(utf8ToBytes("not json")))).toBe("integrity");
    expect(code(() => parseHardwareBody(new Uint8Array([0xff, 0xfe])))).toBe("integrity");
    expect(code(() => parseHardwareBody(body({ nodes: {} })))).toBe("integrity");
    expect(code(() => parseHardwareBody(body({ nodes: {}, ed25519: {}, extra: 1 })))).toBe(
      "integrity",
    );
    expect(code(() => parseHardwareBody(body({ nodes: [], ed25519: {} })))).toBe("integrity");
  });

  it("rejects bad hex, wrong lengths and non-point public keys", () => {
    const nodes = (entry: unknown) => body({ nodes: { "m/44'/60'/0'": entry }, ed25519: {} });
    expect(code(() => parseHardwareBody(nodes({ key: "zz", chainCode: bytesToHex(CHAIN) })))).toBe(
      "integrity",
    );
    expect(
      code(() => parseHardwareBody(nodes({ key: bytesToHex(POINT), chainCode: "aabb" }))),
    ).toBe("integrity");
    expect(
      code(() =>
        parseHardwareBody(nodes({ key: bytesToHex(POINT.subarray(0, 32)), chainCode: "aa" })),
      ),
    ).toBe("integrity");
    // x = 2^256 - 1 ≥ p is not a curve point.
    expect(
      code(() => parseHardwareBody(nodes({ key: "ff".repeat(33), chainCode: bytesToHex(CHAIN) }))),
    ).toBe("integrity");
    expect(
      code(() =>
        parseHardwareBody(
          nodes({ key: bytesToHex(POINT), chainCode: bytesToHex(CHAIN), extra: 1 }),
        ),
      ),
    ).toBe("integrity");
    expect(code(() => parseHardwareBody(nodes({ key: bytesToHex(POINT), parent: "aabb" })))).toBe(
      "integrity",
    );
    // Not a valid ed25519 point encoding.
    expect(
      code(() =>
        parseHardwareBody(body({ nodes: {}, ed25519: { "m/44'/501'/0'/0'": "02".repeat(32) } })),
      ),
    ).toBe("integrity");
    expect(
      code(() => parseHardwareBody(body({ nodes: {}, ed25519: { "m/44'/501'/0'/0'": "aa" } }))),
    ).toBe("integrity");
    // A non-hardened segment in an ed25519 path — SLIP-10 pins hardened leaves only.
    expect(
      code(() =>
        parseHardwareBody(
          body({ nodes: {}, ed25519: { "m/44'/501'/0'/0": bytesToHex(ED_POINT) } }),
        ),
      ),
    ).toBe("integrity");
  });

  it("rejects depth 0 and 11, an index past 2^31 and non-canonical paths", () => {
    const ed = bytesToHex(ED_POINT);
    const withPath = (path: string) => body({ nodes: {}, ed25519: { [path]: ed } });
    for (const path of [
      "m",
      "m/1/2/3/4/5/6/7/8/9/10/11",
      "m/2147483648'",
      "m/01'",
      "M/44'/501'/0'/0'",
      "m/44//501'",
      "m/44'/501'/0'/0' ",
    ]) {
      expect(code(() => parseHardwareBody(withPath(path)))).toBe("integrity");
    }
  });

  it("rejects depth 0 and 11 node paths", () => {
    for (const path of ["m", "m/1/2/3/4/5/6/7/8/9/10/11"]) {
      expect(
        code(() => parseHardwareBody(body({ nodes: { [path]: nodeEntry() }, ed25519: {} }))),
      ).toBe("integrity");
    }
  });

  it("rejects more than 512 nodes or 256 ed25519 entries", () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 513; i++) {
      nodes[`m/0/${i}`] = nodeEntry();
    }
    expect(code(() => parseHardwareBody(body({ nodes, ed25519: {} })))).toBe("integrity");
    const ed: Record<string, string> = {};
    for (let i = 0; i < 257; i++) {
      ed[`m/${i}'`] = bytesToHex(ED_POINT);
    }
    expect(code(() => parseHardwareBody(body({ nodes: {}, ed25519: ed })))).toBe("integrity");
  });
});

describe("path strings", () => {
  it("round-trips canonical m/… paths", () => {
    for (const path of ["m/0", "m/44'/60'/0'", "m/0/1/2/3/4/5/6/7/8/9", "m/2147483647'"]) {
      expect(pathToString(pathFromString(path))).toBe(path);
    }
    expect(pathToString([44 + HARDENED, 60 + HARDENED, HARDENED])).toBe("m/44'/60'/0'");
    expect(pathToString([])).toBe("m");
  });
});

describe("hardwareWalletId", () => {
  it("matches the independent sha256 formula with the literal prefix", () => {
    const expected = bytesToHex(
      sha256(
        concatBytes(
          utf8ToBytes("qntx-wallet/hardware-wallet-id/v1"),
          utf8ToBytes("keystone"),
          new Uint8Array([0]),
          FINGERPRINT,
        ),
      ).subarray(0, 8),
    );
    expect(hardwareWalletId("keystone", FINGERPRINT)).toBe(expected);
    // The formula is domain-separated: a different fingerprint lands nowhere near it.
    expect(hardwareWalletId("keystone", hexToBytes("00112233"))).not.toBe(expected);
  });
});
