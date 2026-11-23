import { describe, expect, it } from "vite-plus/test";

import { createMemoryCloudStore } from "../src/backup/memory.ts";
import {
  CLOUD_NAME_MAX_LENGTH,
  CLOUD_TEXT_MAX_BYTES,
  CloudStoreError,
  checkCloudName,
  checkCloudText,
} from "../src/backup/port.ts";
import { describeCloudStore } from "./cloud/conformance.ts";

describeCloudStore("memory", () => ({ store: createMemoryCloudStore() }));

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("checkCloudName", () => {
  it("accepts the boundary names", () => {
    expect(() => checkCloudName("a")).not.toThrow();
    expect(() => checkCloudName("Z9.-_z")).not.toThrow();
    expect(() => checkCloudName("x".repeat(CLOUD_NAME_MAX_LENGTH))).not.toThrow();
    expect(() =>
      checkCloudName(`qntx-wallet-backup-${"a".repeat(32)}-${"b".repeat(64)}.json`),
    ).not.toThrow();
  });

  it.each([
    "",
    "x".repeat(256),
    ".x",
    "_x",
    "-x",
    "a/b",
    "a b",
    "a'b",
    "é",
    String.raw`a\b`,
    "a:b",
  ])("rejects %j", (name) => {
    const error = thrown(() => checkCloudName(name));
    expect(error).toBeInstanceOf(CloudStoreError);
    expect(error).toMatchObject({ code: "invalid" });
  });
});

describe("checkCloudText", () => {
  it("accepts text at the byte cap and arbitrary unicode", () => {
    expect(() => checkCloudText("")).not.toThrow();
    expect(() => checkCloudText("x".repeat(CLOUD_TEXT_MAX_BYTES))).not.toThrow();
    expect(() => checkCloudText("é𝄞🎉中文")).not.toThrow();
  });

  it("rejects text over the byte cap, counting UTF-8 bytes not chars", () => {
    const overCap = thrown(() => checkCloudText("x".repeat(CLOUD_TEXT_MAX_BYTES + 1)));
    expect(overCap).toBeInstanceOf(CloudStoreError);
    expect(overCap).toMatchObject({ code: "invalid" });
    // One 4-byte emoji can straddle the cap even though the char count is under it.
    const atCap = `${"x".repeat(CLOUD_TEXT_MAX_BYTES - 4)}🎉`;
    expect(() => checkCloudText(atCap)).not.toThrow();
    const pastCap = thrown(() => checkCloudText(`${atCap}x`));
    expect(pastCap).toBeInstanceOf(CloudStoreError);
    expect(pastCap).toMatchObject({ code: "invalid" });
  });

  it("rejects lone surrogates", () => {
    const high = thrown(() => checkCloudText("bad \uD800surrogate"));
    expect(high).toBeInstanceOf(CloudStoreError);
    expect(high).toMatchObject({ code: "invalid" });
    const low = thrown(() => checkCloudText("\uDC00tail"));
    expect(low).toBeInstanceOf(CloudStoreError);
    expect(low).toMatchObject({ code: "invalid" });
  });
});
