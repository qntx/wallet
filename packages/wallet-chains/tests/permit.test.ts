import { describe, expect, it } from "vite-plus/test";

import { PERMIT2_ADDRESS, decodeEvm } from "../src/evm/index.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OTHER_TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SPENDER = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const OWNER = "0x00000000000000000000000000000000DeaDBeef";
const MAX_256 = 2n ** 256n - 1n;
const MAX_160 = 2n ** 160n - 1n;
const table: EvmTokenTable = { "1": { [TOKEN]: { symbol: "USDC", decimals: 6 } } };

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const decode = (doc: unknown) =>
  decodeEvm(
    {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: ACCOUNT,
      typedData: JSON.stringify(doc),
    },
    SIGNER,
    table,
  );

const domain = (verifyingContract: string = TOKEN) => ({
  name: "Token",
  version: "1",
  chainId: 1,
  verifyingContract,
});

const eip2612 = (
  over: { types?: string; message?: Record<string, unknown>; contract?: string } = {},
) => ({
  types: {
    EIP712Domain: fields("string name,string version,uint256 chainId,address verifyingContract"),
    Permit: fields(
      over.types ?? "address owner,address spender,uint256 value,uint256 nonce,uint256 deadline",
    ),
  },
  primaryType: "Permit",
  domain: domain(over.contract),
  message: {
    owner: OWNER,
    spender: SPENDER,
    value: "1000000",
    nonce: 0,
    deadline: 1_900_000_000,
    ...over.message,
  },
});

const permit2Types = {
  EIP712Domain: fields("string name,uint256 chainId,address verifyingContract"),
  PermitDetails: fields("address token,uint160 amount,uint48 expiration,uint48 nonce"),
  TokenPermissions: fields("address token,uint256 amount"),
};
const permit2Domain = { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS };
const details = (
  token: string,
  amount: unknown = "5000000",
  expiration: unknown = 1_900_000_000,
) => ({
  token,
  amount,
  expiration,
  nonce: 0,
});

describe("EIP-2612 and DAI permits", () => {
  it("EIP-2612 Permit is an allowance on the verifying contract", () => {
    const intent = decode(eip2612());
    expect(intent).toMatchObject({ summary: "approve", verifiability: "partial", outflows: [] });
    expect(intent.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: SPENDER,
        amount: { asset: TOKEN, amount: "1000000", symbol: "USDC", decimals: 6 },
        change: "set",
        unlimited: false,
        verified: true,
      },
    ]);
    expect(intent.message).toMatchObject({ kind: "typed-data", primaryType: "Permit" });
  });

  it("the maximum value is unlimited; numbers and hex strings are accepted", () => {
    expect(
      decode(eip2612({ message: { value: `0x${MAX_256.toString(16)}` } })).approvals[0],
    ).toMatchObject({
      unlimited: true,
    });
    expect(decode(eip2612({ message: { value: 7 } })).approvals[0]).toMatchObject({
      amount: { amount: "7" },
    });
  });

  it("an extra, missing, renamed or retyped field is not recognized", () => {
    for (const types of [
      "address owner,address spender,uint256 value,uint256 nonce,uint256 deadline,uint256 extra",
      "address owner,address spender,uint256 value,uint256 deadline",
      "address owner,address spender,uint256 amount,uint256 nonce,uint256 deadline",
      "address owner,address spender,uint128 value,uint256 nonce,uint256 deadline",
      "address spender,address owner,uint256 value,uint256 nonce,uint256 deadline",
    ]) {
      const intent = decode(eip2612({ types, message: { amount: 1, extra: 1 } }));
      expect(intent).toMatchObject({ summary: "message", verifiability: "opaque", approvals: [] });
    }
  });

  it("an out-of-range or malformed value is not recognized", () => {
    expect(decode(eip2612({ message: { value: (MAX_256 + 1n).toString() } })).summary).toBe(
      "message",
    );
    expect(decode(eip2612({ message: { value: "abc" } })).summary).toBe("message");
    expect(decode(eip2612({ message: { value: -1 } })).summary).toBe("message");
    expect(decode(eip2612({ message: { spender: "nope" } })).summary).toBe("message");
  });

  it("a Permit without a verifying contract is not recognized", () => {
    const doc = eip2612();
    expect(decode({ ...doc, domain: { name: "Token", version: "1", chainId: 1 } }).summary).toBe(
      "message",
    );
  });

  it("DAI Permit grants the maximum or revokes", () => {
    const dai = (allowed: unknown) => ({
      types: {
        EIP712Domain: fields(
          "string name,string version,uint256 chainId,address verifyingContract",
        ),
        Permit: fields("address holder,address spender,uint256 nonce,uint256 expiry,bool allowed"),
      },
      primaryType: "Permit",
      domain: domain(OTHER_TOKEN),
      message: { holder: OWNER, spender: SPENDER, nonce: 0, expiry: 0, allowed },
    });
    expect(decode(dai(true)).approvals[0]).toMatchObject({
      amount: { asset: OTHER_TOKEN, amount: MAX_256.toString() },
      change: "set",
      unlimited: true,
      verified: false,
    });
    expect(decode(dai(false)).approvals[0]).toMatchObject({
      amount: { amount: "0" },
      unlimited: false,
    });
    expect(decode(dai("yes")).summary).toBe("message");
  });
});

