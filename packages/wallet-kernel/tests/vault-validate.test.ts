/**
 * `assertVaultImage` is the fail-closed shape check every untrusted store read goes through: a
 * valid image passes; every bound, type and key constraint throws KernelError "integrity" and a
 * foreign `meta.format` throws "unsupported".
 */
import { describe, expect, it } from "vite-plus/test";

import type { KernelError } from "../src/errors.ts";
import { UnsupportedFormatError } from "../src/errors.ts";
import { VAULT_FORMAT } from "../src/vault/store.ts";
import { assertVaultImage } from "../src/vault/validate.ts";

const HEX = "ab".repeat(16);
const sealed = new Uint8Array(32);

const validRecord = () => ({ kind: "entropy", id: "rec", header: "{}", sealed });
const validFactor = () => ({ kind: "password", id: HEX, header: "{}", sealed });
const validImage = () => ({
  meta: {
    format: VAULT_FORMAT,
    keyId: HEX,
    revision: 1,
  },
  records: [validRecord()],
  factors: [validFactor()],
});

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no-throw";
  } catch (error) {
    return (error as KernelError).code;
  }
};

const formatFailure = (format: number): { code: string; reason: string | undefined } => {
  try {
    assertVaultImage({ ...validImage(), meta: { ...validImage().meta, format } });
    return { code: "no-throw", reason: undefined };
  } catch (error) {
    return {
      code: (error as KernelError).code,
      reason: error instanceof UnsupportedFormatError ? error.reason : undefined,
    };
  }
};

describe("assertVaultImage", () => {
  it("accepts the same record id under different kinds", () => {
    expect(
      assertVaultImage({
        ...validImage(),
        records: [validRecord(), { ...validRecord(), kind: "data-key" }],
      }),
    ).toBeDefined();
  });

  it("returns a valid image; meta may be absent or null", () => {
    expect(assertVaultImage(validImage())).toBeDefined();
    const noMeta = validImage() as Record<string, unknown>;
    noMeta["meta"] = null;
    expect(assertVaultImage(noMeta)).toBeDefined();
  });

  it.each([
    ["not an object", () => assertVaultImage("x")],
    ["a class instance", () => assertVaultImage(new (class {})())],
    ["extra top-level key", () => assertVaultImage({ ...validImage(), extra: 1 })],
    ["missing top-level key", () => assertVaultImage({ meta: validImage().meta, records: [] })],
    [
      "non-integer meta.format",
      () => assertVaultImage({ ...validImage(), meta: { ...validImage().meta, format: "2" } }),
    ],
    [
      "meta extra key",
      () => assertVaultImage({ ...validImage(), meta: { ...validImage().meta, extra: 1 } }),
    ],
    [
      "meta keyId not 32-hex",
      () => assertVaultImage({ ...validImage(), meta: { ...validImage().meta, keyId: "AB" } }),
    ],
    [
      "meta revision < 1",
      () => assertVaultImage({ ...validImage(), meta: { ...validImage().meta, revision: 0 } }),
    ],
    [
      "meta carries a dropped counter field",
      () =>
        assertVaultImage({
          ...validImage(),
          meta: { ...validImage().meta, failedAttempts: 0, lastFailureAt: 0 },
        }),
    ],
    ["records not array", () => assertVaultImage({ ...validImage(), records: {} })],
    [
      "duplicate record kind+id",
      () => assertVaultImage({ ...validImage(), records: [validRecord(), validRecord()] }),
    ],
    [
      "duplicate factor id",
      () =>
        assertVaultImage({
          ...validImage(),
          factors: [validFactor(), { ...validFactor(), kind: "passkey" }],
        }),
    ],
    [
      "record extra key",
      () => assertVaultImage({ ...validImage(), records: [{ ...validRecord(), extra: 1 }] }),
    ],
    [
      "record bad kind",
      () =>
        assertVaultImage({ ...validImage(), records: [{ ...validRecord(), kind: "Bad-Kind" }] }),
    ],
    [
      "record id too long",
      () =>
        assertVaultImage({ ...validImage(), records: [{ ...validRecord(), id: "x".repeat(129) }] }),
    ],
    [
      "record header too long",
      () =>
        assertVaultImage({
          ...validImage(),
          records: [{ ...validRecord(), header: "x".repeat(4097) }],
        }),
    ],
    [
      "record sealed too small",
      () =>
        assertVaultImage({
          ...validImage(),
          records: [{ ...validRecord(), sealed: new Uint8Array(15) }],
        }),
    ],
    [
      "record sealed too big",
      () =>
        assertVaultImage({
          ...validImage(),
          records: [{ ...validRecord(), sealed: new Uint8Array(8193) }],
        }),
    ],
    [
      "record sealed not bytes",
      () =>
        assertVaultImage({
          ...validImage(),
          records: [{ ...validRecord(), sealed: "x".repeat(32) }],
        }),
    ],
    [
      "factor id not 32-hex",
      () => assertVaultImage({ ...validImage(), factors: [{ ...validFactor(), id: "rec" }] }),
    ],
    [
      "factor bad kind",
      () => assertVaultImage({ ...validImage(), factors: [{ ...validFactor(), kind: "UPPER" }] }),
    ],
  ])("rejects %s with integrity", (_name, fn) => {
    expect(code(fn)).toBe("integrity");
  });

  it("rejects over-limit row counts with integrity", () => {
    const many = Array.from({ length: 4097 }, () => validRecord());
    expect(code(() => assertVaultImage({ ...validImage(), records: many }))).toBe("integrity");
    const manyFactors = Array.from({ length: 4097 }, () => validFactor());
    expect(code(() => assertVaultImage({ ...validImage(), factors: manyFactors }))).toBe(
      "integrity",
    );
  });

  // Below VAULT_FORMAT is a pre-1.0 build's image, above it a newer build's; a non-integer
  // format is integrity, never unsupported.
  it.each([
    { format: 3, code: "unsupported", reason: "older" },
    { format: VAULT_FORMAT - 1, code: "unsupported", reason: "older" },
    { format: VAULT_FORMAT + 1, code: "unsupported", reason: "newer" },
    { format: Number.MAX_SAFE_INTEGER, code: "unsupported", reason: "newer" },
    { format: 1.5, code: "integrity", reason: undefined },
  ])("meta.format $format is $code/$reason", ({ format, code: wanted, reason }) => {
    expect(formatFailure(format)).toStrictEqual({ code: wanted, reason });
  });
});
