import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import {
  displayExcerpt,
  isBlindIntent,
  isHexRendering,
  isReadableText,
  isUnsafeCodePoint,
  messageBlindReason,
  messageContent,
} from "../src/index.ts";
import type { DisplayIntent } from "../src/index.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf8s = new TextDecoder("utf-8", { fatal: true });

describe("displayExcerpt", () => {
  it("replaces characters that hide or reorder text", () => {
    const { lines, omitted } = displayExcerpt("pay \u202Eecila\u202C\u200B to\tbob\u0007", 4, 100);
    expect(lines).toStrictEqual(["pay \uFFFDecila\uFFFD\uFFFD to bob\uFFFD"]);
    expect(omitted).toBe(0);
  });

  it("drops empty lines so padding cannot push content out of view", () => {
    const padded = `first${"\n".repeat(50)}\r\n \u2028second\u2029third`;
    expect(displayExcerpt(padded, 3, 100).lines).toStrictEqual(["first", "second", "third"]);
  });

  it("stops at the line limit and counts what it left out", () => {
    expect(displayExcerpt("a\nbb\nccc\ndddd", 2, 100)).toStrictEqual({
      lines: ["a", "bb"],
      omitted: 7,
    });
  });

  it("cuts the last line at the code-point limit", () => {
    expect(displayExcerpt("abcdef\nghi", 4, 4)).toStrictEqual({ lines: ["abcd"], omitted: 5 });
  });

  it("counts an astral character once", () => {
    expect(displayExcerpt("😀😀😀", 1, 2)).toStrictEqual({ lines: ["😀😀"], omitted: 1 });
  });

  it("flags tag and soft-hyphen characters", () => {
    expect([0xe0041, 0x00ad, 0x180e, 0x2028].every(isUnsafeCodePoint)).toBe(true);
    expect([0x20, 0x41, 0x4e2d, 0x1f600].some(isUnsafeCodePoint)).toBe(false);
  });
});

describe("messageContent", () => {
  const siwe = [
    "example.com wants you to sign in with your Ethereum account:",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: 12345678",
    "Issued At: 2026-01-01T00:00:00Z",
  ].join("\n");

  it("recognises a sign-in message for its own family only", () => {
    expect(messageContent(utf8(siwe), "evm")).toMatchObject({
      kind: "text",
      signIn: { status: "valid", fields: { domain: "example.com" } },
    });
    expect(messageContent(utf8(siwe), "solana")).toMatchObject({
      kind: "text",
      signIn: { status: "malformed" },
    });
  });

  it("keeps plain text and falls back to hex for invalid UTF-8", () => {
    expect(messageContent(utf8("hello"), "evm")).toStrictEqual({ kind: "text", text: "hello" });
    expect(messageContent(new Uint8Array([0xff, 0x00]), "solana")).toStrictEqual({
      kind: "bytes",
      hex: "0xff00",
    });
  });
});

describe("isBlindIntent", () => {
  it("is blind iff the decoder set a blind reason", () => {
    expect(isBlindIntent({})).toBe(false);
    expect(isBlindIntent({ blind: "message-bytes" })).toBe(true);
    for (const blind of [
      "typed-data-oversize",
      "token-function",
      "account-code",
      "safe-delegatecall",
      "safe-refund-unbounded",
    ] as const) {
      expect(isBlindIntent({ blind })).toBe(true);
    }
  });

  it("an unverifiable request is not blind unless the decoder says so", () => {
    const opaque: DisplayIntent = {
      family: "evm",
      network: "eip155:1",
      summary: "contract-call",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      verifiability: "opaque",
    };
    expect(isBlindIntent(opaque)).toBe(false);
    expect(isBlindIntent({ ...opaque, blind: "account-code" })).toBe(true);
  });
});

describe("messageBlindReason", () => {
  it("raw bytes are blind; text and typed data are not", () => {
    expect(messageBlindReason({ kind: "bytes", hex: "0xff" })).toBe("message-bytes");
    expect(messageBlindReason({ kind: "text", text: "hi" })).toBeUndefined();
    expect(
      messageBlindReason({
        kind: "typed-data",
        primaryType: "Order",
        domain: {},
        data: {},
      }),
    ).toBeUndefined();
  });
});

