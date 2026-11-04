import { createSignInMessageText } from "@solana/wallet-standard-util";
import { describe, expect, it } from "vite-plus/test";

import { checkSignInInput, signInMessageText } from "../src/connect/siws.ts";
import type { SignInFields } from "../src/connect/siws.ts";
import { BLIND_SIGNING_MESSAGE, utf8Text } from "../src/connect/text.ts";

const BASE = { domain: "app.example", address: "So1anaAddress11111111111111111111111111111" };
const ALL: SignInFields = {
  ...BASE,
  statement: "Sign in to the app. Second sentence.",
  uri: "https://app.example/login",
  version: "1",
  chainId: "mainnet",
  nonce: "abc123",
  issuedAt: "2026-11-04T00:00:00.000Z",
  expirationTime: "2026-11-05T00:00:00.000Z",
  notBefore: "2026-11-04T00:00:00.000Z",
  requestId: "req-1",
  resources: ["https://a.example", "ipfs://b"],
};

const MATRIX: ReadonlyArray<readonly [string, SignInFields]> = [
  ["all fields", ALL],
  ["minimal", BASE],
  ["statement only", { ...BASE, statement: "Hello" }],
  ["empty statement", { ...BASE, statement: "" }],
  ["resources only", { ...BASE, resources: ["https://a.example"] }],
  ["empty resources", { ...BASE, resources: [] }],
  ["no statement but fields", { ...BASE, uri: "https://app.example", nonce: "n" }],
  ["statement and one field", { ...BASE, statement: "Hi", version: "1" }],
  ["fields without statement and with resources", { ...BASE, chainId: "devnet", resources: ["x"] }],
  ["empty optional strings", { ...BASE, uri: "", nonce: "", requestId: "" }],
  ["expiry window only", { ...BASE, expirationTime: "e", notBefore: "b", issuedAt: "i" }],
];

describe("signInMessageText", () => {
  it.each(MATRIX)("matches @solana/wallet-standard-util 1.2.0 for %s", (_name, fields) => {
    expect(signInMessageText(fields)).toBe(createSignInMessageText(fields));
  });
});

describe("checkSignInInput", () => {
  it("passes a full valid input through unchanged", () => {
    expect(checkSignInInput(ALL)).toStrictEqual(ALL);
  });

  it("ignores unknown keys", () => {
    expect(checkSignInInput({ nonce: "n", extra: "x" })).toStrictEqual({ nonce: "n" });
  });

  it("accepts the length caps exactly", () => {
    expect(checkSignInInput({ statement: "s".repeat(1024) }).statement).toHaveLength(1024);
    expect(checkSignInInput({ nonce: "n".repeat(256) }).nonce).toHaveLength(256);
    expect(
      checkSignInInput({ resources: Array.from({ length: 32 }, () => "r") }).resources,
    ).toHaveLength(32);
  });

  it("rejects a line break inside a resource", () => {
    expect(() => checkSignInInput({ resources: ["ok", "a\nb"] })).toThrow("line breaks");
  });
});

describe("utf8Text", () => {
  it("decodes UTF-8 and rejects other bytes", () => {
    expect(utf8Text(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(utf8Text(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(BLIND_SIGNING_MESSAGE).toContain("blind signing");
  });
});
