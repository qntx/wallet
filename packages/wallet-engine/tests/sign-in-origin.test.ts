import { createSignInMessageText, parseSignInMessageText } from "@solana/wallet-standard-util";
import * as fc from "fast-check";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vite-plus/test";

import { parseSignIn } from "@qntx/wallet-chains";

import { assessSignIn } from "../src/requests/risk.ts";

const ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SOLANA_ADDRESS = "11111111111111111111111111111111";
const EVIL = "https://evil.example";
const LOCAL = "http://localhost:5173";
const NOW = Date.parse("2026-11-18T00:00:00Z");

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

/** Viem's `verifySiweMessage` parser path — what a relying party accepting `victim.example` runs. */
const relyingPartyAccepts = (text: string): boolean =>
  validateSiweMessage({
    message: parseSiweMessage(text),
    domain: "victim.example",
    address: ADDRESS,
    time: new Date(NOW),
  });

const assess = (text: string, origin = EVIL, family: "evm" | "solana" = "evm") => {
  const signIn = parseSignIn(text, family);
  if (signIn === undefined) {
    throw new Error("not recognised as a sign-in at all");
  }
  return assessSignIn({
    signIn,
    origin,
    signer: family === "evm" ? ADDRESS : SOLANA_ADDRESS,
    family,
    now: NOW,
  });
};

const FOREIGN_WARNING = [{ code: "sign-in-malformed", level: "warning" }] as const;

/** The risk a matching-origin page sees: the malformed warning, unless siwx parsed the text. */
const matchingRisk = (text: string) =>
  parseSignIn(text, "evm")?.status === "malformed" ? [...FOREIGN_WARNING] : [];

describe("a malformed sign-in text is bound to every domain it claims", () => {
  it.each([
    ["a trailing line", `${BODY}\n\nthanks`],
    ["an unknown trailing field", `${BODY}\nFoo: bar`],
    ["a doubled space after a field name", BODY.replace("Version: 1", "Version:  1")],
    ["a lowercase (non-checksummed) address", BODY.replace(ADDRESS, ADDRESS.toLowerCase())],
  ])("with %s viem accepts it for victim.example and the page is bound", (_name, text) => {
    expect(relyingPartyAccepts(text)).toBe(true);
    expect(assess(text).reject).toContain("victim.example");
    expect(assess(text, "https://victim.example")).toStrictEqual({ risk: matchingRisk(text) });
    expect(assess(text, LOCAL).risk).toContainEqual({
      code: "sign-in-domain-mismatch",
      level: "danger",
    });
  });

  it.each([
    [
      "the canonical text without optional fields",
      createSignInMessageText({ domain: "victim.example", address: SOLANA_ADDRESS }),
    ],
    [
      "the canonical text with a nonce",
      createSignInMessageText({
        domain: "victim.example",
        address: SOLANA_ADDRESS,
        nonce: "abc",
      }),
    ],
  ])("%s is a SIWS a lenient verifier accepts, and the page is bound", (_name, text) => {
    expect(parseSignInMessageText(text)?.domain).toBe("victim.example");
    expect(parseSignIn(text, "solana")?.status).toBe("malformed");
    expect(assess(text, EVIL, "solana").reject).toContain("victim.example");
    expect(assess(text, "https://victim.example", "solana")).toStrictEqual({
      risk: [...FOREIGN_WARNING],
    });
  });
});

const JUNK = fc.constantFrom(
  "Foo: bar",
  "thanks for visiting",
  "Key: value",
  "Nonce: 9999",
  "Chain ID: 56",
);

const siweVariant = fc.record({
  insertJunk: fc.array(fc.tuple(fc.integer({ min: 0, max: 10 }), JUNK), { maxLength: 3 }),
  padField: fc.constantFrom("Version", "Nonce", "Chain ID", "URI", "none"),
  padSpaces: fc.integer({ min: 1, max: 3 }),
  crlf: fc.boolean(),
  lowercaseAddress: fc.boolean(),
  schemePrefix: fc.boolean(),
  drop: fc.constantFrom("statement", "URI", "Nonce", "Issued At", "none"),
});