describe("Permit2 permits", () => {
  const single = (over: { token?: string; amount?: unknown; contract?: string } = {}) => ({
    types: {
      ...permit2Types,
      PermitSingle: fields("PermitDetails details,address spender,uint256 sigDeadline"),
    },
    primaryType: "PermitSingle",
    domain: { ...permit2Domain, verifyingContract: over.contract ?? PERMIT2_ADDRESS },
    message: {
      details: details(over.token ?? TOKEN, over.amount),
      spender: SPENDER,
      sigDeadline: 1_900_000_000,
    },
  });

  it("PermitSingle is a Permit2 allowance with an expiration", () => {
    const intent = decode(single());
    expect(intent).toMatchObject({ summary: "approve", verifiability: "partial" });
    expect(intent.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: SPENDER,
        amount: { asset: TOKEN, amount: "5000000", symbol: "USDC", decimals: 6 },
        change: "set",
        unlimited: false,
        expiration: 1_900_000_000,
        via: "permit2",
        verified: true,
      },
    ]);
  });

  it("the uint160 maximum is unlimited; one more is not recognized", () => {
    expect(decode(single({ amount: MAX_160.toString() })).approvals[0]).toMatchObject({
      unlimited: true,
    });
    expect(decode(single({ amount: (MAX_160 + 1n).toString() })).summary).toBe("message");
  });

  it("a Permit2 shape at another contract is not recognized", () => {
    expect(decode(single({ contract: OTHER_TOKEN })).summary).toBe("message");
  });

  it("PermitDetails with a different field list is not recognized", () => {
    const doc = single();
    expect(
      decode({
        ...doc,
        types: {
          ...doc.types,
          PermitDetails: fields("address token,uint256 amount,uint48 expiration,uint48 nonce"),
        },
      }).summary,
    ).toBe("message");
  });

  it("PermitBatch yields one allowance per entry", () => {
    const intent = decode({
      types: {
        ...permit2Types,
        PermitBatch: fields("PermitDetails[] details,address spender,uint256 sigDeadline"),
      },
      primaryType: "PermitBatch",
      domain: permit2Domain,
      message: {
        details: [details(TOKEN), details(OTHER_TOKEN, "1")],
        spender: SPENDER,
        sigDeadline: 1_900_000_000,
      },
    });
    expect(intent.approvals).toMatchObject([
      { amount: { asset: TOKEN } },
      { amount: { asset: OTHER_TOKEN } },
    ]);
    expect(intent.summary).toBe("approve");
  });

  it("an empty or malformed PermitBatch is not recognized", () => {
    const base = {
      types: {
        ...permit2Types,
        PermitBatch: fields("PermitDetails[] details,address spender,uint256 sigDeadline"),
      },
      primaryType: "PermitBatch",
      domain: permit2Domain,
    };
    expect(
      decode({ ...base, message: { details: [], spender: SPENDER, sigDeadline: 1 } }).summary,
    ).toBe("message");
    // A non-object where a PermitDetails struct belongs is malformed EIP-712, not a message.
    expect(() =>
      decode({
        ...base,
        message: { details: [details(TOKEN), "x"], spender: SPENDER, sigDeadline: 1 },
      }),
    ).toThrow("typedData PermitDetails value is not an object");
  });

  const transferTypes = {
    ...permit2Types,
    PermitTransferFrom: fields(
      "TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline",
    ),
  };

  it("PermitTransferFrom is a one-time transfer right", () => {
    const intent = decode({
      types: transferTypes,
      primaryType: "PermitTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: { token: TOKEN, amount: MAX_256.toString() },
        spender: SPENDER,
        nonce: 1,
        deadline: 1_900_000_000,
      },
    });
    expect(intent.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: SPENDER,
        amount: { asset: TOKEN, amount: MAX_256.toString(), symbol: "USDC", decimals: 6 },
        change: "transfer",
        unlimited: true,
        expiration: 1_900_000_000,
        via: "permit2",
        verified: true,
      },
    ]);
  });

  it("a transfer deadline beyond uint48 leaves out the expiration", () => {
    const intent = decode({
      types: transferTypes,
      primaryType: "PermitTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: { token: TOKEN, amount: "1" },
        spender: SPENDER,
        nonce: 1,
        deadline: MAX_256.toString(),
      },
    });
    expect(intent.approvals).toHaveLength(1);
    expect(intent.approvals[0]).toMatchObject({ change: "transfer", via: "permit2" });
    expect(intent.approvals[0]).not.toHaveProperty("expiration");
  });

  it("PermitBatchTransferFrom yields one right per entry", () => {
    const intent = decode({
      types: {
        ...permit2Types,
        PermitBatchTransferFrom: fields(
          "TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline",
        ),
      },
      primaryType: "PermitBatchTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: [
          { token: TOKEN, amount: "1" },
          { token: OTHER_TOKEN, amount: "2" },
        ],
        spender: SPENDER,
        nonce: 1,
        deadline: 1_900_000_000,
      },
    });
    expect(intent.approvals).toHaveLength(2);
    expect(intent.approvals[1]).toMatchObject({ change: "transfer", amount: { amount: "2" } });
  });

  it("witness variants add a warning", () => {
    const witnessTypes = (primary: string, permitted: string) => ({
      ...permit2Types,
      [primary]: [
        ...fields(`${permitted},address spender,uint256 nonce,uint256 deadline`),
        { name: "witness", type: "MockWitness" },
      ],
      MockWitness: fields("uint256 value"),
    });
    const single = decode({
      types: witnessTypes("PermitWitnessTransferFrom", "TokenPermissions permitted"),
      primaryType: "PermitWitnessTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: { token: TOKEN, amount: "1" },
        spender: SPENDER,
        nonce: 1,
        deadline: 1_900_000_000,
        witness: { value: 1 },
      },
    });
    expect(single.approvals).toHaveLength(1);
    expect(single.warnings).toStrictEqual([
      { kind: "permit2-witness", message: "the permit carries a witness with further terms" },
    ]);
    const batch = decode({
      types: witnessTypes("PermitBatchWitnessTransferFrom", "TokenPermissions[] permitted"),
      primaryType: "PermitBatchWitnessTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: [{ token: TOKEN, amount: "1" }],
        spender: SPENDER,
        nonce: 1,
        deadline: 1_900_000_000,
        witness: { value: 1 },
      },
    });
    expect(batch.warnings).toHaveLength(1);
  });

  it("a witness field with another name or an unknown type is not recognized", () => {
    const make = (witness: Field) => ({
      types: {
        ...permit2Types,
        PermitWitnessTransferFrom: [
          ...fields("TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline"),
          witness,
        ],
        MockWitness: fields("uint256 value"),
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: { token: TOKEN, amount: "1" },
        spender: SPENDER,
        nonce: 1,
        deadline: 1_900_000_000,
        witness: { value: 1 },
        extra: { value: 1 },
      },
    });
    expect(decode(make({ name: "extra", type: "MockWitness" })).summary).toBe("message");
    expect(decode(make({ name: "witness", type: "Unknown" })).summary).toBe("message");
  });

  it("a transfer permit with an extra field is not recognized", () => {
    const intent = decode({
      types: {
        ...permit2Types,
        PermitTransferFrom: fields(
          "TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,uint256 extra",
        ),
      },
      primaryType: "PermitTransferFrom",
      domain: permit2Domain,
      message: {
        permitted: { token: TOKEN, amount: "1" },
        spender: SPENDER,
        nonce: 1,
        deadline: 1,
        extra: 1,
      },
    });
    expect(intent.summary).toBe("message");
  });
});