describe("isHexRendering", () => {
  it("is true for the hex of at least 32 bytes, with or without the prefix", () => {
    expect(isHexRendering(`0x${"ab".repeat(32)}`)).toBe(true);
    expect(isHexRendering("ab".repeat(32))).toBe(true);
    expect(isHexRendering(`0x${"AB".repeat(33)}`)).toBe(true);
    expect(isHexRendering(`  0x${"cd".repeat(32)}  `)).toBe(true);
  });

  it("is false below 32 bytes, on odd lengths and on non-hex text", () => {
    expect(isHexRendering(`0x${"ab".repeat(31)}`)).toBe(false);
    expect(isHexRendering(`0x${"ab".repeat(32)}0`)).toBe(false);
    expect(isHexRendering(`0x${"gh".repeat(32)}`)).toBe(false);
    expect(isHexRendering("hello")).toBe(false);
    expect(isHexRendering("0x")).toBe(false);
  });
});

describe("isReadableText", () => {
  it("ordinary text and the permitted whitespace pass", () => {
    expect(isReadableText("hello world")).toBe(true);
    expect(isReadableText("a\tb\nc\rd\r\ne")).toBe(true);
    expect(isReadableText("héllo wörld 你好")).toBe(true);
  });

  it.each([
    ["NUL", "\u0000"],
    ["bell", "\u0007"],
    ["escape", "\u001B"],
    ["bidi override", "\u202E"],
    ["zero-width space", "\u200B"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["tag character", "\uDB40\uDC61"],
    ["vertical tab", "\u000B"],
    ["form feed", "\u000C"],
    ["backspace", "\u0008"],
    ["delete", "\u007F"],
  ])("text containing %s is not readable", (_name, char) => {
    expect(isReadableText(`see ${char} this`)).toBe(false);
  });
});

describe("digest-shaped and hostile message content", () => {
  it("a message of exactly 32 bytes is bytes even when it is valid UTF-8", () => {
    const text32 = utf8("a".repeat(32));
    expect(text32).toHaveLength(32);
    expect(messageContent(text32, "evm")).toStrictEqual({
      kind: "bytes",
      hex: `0x${"61".repeat(32)}`,
    });
    for (const n of [31, 33]) {
      expect(messageContent(utf8("a".repeat(n)), "evm")).toStrictEqual({
        kind: "text",
        text: "a".repeat(n),
      });
    }
    /* The ground digest: a keccak output that happens to be valid UTF-8. */
    const digest = hexToBytes("5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79");
    expect(() => utf8s.decode(digest)).not.toThrow();
    expect(messageContent(digest, "evm").kind).toBe("bytes");
  });

  it("text with an unsafe code point is bytes", () => {
    for (const char of ["\u0000", "\u202E", "\u200B"]) {
      expect(messageContent(utf8(`see ${char} this`), "evm").kind).toBe("bytes");
    }
  });

  it("the permitted whitespace stays text", () => {
    const text = "line one\nline two\r\n\tindented";
    expect(messageContent(utf8(text), "solana")).toStrictEqual({ kind: "text", text });
  });

  it("hex-rendered text is text but blind; shorter hex is not", () => {
    for (const text of [
      `0x${"ab".repeat(32)}`,
      "ab".repeat(32),
      `0X${"AB".repeat(32)}`.replace("0X", "0x"),
    ]) {
      const content = messageContent(utf8(text), "evm");
      expect(content.kind).toBe("text");
      expect(messageBlindReason(content)).toBe("message-bytes");
    }
    expect(messageBlindReason(messageContent(utf8(`0x${"ab".repeat(31)}`), "evm"))).toBeUndefined();
  });

  it("hand-built text content gets the same verdict", () => {
    expect(messageBlindReason({ kind: "text", text: "a".repeat(32) })).toBe("message-bytes");
    expect(messageBlindReason({ kind: "text", text: "see \u0000 this" })).toBe("message-bytes");
    expect(messageBlindReason({ kind: "text", text: "see \t this" })).toBeUndefined();
  });
});