const siweText = (m: {
  insertJunk: ReadonlyArray<readonly [number, string]>;
  padField: string;
  padSpaces: number;
  crlf: boolean;
  lowercaseAddress: boolean;
  schemePrefix: boolean;
  drop: string;
}): string => {
  const lines = BODY.split("\n").filter(
    (line) => m.drop === "none" || !line.startsWith(`${m.drop}:`),
  );
  if (m.drop === "statement") {
    lines.splice(3, 2);
  }
  for (const [at, junk] of m.insertJunk) {
    lines.splice(Math.min(at, lines.length), 0, junk);
  }
  if (m.padField !== "none") {
    const index = lines.findIndex((line) => line.startsWith(`${m.padField}:`));
    if (index !== -1) {
      lines[index] =
        `${m.padField}:${" ".repeat(m.padSpaces)}${(lines[index] ?? "").slice(m.padField.length + 2)}`;
    }
  }
  if (m.lowercaseAddress) {
    const index = lines.indexOf(ADDRESS);
    if (index !== -1) {
      lines[index] = ADDRESS.toLowerCase();
    }
  }
  if (m.schemePrefix && lines[0] !== undefined) {
    lines[0] = `https://${lines[0]}`;
  }
  return lines.join(m.crlf ? "\r\n" : "\n");
};

const siwsVariant = fc.record({
  statement: fc.option(fc.constantFrom("Sign in", "hello"), { nil: undefined }),
  nonce: fc.option(fc.constantFrom("abc", "12341234"), { nil: undefined }),
  chainId: fc.option(fc.constantFrom("mainnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"), {
    nil: undefined,
  }),
  uri: fc.option(fc.constant("https://victim.example/login"), { nil: undefined }),
  version: fc.option(fc.constant("1"), { nil: undefined }),
  issuedAt: fc.option(fc.constant("2026-11-17T12:45:13.610Z"), { nil: undefined }),
  appendJunk: fc.array(JUNK, { maxLength: 2 }),
  crlf: fc.boolean(),
});

const siwsText = (m: {
  statement?: string | undefined;
  nonce?: string | undefined;
  chainId?: string | undefined;
  uri?: string | undefined;
  version?: string | undefined;
  issuedAt?: string | undefined;
  appendJunk: ReadonlyArray<string>;
  crlf: boolean;
}): string => {
  const input: Parameters<typeof createSignInMessageText>[0] = {
    domain: "victim.example",
    address: SOLANA_ADDRESS,
    ...(m.statement === undefined ? {} : { statement: m.statement }),
    ...(m.nonce === undefined ? {} : { nonce: m.nonce }),
    ...(m.chainId === undefined ? {} : { chainId: m.chainId }),
    ...(m.uri === undefined ? {} : { uri: m.uri }),
    ...(m.version === undefined ? {} : { version: m.version }),
    ...(m.issuedAt === undefined ? {} : { issuedAt: m.issuedAt }),
  };
  const base = createSignInMessageText(input);
  return [base, ...m.appendJunk].join(m.crlf ? "\r\n" : "\n");
};

const siweAccepted = (text: string): boolean => {
  try {
    return relyingPartyAccepts(text);
  } catch {
    return false;
  }
};

/** `false` only when the lenient verifier accepts the text yet the wallet does not refuse it. */
const evilRefuses = (text: string, family: "evm" | "solana", accepted: boolean): boolean => {
  if (!accepted) {
    return true;
  }
  const signIn = parseSignIn(text, family) ?? { status: "malformed" as const, claims: [] };
  return (
    assessSignIn({
      signIn,
      origin: EVIL,
      signer: family === "evm" ? ADDRESS : SOLANA_ADDRESS,
      family,
      now: NOW,
    }).reject !== undefined
  );
};

describe("differential: whatever a lenient verifier accepts is origin-bound", () => {
  it("every SIWE variant viem accepts for victim.example is refused from another origin", () => {
    let accepted = 0;
    fc.assert(
      fc.property(siweVariant, (m) => {
        const text = siweText(m);
        const ok = siweAccepted(text);
        accepted += Number(ok);
        return evilRefuses(text, "evm", ok);
      }),
      { numRuns: 500, seed: 20261118 },
    );
    expect(accepted).toBeGreaterThanOrEqual(100);
  });

  it("every SIWS text wallet-standard-util reads as victim.example is refused from another origin", () => {
    let accepted = 0;
    fc.assert(
      fc.property(siwsVariant, (m) => {
        const text = siwsText(m);
        const ok = parseSignInMessageText(text)?.domain === "victim.example";
        accepted += Number(ok);
        return evilRefuses(text, "solana", ok);
      }),
      { numRuns: 500, seed: 20261118 },
    );
    expect(accepted).toBeGreaterThanOrEqual(100);
  });
});
