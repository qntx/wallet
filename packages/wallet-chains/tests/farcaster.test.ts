import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Farcaster KeyGateway `Add` and `SignedKeyRequest` documents on OP Mainnet decode as signer-key
 * content bound to the signer; variants of the shapes are blind `typed-data-variant`.
 */
import * as AbiParameters from "ox/AbiParameters";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { signEvmTypedData } from "../src/evm/sign.ts";
import type { SignRequest } from "../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x00000000000000000000000000000000C0FfeE00";
const KEY_GATEWAY = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
const VALIDATOR = "0x00000000FC700472606ED4fA22623Acf62c60553";
const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const typed = (doc: unknown, network = "eip155:10"): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account: ACCOUNT,
  typedData: JSON.stringify(doc),
});

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const METADATA_TYPE = [
  {
    type: "tuple",
    components: [
      { name: "requestFid", type: "uint256" },
      { name: "requestSigner", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  },
] as const;

const METADATA = AbiParameters.encode(METADATA_TYPE, [
  {
    requestFid: 42n,
    requestSigner: OTHER,
    signature: `0x${"00".repeat(65)}`,
    deadline: 1900000000n,
  },
]);

const addTypes = {
  EIP712Domain: DOMAIN_FIELDS,
  Add: [
    { name: "owner", type: "address" },
    { name: "keyType", type: "uint32" },
    { name: "key", type: "bytes" },
    { name: "metadataType", type: "uint8" },
    { name: "metadata", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const addDoc = (
  message: Record<string, unknown>,
  domain?: Record<string, unknown>,
  types: unknown = addTypes,
) => ({
  types,
  primaryType: "Add",
  domain: domain ?? {
    name: "Farcaster KeyGateway",
    version: "1",
    chainId: 10,
    verifyingContract: KEY_GATEWAY,
  },
  message: {
    owner: SIGNER,
    keyType: 1,
    key: KEY,
    metadataType: 1,
    metadata: METADATA,
    nonce: "0",
    deadline: "1900000000",
    ...message,
  },
});

const requestTypes = {
  EIP712Domain: DOMAIN_FIELDS,
  SignedKeyRequest: [
    { name: "requestFid", type: "uint256" },
    { name: "key", type: "bytes" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const requestDoc = (message: Record<string, unknown>, domain?: Record<string, unknown>) => ({
  types: requestTypes,
  primaryType: "SignedKeyRequest",
  domain: domain ?? {
    name: "Farcaster SignedKeyRequestValidator",
    version: "1",
    chainId: 10,
    verifyingContract: VALIDATOR,
  },
  message: { requestFid: "42", key: KEY, deadline: "1900000000", ...message },
});

const farcasterOf = (intent: ReturnType<typeof decodeEvm>) => {
  const { message } = intent;
  if (message?.kind !== "typed-data" || message.farcaster === undefined) {
    throw new Error("expected a decoded Farcaster signer-key document");
  }
  return message.farcaster;
};

describe("Farcaster KeyGateway Add", () => {
  it("a signer key add decodes as account authority", () => {
    const intent = decodeEvm(typed(addDoc({})), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("authorization");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([]);
    expect(farcasterOf(intent)).toStrictEqual({
      kind: "add",
      key: KEY,
      requestFid: "42",
      deadline: 1900000000,
    });
    expect(intent.message).not.toHaveProperty("fields");
  });

  it("an owner that is not the signer is a claimed variant, blind", () => {
    const intent = decodeEvm(typed(addDoc({ owner: OTHER })), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it.each([
    ["a key type that is not ed25519", { keyType: 2 }],
    ["a metadata type that is not 1", { metadataType: 2 }],
    ["a key that is not 32 bytes", { key: "0x1234" }],
  ])("%s is a claimed variant, blind", (_label, message) => {
    const intent = decodeEvm(typed(addDoc(message)), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it.each([
    ["a key with an odd number of nibbles", { key: `0x${"a".repeat(63)}` }],
    ["metadata with an odd number of nibbles", { metadata: "0xabc" }],
  ])("%s is a claimed variant, blind", (_label, message) => {
    /* ox would left-pad odd-length hex when hashing — the decoder must not describe it. */
    const intent = decodeEvm(typed(addDoc(message)), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("metadata that is not the canonical tuple is a claimed variant, blind", () => {
    const intent = decodeEvm(typed(addDoc({ metadata: `${METADATA}00` })), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
    const flat = AbiParameters.encode([{ type: "uint256" }], [42n]);
    const intent2 = decodeEvm(typed(addDoc({ metadata: flat })), SIGNER);
    expect(intent2.blind).toBe("typed-data-variant");
  });

  it.each([
    [
      "a domain name that is not the KeyGateway's",
      { name: "Farcaster IdGateway", version: "1", chainId: 10, verifyingContract: KEY_GATEWAY },
    ],
    [
      "a contract that is not the KeyGateway",
      { name: "Farcaster KeyGateway", version: "1", chainId: 10, verifyingContract: VALIDATOR },
    ],
    [
      "a domain version that is not 1",
      { name: "Farcaster KeyGateway", version: "2", chainId: 10, verifyingContract: KEY_GATEWAY },
    ],
    [
      "a domain chain id that is not OP Mainnet",
      { name: "Farcaster KeyGateway", version: "1", chainId: 8453, verifyingContract: KEY_GATEWAY },
    ],
  ])("%s is a claimed variant, blind", (_label, domain) => {
    const intent = decodeEvm(typed(addDoc({}, domain)), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an extra declared domain field is a claimed variant, blind", () => {
    const doc = addDoc(
      {},
      {
        name: "Farcaster KeyGateway",
        version: "1",
        chainId: 10,
        verifyingContract: KEY_GATEWAY,
        salt: "0x1234",
      },
      {
        ...addTypes,
        EIP712Domain: [...DOMAIN_FIELDS, { name: "salt", type: "bytes32" }],
      },
    );
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a request on another network than OP Mainnet is a claimed variant, blind", () => {
    const intent = decodeEvm(
      typed(
        addDoc(
          {},
          {
            name: "Farcaster KeyGateway",
            version: "1",
            chainId: 8453,
            verifyingContract: KEY_GATEWAY,
          },
        ),
        "eip155:8453",
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a deadline at or beyond uint48 is not shown", () => {
    const intent = decodeEvm(typed(addDoc({ deadline: "281474976710656" })), SIGNER);
    expect(farcasterOf(intent)).toStrictEqual({ kind: "add", key: KEY, requestFid: "42" });
  });
});

describe("Farcaster SignedKeyRequest", () => {
  it("a key request decodes as a message", () => {
    const intent = decodeEvm(typed(requestDoc({})), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("message");
    expect(intent.verifiability).toBe("partial");
    expect(farcasterOf(intent)).toStrictEqual({
      kind: "request",
      key: KEY,
      requestFid: "42",
      deadline: 1900000000,
    });
    expect(intent.message).not.toHaveProperty("fields");
  });

  it.each([
    ["a key that is not 32 bytes", { key: "0x1234" }],
    ["a requestFid that does not parse", { requestFid: "x" }],
  ])("%s is a claimed variant, blind", (_label, message) => {
    const intent = decodeEvm(typed(requestDoc(message)), SIGNER);
    expect(intent.blind).toBe("typed-data-variant");
  });
});

/* The Farcaster documents of vectors/chains/account-authority.json: each decodes to its signer-key
   content and our signer reproduces the viem signature. */
const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/account-authority.json"),
    "utf8",
  ),
) as {
  key: string;
  account: string;
  docs: Array<{
    name: string;
    network: string;
    data: Record<string, unknown>;
    signature: string;
  }>;
};

const farcasterDocs = vectors.docs
  .filter((doc) => doc.name.startsWith("farcaster"))
  .map((doc) => ({
    ...doc,
    expectedKind: doc.name.endsWith("request") ? ("request" as const) : ("add" as const),
  }));

describe("farcaster vectors", () => {
  it.each(farcasterDocs)(
    "the $name document decodes and our signer reproduces the viem signature",
    (doc) => {
      const intent = decodeEvm(typed(doc.data, doc.network), vectors.account);
      expect(intent.blind).toBeUndefined();
      expect(farcasterOf(intent)).toMatchObject({ kind: doc.expectedKind });
      const keyBytes = Uint8Array.from(Buffer.from(vectors.key.slice(2), "hex"));
      const ours = `0x${Buffer.from(signEvmTypedData(JSON.stringify(doc.data), keyBytes)).toString("hex")}`;
      expect(ours).toBe(doc.signature);
    },
  );
});
