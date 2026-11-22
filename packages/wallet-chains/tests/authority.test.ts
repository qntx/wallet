/**
 * Morpho Blue `Authorization`, Aave v3 `DelegationWithSig` and Snapshot `Alias` documents decode
 * as account-authority content bound to the signer; variants of the shapes fall back to blind
 * `typed-data-variant`. (Regression port of the n3-review `fund-authority-generic` corpus, which
 * pinned the pre-change leaf-dump behaviour.)
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import type { SignRequest } from "../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x00000000000000000000000000000000C0FfeE00";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MORPHO_BASE = MORPHO_BLUE;
const AAVE_VARDEBT_USDC = "0x72E95b8931767C79bA4EeE721354d6E99a61D004";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const typed = (doc: unknown, network = "eip155:1"): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account: ACCOUNT,
  typedData: JSON.stringify(doc),
});

const MORPHO_TYPES = {
  EIP712Domain: [
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Authorization: [
    { name: "authorizer", type: "address" },
    { name: "authorized", type: "address" },
    { name: "isAuthorized", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const morphoDoc = (
  domain: Record<string, unknown>,
  message: Record<string, unknown>,
  primaryType = "Authorization",
  types: Record<string, ReadonlyArray<{ name: string; type: string }>> = MORPHO_TYPES,
) => ({ types, primaryType, domain, message });

const morpho = (
  message: Record<string, unknown>,
  domain: Record<string, unknown> = { chainId: 1, verifyingContract: MORPHO_BLUE },
) => morphoDoc(domain, { authorizer: SIGNER, authorized: OTHER, isAuthorized: true, nonce: "0", deadline: "1900000000", ...message }, "Authorization");

const AAVE_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  DelegationWithSig: [
    { name: "delegatee", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const aave = (message: Record<string, unknown>, domain?: Record<string, unknown>) => ({
  types: AAVE_TYPES,
  primaryType: "DelegationWithSig",
  domain: domain ?? {
    name: "Aave Ethereum Variable Debt USDC",
    version: "1",
    chainId: 1,
    verifyingContract: AAVE_VARDEBT_USDC,
  },
  message: { delegatee: OTHER, value: "1000000", nonce: "0", deadline: "1900000000", ...message },
});

const authorityOf = (intent: ReturnType<typeof decodeEvm>) => {
  const { message } = intent;
  if (message?.kind !== "typed-data" || message.authority === undefined) {
    throw new Error("expected a decoded account-authority document");
  }
  return message.authority;
};

const SNAPSHOT_DOMAIN = { name: "snapshot", version: "0.1.4" };
const aliasDoc = (message: Record<string, unknown>, domain = SNAPSHOT_DOMAIN) => ({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
    ],
    Alias: [
      { name: "from", type: "address" },
      { name: "alias", type: "address" },
      { name: "timestamp", type: "uint64" },
    ],
  },
  primaryType: "Alias",
  domain,
  message: { from: SIGNER, alias: OTHER, timestamp: 1700000000, ...message },
});

describe("Morpho Blue Authorization", () => {
  it("a grant on the canonical contract decodes as verified authority", () => {
    const intent = decodeEvm(typed(morpho({})), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("authorization");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([]);
    expect(authorityOf(intent)).toStrictEqual({
      kind: "morpho",
      contract: MORPHO_BLUE,
      verified: true,
      authorized: OTHER,
      grant: true,
      deadline: 1900000000,
    });
    const { message } = intent;
    expect(message?.kind === "typed-data" && message.fields).toBeUndefined();
  });

  it("a revoke decodes with grant false", () => {
    const intent = decodeEvm(typed(morpho({ isAuthorized: false })), SIGNER);
    expect(authorityOf(intent)).toMatchObject({ kind: "morpho", grant: false });
  });

  it("the same shape on an unlisted contract decodes unverified", () => {
    const intent = decodeEvm(
      typed(
        morpho({}, { chainId: 1, verifyingContract: OTHER }),
        "eip155:1",
      ),
      SIGNER,
    );
    expect(authorityOf(intent)).toMatchObject({ kind: "morpho", verified: false, contract: OTHER });
  });

  it("a grant on another chain's deployment verifies for that chain", () => {
    const intent = decodeEvm(
      typed(morpho({}, { chainId: 8453, verifyingContract: MORPHO_BASE }), "eip155:8453"),
      SIGNER,
    );
    expect(authorityOf(intent)).toMatchObject({ kind: "morpho", verified: true });
  });

  it("an authorizer that is not the signer is a claimed variant, blind", () => {
    const intent = decodeEvm(typed(morpho({ authorizer: OTHER })), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
    expect(intent.message?.kind === "typed-data" && intent.message.authority).toBeUndefined();
  });

  it("a domain chain id that is not the request's is a claimed variant, blind", () => {
    const intent = decodeEvm(
      typed(morpho({}, { chainId: 8453, verifyingContract: MORPHO_BLUE }), "eip155:1"),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a non-boolean isAuthorized is a claimed variant, blind", () => {
    const intent = decodeEvm(
      typed(morpho({ isAuthorized: "true" as unknown as boolean })),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an extra declared field is a claimed variant, blind", () => {
    const doc = morphoDoc(
      { chainId: 1, verifyingContract: MORPHO_BLUE },
      { authorizer: SIGNER, authorized: OTHER, isAuthorized: true, nonce: "0", deadline: "1900000000", extra: "1" },
      "Authorization",
      {
        ...MORPHO_TYPES,
        Authorization: [...MORPHO_TYPES.Authorization, { name: "extra", type: "uint256" }],
      },
    );
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a retyped message field is a claimed variant, blind", () => {
    const doc = morphoDoc(
      { chainId: 1, verifyingContract: MORPHO_BLUE },
      { authorizer: SIGNER, authorized: OTHER, isAuthorized: true, nonce: "0", deadline: "1900000000" },
      "Authorization",
      {
        ...MORPHO_TYPES,
        Authorization: MORPHO_TYPES.Authorization.map((field) =>
          field.name === "nonce" ? { name: "nonce", type: "uint128" } : field,
        ),
      },
    );
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a document to the Morpho contract under any other primary type is a claimed variant, blind", () => {
    const doc = {
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Custom: [{ name: "data", type: "string" }],
      },
      primaryType: "Custom",
      domain: { chainId: 1, verifyingContract: MORPHO_BLUE },
      message: { data: "hello" },
    };
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a deadline at or beyond uint48 is not shown", () => {
    const intent = decodeEvm(typed(morpho({ deadline: "281474976710656" })), SIGNER);
    expect(authorityOf(intent)).toStrictEqual({
      kind: "morpho",
      contract: MORPHO_BLUE,
      verified: true,
      authorized: OTHER,
      grant: true,
    });
  });
});

describe("Aave DelegationWithSig", () => {
  it("a bounded credit on the USDC variable-debt token decodes verified in USDC units", () => {
    const intent = decodeEvm(typed(aave({})), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("authorization");
    expect(intent.verifiability).toBe("partial");
    expect(authorityOf(intent)).toStrictEqual({
      kind: "aave-credit",
      contract: AAVE_VARDEBT_USDC,
      verified: true,
      delegatee: OTHER,
      amount: { asset: USDC, amount: "1000000", symbol: "USDC", decimals: 6 },
      unlimited: false,
      deadline: 1900000000,
    });
  });

  it("an unlimited value is flagged unlimited", () => {
    const intent = decodeEvm(typed(aave({ value: MAX_UINT256 })), SIGNER);
    expect(authorityOf(intent)).toMatchObject({ kind: "aave-credit", unlimited: true });
  });

  it("a zero value decodes as the revoke form", () => {
    const intent = decodeEvm(typed(aave({ value: "0" })), SIGNER);
    const authority = authorityOf(intent);
    expect(authority).toMatchObject({ kind: "aave-credit", unlimited: false });
    if (authority.kind === "aave-credit") {
      expect(authority.amount.amount).toBe("0");
    }
  });

  it("the same shape on an unlisted contract decodes unverified with the raw contract asset", () => {
    const intent = decodeEvm(
      typed(
        aave({}, {
          name: "Aave Whatever Variable Debt X",
          version: "1",
          chainId: 1,
          verifyingContract: OTHER,
        }),
      ),
      SIGNER,
    );
    const authority = authorityOf(intent);
    expect(authority).toMatchObject({ kind: "aave-credit", verified: false, contract: OTHER });
    if (authority.kind === "aave-credit") {
      expect(authority.amount).toStrictEqual({ asset: OTHER, amount: "1000000" });
    }
  });

  it.each([
    ["a domain version that is not 1", { name: "Aave Ethereum Variable Debt USDC", version: "2", chainId: 1, verifyingContract: AAVE_VARDEBT_USDC }],
    ["a missing domain name", { version: "1", chainId: 1, verifyingContract: AAVE_VARDEBT_USDC }],
    ["a domain chain id that is not the request's", { name: "Aave Ethereum Variable Debt USDC", version: "1", chainId: 8453, verifyingContract: AAVE_VARDEBT_USDC }],
  ])("%s is a claimed variant, blind", (_label, domain) => {
    const intent = decodeEvm(typed(aave({}, domain)), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

describe("Snapshot Alias", () => {
  it("an alias bound to the signer decodes as account authority", () => {
    const intent = decodeEvm(typed(aliasDoc({})), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("authorization");
    expect(intent.verifiability).toBe("partial");
    expect(authorityOf(intent)).toStrictEqual({ kind: "snapshot-alias", alias: OTHER });
    const { message } = intent;
    expect(message?.kind === "typed-data" && message.fields).toBeUndefined();
  });

  it("an alias whose from is not the signer is a claimed variant, blind", () => {
    const intent = decodeEvm(typed(aliasDoc({ from: OTHER })), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a Snapshot Alias under a wrong domain version is a claimed variant, blind", () => {
    const intent = decodeEvm(
      typed(aliasDoc({}, { name: "snapshot", version: "0.2.0" })),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a Snapshot Alias with a retyped field is a claimed variant, blind", () => {
    const doc = aliasDoc({});
    const mutated = {
      ...doc,
      types: {
        ...doc.types,
        Alias: doc.types.Alias.map((field) =>
          field.name === "timestamp" ? { name: "timestamp", type: "string" } : field,
        ),
      },
    };
    const intent = decodeEvm(typed(mutated), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

/**
 * The probed deployment tables and signed documents of vectors/chains/account-authority.json:
 * every probed contract passed its on-chain check at generation time, every document decodes to
 * its authority content, and our signer reproduces the viem signatures. Farcaster documents are
 * asserted in farcaster.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { signEvmTypedData } from "../src/evm/sign.ts";

type AuthorityDoc = {
  name: string;
  network: string;
  data: {
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    domain: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  digest: string;
  signature: string;
  manualDigest?: string;
};

const authorityVectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/account-authority.json"), "utf8"),
) as {
  key: string;
  account: string;
  probes: {
    morpho: Array<{ chainId: number; address: string; codePresent: boolean; ok?: boolean }>;
    aave: Array<{ chainId: number; debtToken: string; codePresent: boolean; ok?: boolean }>;
    farcaster: Array<{ label: string; codePresent: boolean; ok?: boolean }>;
  };
  docs: AuthorityDoc[];
};

describe("account-authority vectors", () => {
  it("every probed contract has code and passed its on-chain domain check", () => {
    for (const probe of authorityVectors.probes.morpho) {
      expect(probe.codePresent && probe.ok, `morpho ${probe.chainId} ${probe.address}`).toBe(true);
    }
    for (const probe of authorityVectors.probes.aave) {
      expect(probe.codePresent && probe.ok, `aave ${probe.chainId} ${probe.debtToken}`).toBe(true);
    }
    for (const probe of authorityVectors.probes.farcaster) {
      expect(probe.codePresent && probe.ok, `farcaster ${probe.label}`).toBe(true);
    }
  });

  it.each(authorityVectors.docs.filter((doc) => !doc.name.startsWith("farcaster")))(
    "the $name document decodes and our signer reproduces the viem signature",
    (doc) => {
      const intent = decodeEvm(typed(doc.data, doc.network), authorityVectors.account);
      expect(intent.blind).toBeUndefined();
      if (doc.name.startsWith("morpho")) {
        expect(authorityOf(intent)).toMatchObject({
          kind: "morpho",
          verified: true,
          grant: doc.name.endsWith("grant"),
        });
      } else if (doc.name.startsWith("aave")) {
        expect(authorityOf(intent)).toMatchObject({
          kind: "aave-credit",
          verified: !doc.name.includes("unverified"),
        });
      } else {
        expect(authorityOf(intent)).toMatchObject({ kind: "snapshot-alias" });
      }
      const keyBytes = Uint8Array.from(Buffer.from(authorityVectors.key.slice(2), "hex"));
      const ours = `0x${Buffer.from(signEvmTypedData(JSON.stringify(doc.data), keyBytes)).toString("hex")}`;
      expect(ours).toBe(doc.signature);
    },
  );
});
