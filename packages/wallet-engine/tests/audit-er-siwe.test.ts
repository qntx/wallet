/**
 * Audit A1 lane engine-requests, ER-09: a Sign-In with Ethereum message that the relying party's
 * verifier (viem `validateSiweMessage`, the parser behind viem's `verifySiweMessage`) accepts for
 * `victim.example`, but that `parseSignIn` classifies as `malformed`, escapes the origin binding:
 * no reject, only a `warning` that `approve` does not require to be acknowledged.
 */
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vite-plus/test";

import { parseSignIn } from "@qntx/wallet-chains";

import { requiredAcknowledgement } from "../src/requests/controller.ts";
import { assessSignIn } from "../src/requests/risk.ts";

const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const BODY = [
  "victim.example wants you to sign in with your Ethereum account:",
  ADDRESS,
  "",
  "Sign in",
  "",
  "URI: https://victim.example/login",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: 12341234abcd",
  "Issued At: 2026-11-17T12:45:13.610Z",
].join("\n");
const EVIL = "https://evil.example";
const NOW = Date.parse("2026-11-18T00:00:00Z");

const relyingPartyAccepts = (text: string): boolean =>
  validateSiweMessage({
    message: parseSiweMessage(text),
    domain: "victim.example",
    address: ADDRESS,
    time: new Date(NOW),
  });

const assess = (text: string) => {
  const signIn = parseSignIn(text, "evm");
  if (signIn === undefined) {
    throw new Error("not recognised as a sign-in at all");
  }
  return { signIn, ...assessSignIn({ signIn, origin: EVIL, signer: ADDRESS, family: "evm", now: NOW }) };
};

describe("ER-09 SIWE origin binding vs a lenient relying-party parser", () => {
  it("a conforming message for another domain is rejected", () => {
    expect(relyingPartyAccepts(BODY)).toBe(true);
    expect(assess(BODY).reject).toMatch(/victim\.example/);
  });

  it.each([
    ["a trailing line", `${BODY}\n\nthanks`],
    ["an unknown trailing field", `${BODY}\nFoo: bar`],
    ["a doubled space after a field name", BODY.replace("Version: 1", "Version:  1")],
  ])("with %s it is only a warning, yet the relying party accepts it", (_name, text) => {
    expect(relyingPartyAccepts(text)).toBe(true);
    const { signIn, reject, risk } = assess(text);
    expect(signIn.status).toBe("malformed");
    expect(reject).toBeUndefined();
    expect(risk).toStrictEqual([{ code: "sign-in-malformed", level: "warning" }]);
    expect(requiredAcknowledgement({ risk, checks: [] })).toStrictEqual({ risk: [], checks: [] });
  });
});
