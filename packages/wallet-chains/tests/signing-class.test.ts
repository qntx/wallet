import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import * as fc from "fast-check";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vite-plus/test";

import {
  checksumEvmAddress,
  decodeBatchExecute,
  decodeEvm,
  encodeBatchExecute,
  evmTokenTable,
} from "../src/evm/index.ts";
import { isBlindIntent } from "../src/index.ts";
import type { EvmTransaction, SignRequest, TypedDataLeaf } from "../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const UNIVERSAL_ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const OTHER = "0x00000000000000000000000000000000c0ffee00";
const MAX_UINT256 = 2n ** 256n - 1n;
const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const tx = (
  to: string | undefined,
  data: string,
  value = "0x0",
  chainId = 1,
  network = `eip155:${chainId}`,
): SignRequest => ({
  kind: "evm.transaction",
  network,
  account,
  tx: {
    type: "eip1559",
    chainId,
    nonce: 0,
    gas: "0x30000",
    ...(to === undefined ? {} : { to }),
    value,
    data,
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  } as EvmTransaction,
});

const typed = (doc: unknown): SignRequest => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account,
  typedData: JSON.stringify(doc),
});

const personal = (bytes: Uint8Array): SignRequest => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account,
  message: bytes,
});

const fieldsOf = (
  intent: ReturnType<typeof decodeEvm>,
): ReadonlyArray<TypedDataLeaf> | undefined =>
  intent.message?.kind === "typed-data" ? intent.message.fields : undefined;

describe("everyday contract calls are described, not blind", () => {
  const txCases = [
    [
      "WETH deposit",
      "deposit()",
      tx(
        WETH,
        encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) }),
        "0xde0b6b3a7640000",
      ),
    ],
    [
      "Aave V3 supply",
      "supply(address,uint256,address,uint16)",
      tx(
        AAVE_POOL,
        encodeFunctionData({
          abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
          args: [USDC, 1_000_000n, SIGNER, 0],
        }),
      ),
    ],
    [
      "Universal Router execute",
      "execute(bytes,bytes[],uint256)",
      tx(
        UNIVERSAL_ROUTER,
        encodeFunctionData({
          abi: parseAbi(["function execute(bytes,bytes[],uint256)"]),
          args: ["0x0b00", ["0x", "0x"], 2_000_000_000n],
        }),
        "0x2386f26fc10000",
      ),
    ],
  ] as const;

  it.each(txCases)("%s is opaque but carries no blind reason", (_name, signature, request) => {
    const intent = decodeEvm(request, SIGNER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(isBlindIntent(intent)).toBe(false);
    expect(intent.contract?.selector).toBe(toFunctionSelector(signature));
  });

  it("Aave withdraw is described, with a different selector than supply", () => {
    const withdraw = tx(
      AAVE_POOL,
      encodeFunctionData({
        abi: parseAbi(["function withdraw(address,uint256,address)"]),
        args: [USDC, MAX_UINT256, "0x00000000000000000000000000000000000bad00"],
      }),
    );
    const intent = decodeEvm(withdraw, SIGNER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(intent.contract?.selector).toBe("0x69328dec");
    expect(intent.contract?.selector).toBe(toFunctionSelector("withdraw(address,uint256,address)"));
    expect(intent.contract?.selector).not.toBe(
      toFunctionSelector("supply(address,uint256,address,uint16)"),
    );
  });

  it("a CoW order shows all twelve leaves in declaration order", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Order: [
            { name: "sellToken", type: "address" },
            { name: "buyToken", type: "address" },
            { name: "receiver", type: "address" },
            { name: "sellAmount", type: "uint256" },
            { name: "buyAmount", type: "uint256" },
            { name: "validTo", type: "uint32" },
            { name: "appData", type: "bytes32" },
            { name: "feeAmount", type: "uint256" },
            { name: "kind", type: "string" },
            { name: "partiallyFillable", type: "bool" },
            { name: "sellTokenBalance", type: "string" },
            { name: "buyTokenBalance", type: "string" },
          ],
        },
        primaryType: "Order",
        domain: {
          name: "Gnosis Protocol",
          version: "v2",
          chainId: 1,
          verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
        },
        message: {
          sellToken: USDC,
          buyToken: WETH,
          receiver: SIGNER,
          sellAmount: "1000000",
          buyAmount: "1",
          validTo: 2_000_000_000,
          appData: `0x${"00".repeat(32)}`,
          feeAmount: "0",
          kind: "sell",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
        },
      }),
      SIGNER,
    );
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(isBlindIntent(intent)).toBe(false);
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "sellToken", value: checksumEvmAddress(USDC) },
      { path: "buyToken", value: checksumEvmAddress(WETH) },
      { path: "receiver", value: checksumEvmAddress(SIGNER) },
      { path: "sellAmount", value: "1000000" },
      { path: "buyAmount", value: "1" },
      { path: "validTo", value: "2000000000" },
      { path: "appData", value: `0x${"00".repeat(32)}` },
      { path: "feeAmount", value: "0" },
      { path: "kind", value: "sell" },
      { path: "partiallyFillable", value: "false" },
      { path: "sellTokenBalance", value: "erc20" },
      { path: "buyTokenBalance", value: "erc20" },
    ]);
  });
});

describe("an unrecognised function of a table token is blind", () => {
  const STANDARD_SELECTORS = new Set<string>(
    [
      "transfer(address,uint256)",
      "approve(address,uint256)",
      "increaseAllowance(address,uint256)",
      "decreaseAllowance(address,uint256)",
      "setApprovalForAll(address,bool)",
      "approve(address,address,uint160,uint48)",
      "lockdown((address,address)[])",
      "transferFrom(address,address,uint256)",
      "safeTransferFrom(address,address,uint256)",
      "safeTransferFrom(address,address,uint256,bytes)",
      "safeTransferFrom(address,address,uint256,uint256,bytes)",
      "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
    ].map((signature) => toFunctionSelector(signature)),
  );

  it("USDC calldata the table does not know is blind with the token's symbol", () => {
    const intent = decodeEvm(tx(USDC, "0xdeadbeef"), SIGNER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBe("token-function");
    expect(intent.contract).toMatchObject({ selector: "0xdeadbeef", symbol: "USDC" });
  });

  it("USDC transfer is recognised, not blind", () => {
    const transfer = encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256)"]),
      args: [OTHER, 1n],
    });
    const intent = decodeEvm(tx(USDC, transfer), SIGNER);
    expect(intent.verifiability).toBe("full");
    expect(intent.blind).toBeUndefined();
  });

  it("the same unknown selector on a non-table contract is only described", () => {
    const intent = decodeEvm(tx(OTHER, "0xdeadbeef"), SIGNER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
  });

  it("every table token's unknown selector is blind", () => {
    const selector = fc
      .uint8Array({ minLength: 4, maxLength: 4 })
      .map((b) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`)
      .filter((data) => !STANDARD_SELECTORS.has(data));
    for (const [chainId, tokens] of Object.entries(evmTokenTable)) {
      for (const [address] of Object.entries(tokens)) {
        fc.assert(
          fc.property(selector, (data) => {
            expect(decodeEvm(tx(address, data, "0x0", Number(chainId)), SIGNER).blind).toBe(
              "token-function",
            );
          }),
          { numRuns: 25 },
        );
      }
    }
  });
});

describe("calldata to the signing account is blind", () => {
  const SELF = checksumEvmAddress("0x00000000000000000000000000000000deaDBEEF");
  const batch = (calls: ReadonlyArray<{ to: string; value: bigint; data: string }>) =>
    tx(SELF, encodeBatchExecute(calls));

  it.each([
    ["lowercase spelling, no value", SELF.toLowerCase(), "0x0"],
    ["checksummed spelling, no value", SELF, "0x0"],
    ["lowercase spelling, with value", SELF.toLowerCase(), "0x1"],
    ["checksummed spelling, with value", SELF, "0x2"],
  ])("%s → account-code", (_name, to, value) => {
    const intent = decodeEvm(tx(to, "0xdeadbeef01020304", value), SELF);
    expect(intent.blind).toBe("account-code");
    expect(intent.contract?.selector).toBe("0xdeadbeef");
  });

  it("a recognised token selector to self is still account-code", () => {
    const transfer = encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256)"]),
      args: [OTHER, 1n],
    });
    expect(decodeEvm(tx(SELF, transfer), SELF).blind).toBe("account-code");
  });

  it("a batch of ordinary calls to self is not blind", () => {
    const transfer = encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256)"]),
      args: [OTHER, 1n],
    });
    const intent = decodeEvm(
      batch([
        { to: OTHER, value: 0n, data: "0x" },
        { to: USDC, value: 0n, data: transfer },
      ]),
      SELF,
    );
    expect(intent.summary).toBe("batch");
    expect(intent.blind).toBeUndefined();
  });

  it("a batch with a blind inner call propagates the first reason", () => {
    expect(decodeEvm(batch([{ to: USDC, value: 0n, data: "0xdeadbeef" }]), SELF).blind).toBe(
      "token-function",
    );
    expect(
      decodeEvm(
        batch([
          { to: OTHER, value: 0n, data: "0x" },
          { to: SELF, value: 0n, data: "0x12345678" },
        ]),
        SELF,
      ).blind,
    ).toBe("account-code");
  });

  it("a batch of only described calls is not blind", () => {
    const intent = decodeEvm(batch([{ to: OTHER, value: 0n, data: "0xdeadbeef" }]), SELF);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
  });

  it("any non-empty self-calldata that is not a batch is blind", () => {
    fc.assert(
      fc.property(
        fc
          .uint8Array({ minLength: 1, maxLength: 96 })
          .map((b) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`)
          .filter((data) => decodeBatchExecute(data) === undefined),
        fc.constantFrom("0x0", "0x1"),
        (data, value) => {
          expect(decodeEvm(tx(SELF, data, value), SELF).blind).toBe("account-code");
        },
      ),
    );
  });
});

describe("contract creation is described, not blind", () => {
  it("deploy bytecode carries the created address and no selector", () => {
    const intent = decodeEvm(tx(undefined, "0x6080604052"), SIGNER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(intent.contract?.created).toBe(true);
    expect(intent.contract?.selector).toBeUndefined();
  });
});

describe("typed data shows its leaves or is blind", () => {
  const doc = (
    fields: ReadonlyArray<{ name: string; type: string }>,
    message: Record<string, unknown>,
    extraTypes: Record<string, ReadonlyArray<{ name: string; type: string }>> = {},
  ) => ({
    types: {
      EIP712Domain: [{ name: "chainId", type: "uint256" }],
      ...extraTypes,
      Root: fields,
    },
    primaryType: "Root",
    domain: { chainId: 1 },
    message,
  });

  it("the classic Mail example lists nested leaves in declaration order", () => {
    const mail = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
      message: {
        from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    };
    const intent = decodeEvm(typed(mail), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "from.name", value: "Cow" },
      { path: "from.wallet", value: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
      { path: "to.name", value: "Bob" },
      { path: "to.wallet", value: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
      { path: "contents", value: "Hello, Bob!" },
    ]);
  });

  it.each([15, 16])("%i leaves fit the display budget", (count) => {
    const intent = decodeEvm(
      typed(
        doc(
          Array.from({ length: count }, (_, i) => ({ name: `f${i}`, type: "uint256" })),
          Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, String(i)])),
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toHaveLength(count);
  });

  it("17 leaves exceed the budget and blind the whole document", () => {
    const count = 17;
    const intent = decodeEvm(
      typed(
        doc(
          Array.from({ length: count }, (_, i) => ({ name: `f${i}`, type: "uint256" })),
          Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, String(i)])),
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-oversize");
    expect(fieldsOf(intent)).toBeUndefined();
    expect(isBlindIntent(intent)).toBe(true);
  });

  it("an array of structs indexes each element's leaves", () => {
    const intent = decodeEvm(
      typed(
        doc(
          [{ name: "orders", type: "Order[]" }],
          { orders: [{ maker: OTHER, amount: "7" }] },
          {
            Order: [
              { name: "maker", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "orders[0].maker", value: checksumEvmAddress(OTHER) },
      { path: "orders[0].amount", value: "7" },
    ]);
  });

  it("an empty array is one leaf", () => {
    const intent = decodeEvm(typed(doc([{ name: "xs", type: "uint256[]" }], { xs: [] })), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toStrictEqual([{ path: "xs", value: "[]" }]);
  });

  it("canonical integer and fixed-bytes forms display normally", () => {
    const intent = decodeEvm(
      typed(
        doc(
          [
            { name: "u", type: "uint8" },
            { name: "i", type: "int256" },
            { name: "h", type: "bytes8" },
          ],
          { u: "0xff", i: "-3", h: `0x${"ab".repeat(8)}` },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "u", value: "255" },
      { path: "i", value: "-3" },
      { path: "h", value: `0x${"ab".repeat(8)}` },
    ]);
  });

  it("a leaf at exactly the line limit is shown", () => {
    const intent = decodeEvm(
      typed(
        doc(
          [
            { name: "s", type: "string" },
            { name: "b", type: "bytes" },
          ],
          { s: "x".repeat(96), b: `0x${"ab".repeat(47)}` },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "s", value: "x".repeat(96) },
      { path: "b", value: `0x${"ab".repeat(47)}` },
    ]);
  });

  it.each([
    ["a string longer than the line limit", { name: "s", type: "string" }, "x".repeat(97)],
    ["a multi-line string", { name: "s", type: "string" }, "first\nsecond"],
    ["a JSON number in a string field", { name: "s", type: "string" }, 42],
    ["a bool given as a string", { name: "b", type: "bool" }, "false"],
    ["a uint with leading whitespace", { name: "u", type: "uint256" }, " 12"],
    ["a uint in exponent form", { name: "u", type: "uint256" }, "1e3"],
    ["a uint as a non-integer number", { name: "u", type: "uint256" }, 1.5],
    ["a uint8 above its range", { name: "u", type: "uint8" }, "256"],
    ["an int8 below its range", { name: "i", type: "int8" }, "-129"],
    ["a negative uint", { name: "u", type: "uint256" }, "-1"],
    ["odd-length bytes", { name: "b", type: "bytes" }, "0xabc"],
    ["bytes beyond the line limit", { name: "b", type: "bytes" }, `0x${"ab".repeat(48)}`],
  ] as const)("%s cannot be shown and blinds the document", (_name, field, value) => {
    const intent = decodeEvm(typed(doc([field], { [field.name]: value })), SIGNER);
    expect(intent.blind).toBe("typed-data-oversize");
    expect(fieldsOf(intent)).toBeUndefined();
  });

  it("a field path longer than the line limit blinds the document", () => {
    const name = `f${"x".repeat(96)}`;
    const intent = decodeEvm(typed(doc([{ name, type: "uint256" }], { [name]: "1" })), SIGNER);
    expect(intent.blind).toBe("typed-data-oversize");
  });

  it("recognised permit, Seaport and Safe documents carry no leaf list", () => {
    const permit = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      domain: { name: "Token", version: "1", chainId: 1, verifyingContract: USDC },
      message: {
        owner: SIGNER,
        spender: OTHER,
        value: "1000000",
        nonce: 0,
        deadline: 1_900_000_000,
      },
    };
    const seaport = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        OrderComponents: [
          { name: "offerer", type: "address" },
          { name: "zone", type: "address" },
          { name: "offer", type: "OfferItem[]" },
          { name: "consideration", type: "ConsiderationItem[]" },
          { name: "orderType", type: "uint8" },
          { name: "startTime", type: "uint256" },
          { name: "endTime", type: "uint256" },
          { name: "zoneHash", type: "bytes32" },
          { name: "salt", type: "uint256" },
          { name: "conduitKey", type: "bytes32" },
          { name: "counter", type: "uint256" },
        ],
        OfferItem: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifierOrCriteria", type: "uint256" },
          { name: "startAmount", type: "uint256" },
          { name: "endAmount", type: "uint256" },
        ],
        ConsiderationItem: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifierOrCriteria", type: "uint256" },
          { name: "startAmount", type: "uint256" },
          { name: "endAmount", type: "uint256" },
          { name: "recipient", type: "address" },
        ],
      },
      primaryType: "OrderComponents",
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
      },
      message: {
        offerer: SIGNER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: [
          {
            itemType: 2,
            token: OTHER,
            identifierOrCriteria: "1",
            startAmount: "1",
            endAmount: "1",
          },
        ],
        consideration: [
          {
            itemType: 1,
            token: USDC,
            identifierOrCriteria: "1",
            startAmount: "5000000",
            endAmount: "5000000",
            recipient: SIGNER,
          },
        ],
        orderType: 0,
        startTime: "1700000000",
        endTime: "1700001000",
        zoneHash: `0x${"00".repeat(32)}`,
        salt: "123",
        conduitKey: `0x${"00".repeat(32)}`,
        counter: "0",
      },
    };
    const safe = {
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      domain: { chainId: 1, verifyingContract: "0xD5Ffe748b45F5253Fc9975fDd96FDdeC052e6D52" },
      message: {
        to: OTHER,
        value: "0",
        data: "0x",
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: "0x0000000000000000000000000000000000000000",
        nonce: "42",
      },
    };
    for (const d of [permit, seaport, safe]) {
      const intent = decodeEvm(typed(d), SIGNER);
      expect(fieldsOf(intent)).toBeUndefined();
      expect(intent.blind).toBeUndefined();
    }
  });
});

describe("typed data that signs only hashes is blind", () => {
  const RAW_HASH = `0x${"ab".repeat(32)}`;
  const SAFE = checksumEvmAddress("0xd5ffe748b45f5253fc9975fdd96fddec052e6d52");
  type Field = { name: string; type: string };
  const doc = (
    primaryType: string,
    message: Record<string, unknown>,
    types: Record<string, ReadonlyArray<Field>>,
    domain: Record<string, unknown> = { chainId: 1 },
  ) => ({
    types: { EIP712Domain: [{ name: "chainId", type: "uint256" }], ...types },
    primaryType,
    domain,
    message,
  });

  it("SafeMessage(bytes message) wrapping a 32-byte hash is a commitment", () => {
    const intent = decodeEvm(
      typed(
        doc(
          "SafeMessage",
          { message: RAW_HASH },
          { SafeMessage: [{ name: "message", type: "bytes" }] },
          { chainId: 1, verifyingContract: SAFE },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-commitment");
    expect(isBlindIntent(intent)).toBe(true);
    expect(fieldsOf(intent)).toStrictEqual([{ path: "message", value: RAW_HASH }]);
  });

  it("CoinbaseSmartWalletMessage(bytes32 hash) is a commitment", () => {
    const intent = decodeEvm(
      typed(
        doc(
          "CoinbaseSmartWalletMessage",
          { hash: RAW_HASH },
          { CoinbaseSmartWalletMessage: [{ name: "hash", type: "bytes32" }] },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-commitment");
  });

  it("a nested struct of only bytes32 leaves is a commitment", () => {
    const intent = decodeEvm(
      typed(
        doc(
          "Root",
          { inner: { a: RAW_HASH, b: RAW_HASH } },
          {
            Root: [{ name: "inner", type: "Inner" }],
            Inner: [
              { name: "a", type: "bytes32" },
              { name: "b", type: "bytes32" },
            ],
          },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-commitment");
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "inner.a", value: RAW_HASH },
      { path: "inner.b", value: RAW_HASH },
    ]);
  });

  it("a bytes32 array is a commitment", () => {
    const intent = decodeEvm(
      typed(
        doc(
          "Root",
          { hashes: [RAW_HASH, `0x${"cd".repeat(32)}`] },
          { Root: [{ name: "hashes", type: "bytes32[]" }] },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-commitment");
  });

  it("a string leaf holding the hex of 32 bytes is a commitment; real text is not", () => {
    const hex = decodeEvm(
      typed(
        doc("Root", { s: RAW_HASH }, { Root: [{ name: "s", type: "string" }] }),
      ),
      SIGNER,
    );
    expect(hex.blind).toBe("typed-data-commitment");
    const text = decodeEvm(
      typed(doc("Root", { s: "hello" }, { Root: [{ name: "s", type: "string" }] })),
      SIGNER,
    );
    expect(text.blind).toBeUndefined();
    expect(isBlindIntent(text)).toBe(false);
  });

  it("a commitment leaf beside a readable one stays described", () => {
    const intent = decodeEvm(
      typed(
        doc(
          "Root",
          { hash: RAW_HASH, amount: "7" },
          {
            Root: [
              { name: "hash", type: "bytes32" },
              { name: "amount", type: "uint256" },
            ],
          },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toStrictEqual([
      { path: "hash", value: RAW_HASH },
      { path: "amount", value: "7" },
    ]);
  });

  const hexOf = (b: Uint8Array): string =>
    `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const leafType = fc.oneof(
    fc.constant("bytes"),
    fc.integer({ min: 1, max: 32 }).map((n) => `bytes${n}`),
  );
  const leafValue = (type: string): fc.Arbitrary<string> =>
    type === "bytes"
      ? fc.uint8Array({ minLength: 0, maxLength: 40 }).map(hexOf)
      : fc
          .uint8Array({ minLength: Number(type.slice(5)), maxLength: Number(type.slice(5)) })
          .map(hexOf);
  const leaf = (name: string): fc.Arbitrary<Field & { value: unknown }> =>
    fc.tuple(leafType, fc.boolean()).chain(([type, isArray]) =>
      (isArray
        ? fc.array(leafValue(type), { minLength: 1, maxLength: 2 })
        : leafValue(type)
      ).map((value) => ({ name, type: isArray ? `${type}[]` : type, value })),
    );
  const leafFields = (
    count: fc.Arbitrary<number>,
  ): fc.Arbitrary<ReadonlyArray<Field & { value: unknown }>> =>
    count.chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => leaf(`f${i}`))));
  /** Random docs whose every leaf is bytes/bytesN: nested structs and non-empty arrays. */
  const bytesDoc: fc.Arbitrary<Record<string, unknown>> = fc
    .tuple(
      leafFields(fc.integer({ min: 1, max: 6 })),
      leafFields(fc.integer({ min: 0, max: 4 })),
      fc.integer({ min: 0, max: 2 }),
    )
    .map(([root, inner, nested]) => {
      const types: Record<string, ReadonlyArray<Field>> = {
        Root: root.map(({ name, type }) => ({ name, type })),
      };
      const message: Record<string, unknown> = Object.fromEntries(
        root.map(({ name, value }) => [name, value]),
      );
      if (inner.length > 0 && nested > 0) {
        types["Inner"] = inner.map(({ name, type }) => ({ name, type }));
        const value = Object.fromEntries(inner.map(({ name, value }) => [name, value]));
        types["Root"] = [
          ...(types["Root"] ?? []),
          { name: "inner", type: nested === 2 ? "Inner[]" : "Inner" },
        ];
        message["inner"] = nested === 2 ? [value, value] : value;
      }
      return doc("Root", message, types);
    });

  it("documents whose leaves are all bytes are blind", () => {
    fc.assert(
      fc.property(bytesDoc, (doc) => {
        const intent = decodeEvm(typed(doc), SIGNER);
        expect(isBlindIntent(intent)).toBe(true);
        expect(
          intent.blind === "typed-data-commitment" || intent.blind === "typed-data-oversize",
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe("typed-data leaves agree with an independent EIP-712 hasher", () => {
  type Field = { name: string; type: string };
  type Doc = {
    types: Record<string, Field[]>;
    primaryType: string;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  };

  const hexOf = (b: Uint8Array): string =>
    `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const ARRAY = /^(.+)\[(\d*)\]$/;
  const INT = /^u?int([0-9]*)$/;

  const atomicType = fc.oneof(
    fc.constant("address"),
    fc.constant("bool"),
    fc.constant("string"),
    fc.constant("bytes"),
    fc.integer({ min: 1, max: 32 }).map((n) => `bytes${n}`),
    fc.integer({ min: 1, max: 32 }).map((n) => `uint${n * 8}`),
    fc.integer({ min: 1, max: 32 }).map((n) => `int${n * 8}`),
    fc.constant("uint256"),
    fc.constant("int256"),
  );

  const atomicValue = (type: string): fc.Arbitrary<unknown> => {
    if (type === "address") {
      return fc.uint8Array({ minLength: 20, maxLength: 20 }).map(hexOf);
    }
    if (type === "bool") {
      return fc.boolean();
    }
    if (type === "string") {
      return fc
        .string({
          maxLength: 96,
          unit: fc.integer({ min: 0x20, max: 0x7e }).map((n) => String.fromCodePoint(n)),
        })
        .map((s) => s.replaceAll(/^ +| +$/g, ""));
    }
    const fixed = /^bytes(\d+)$/.exec(type);
    if (type === "bytes" || fixed !== null) {
      const n = fixed === null ? undefined : Number(fixed[1]);
      return fc.uint8Array({ minLength: n ?? 0, maxLength: n ?? 40 }).map(hexOf);
    }
    const int = INT.exec(type);
    if (int !== null) {
      const bits = int[1] === "" ? 256 : Number(int[1]);
      const signed = !type.startsWith("u");
      const min = signed ? -(2n ** BigInt(bits - 1)) : 0n;
      const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
      return fc
        .tuple(fc.bigInt({ min, max }), fc.constantFrom("number", "decimal", "hex"))
        .map(([v, form]) =>
          form === "number" &&
          v <= BigInt(Number.MAX_SAFE_INTEGER) &&
          v >= -BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : form === "hex" && v >= 0n
              ? `0x${v.toString(16)}`
              : v.toString(10),
        );
    }
    throw new Error(`unexpected atomic type ${type}`);
  };

  const valueArb = (types: Record<string, Field[]>, type: string): fc.Arbitrary<unknown> => {
    const array = ARRAY.exec(type);
    if (array !== null) {
      const item = valueArb(types, array[1] ?? "");
      return array[2] === ""
        ? fc.array(item, { maxLength: 3 })
        : fc.tuple(...Array.from({ length: Number(array[2]) }, () => item)).map((v) => [...v]);
    }
    const struct = types[type];
    if (struct !== undefined) {
      return fc.record(Object.fromEntries(struct.map((f) => [f.name, valueArb(types, f.type)])));
    }
    return atomicValue(type);
  };

  const baseType = (defined: ReadonlyArray<string>): fc.Arbitrary<string> =>
    defined.length === 0
      ? atomicType
      : fc.oneof(
          { weight: 3, arbitrary: atomicType },
          { weight: 1, arbitrary: fc.constantFrom(...defined) },
        );

  const fieldType = (defined: ReadonlyArray<string>): fc.Arbitrary<string> =>
    fc.oneof(
      { weight: 4, arbitrary: baseType(defined) },
      {
        weight: 1,
        arbitrary: fc
          .tuple(
            baseType(defined),
            fc.oneof(
              fc.constant("[]"),
              fc.integer({ min: 1, max: 3 }).map((n) => `[${n}]`),
            ),
          )
          .map(([base, suffix]) => `${base}${suffix}`),
      },
    );

  const structArb = (name: string, defined: ReadonlyArray<string>) =>
    fc
      .array(fieldType(defined), { minLength: 1, maxLength: 4 })
      .map((types) => ({ name, fields: types.map((type, i) => ({ name: `f${i}`, type })) }));

  const docArb: fc.Arbitrary<Doc> = fc.integer({ min: 0, max: 2 }).chain((helpers) => {
    const build = (
      defined: ReadonlyArray<{ name: string; fields: Field[] }>,
      index: number,
    ): fc.Arbitrary<Doc> =>
      index < helpers
        ? structArb(
            `S${index}`,
            defined.map((d) => d.name),
          ).chain((d) => build([...defined, d], index + 1))
        : structArb(
            "Root",
            defined.map((d) => d.name),
          ).chain((root) => {
            const structs = [...defined, root];
            const types = Object.fromEntries(structs.map((d) => [d.name, d.fields])) as Record<
              string,
              Field[]
            >;
            return fc
              .record(Object.fromEntries(root.fields.map((f) => [f.name, valueArb(types, f.type)])))
              .map((message) => ({
                types: {
                  EIP712Domain: [{ name: "chainId", type: "uint256" }],
                  ...types,
                },
                primaryType: "Root",
                domain: { chainId: 1 },
                message,
              }));
          });
    return build([], 0);
  });

  /** The field list of every struct the document uses, parsed from eth-sig-util's own encoding. */
  const encodeTypeStructs = (doc: Doc): Map<string, Field[]> => {
    const encoded = TypedDataUtils.encodeType(doc.primaryType, doc.types);
    const map = new Map<string, Field[]>();
    for (const match of encoded.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\(([^)]*)\)/g)) {
      const body = match[2] ?? "";
      map.set(
        match[1] ?? "",
        body === ""
          ? []
          : body.split(",").map((part) => {
              const space = part.lastIndexOf(" ");
              return { type: part.slice(0, space), name: part.slice(space + 1) };
            }),
      );
    }
    return map;
  };

  /** Independent leaf expansion driven by the parsed field order. */
  const expand = (
    structs: Map<string, Field[]>,
    primaryType: string,
    message: Record<string, unknown>,
  ): Array<{ path: string; type: string }> => {
    const out: Array<{ path: string; type: string }> = [];
    const walk = (type: string, value: unknown, path: string): void => {
      const array = ARRAY.exec(type);
      if (array !== null) {
        const items = Array.isArray(value) ? value : [];
        if (items.length === 0) {
          out.push({ path, type });
          return;
        }
        for (const [i, item] of items.entries()) {
          walk(array[1] ?? "", item, `${path}[${i}]`);
        }
        return;
      }
      const struct = structs.get(type);
      if (struct !== undefined) {
        const object =
          typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
        for (const field of struct) {
          walk(field.type, object[field.name], path === "" ? field.name : `${path}.${field.name}`);
        }
        return;
      }
      out.push({ path, type });
    };
    walk(primaryType, message, "");
    return out;
  };

  const pathKeys = (path: string): ReadonlyArray<string | number> =>
    path.split(".").flatMap((part) => {
      const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
      const name = match?.[1] ?? part;
      const indices = [...(match?.[2] ?? "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      return [name, ...indices];
    });

  const convert = (type: string, shown: string): unknown => {
    if (type === "address" || type === "string") {
      return shown;
    }
    if (type === "bool") {
      return shown === "true";
    }
    if (type === "bytes" || /^bytes\d+$/.test(type)) {
      return shown;
    }
    if (INT.test(type)) {
      return BigInt(shown);
    }
    if (type.endsWith("]")) {
      return [];
    }
    throw new Error(`unexpected leaf type ${type}`);
  };

  const assign = (
    node: Record<string, unknown> | unknown[],
    keys: ReadonlyArray<string | number>,
    value: unknown,
  ): void => {
    for (const [i, key] of keys.slice(0, -1).entries()) {
      const existing: unknown = Array.isArray(node) ? node[Number(key)] : node[String(key)];
      let child = existing;
      if (typeof existing !== "object" || existing === null) {
        child = typeof keys[i + 1] === "number" ? [] : {};
        if (Array.isArray(node)) {
          node[Number(key)] = child;
        } else {
          node[String(key)] = child;
        }
      }
      node = child as Record<string, unknown> | unknown[];
    }
    const last = keys.at(-1) ?? "";
    if (Array.isArray(node)) {
      node[Number(last)] = value;
    } else {
      node[String(last)] = value;
    }
  };

  const defaultValue = (types: Record<string, Field[]>, type: string): unknown => {
    const array = ARRAY.exec(type);
    if (array !== null) {
      return [defaultValue(types, array[1] ?? "")];
    }
    const struct = types[type];
    if (struct !== undefined) {
      return Object.fromEntries(struct.map((f) => [f.name, defaultValue(types, f.type)]));
    }
    if (type === "address") {
      return "0x0000000000000000000000000000000000000001";
    }
    if (type === "bool") {
      return false;
    }
    if (type === "string") {
      return "x";
    }
    const fixed = /^bytes(\d+)$/.exec(type);
    if (fixed !== null) {
      return `0x${"00".repeat(Number(fixed[1]))}`;
    }
    if (type === "bytes") {
      return "0x00";
    }
    if (INT.test(type)) {
      return 1n;
    }
    throw new Error(`unexpected leaf type ${type}`);
  };

  /** A valid value different from the shown leaf, in the leaf's canonical form. */
  const mutate = (doc: Doc, type: string, shown: string): unknown => {
    const array = ARRAY.exec(type);
    if (array !== null) {
      return [defaultValue(doc.types, array[1] ?? "")];
    }
    if (type === "address") {
      const alt = "0x0000000000000000000000000000000000000001";
      return shown.toLowerCase() === alt ? "0x0000000000000000000000000000000000000002" : alt;
    }
    if (type === "bool") {
      return shown !== "true";
    }
    if (type === "string") {
      return `${shown}x`;
    }
    if (type === "bytes" || /^bytes\d+$/.test(type)) {
      return shown === "0x"
        ? "0x00"
        : `${shown.slice(0, 2)}${shown[2] === "0" ? "1" : "0"}${shown.slice(3)}`;
    }
    const int = INT.exec(type);
    if (int !== null) {
      const bits = int[1] === "" ? 256 : Number(int[1]);
      const signed = !type.startsWith("u");
      const max = signed ? 2n ** BigInt(bits - 1) - 1n : 2n ** BigInt(bits) - 1n;
      const v = BigInt(shown);
      return v < max ? v + 1n : v - 1n;
    }
    throw new Error(`unexpected leaf type ${type}`);
  };

  const buildMessage = (
    fields: ReadonlyArray<TypedDataLeaf>,
    leafTypes: ReadonlyArray<string>,
    overrides: ReadonlyMap<number, unknown>,
  ): Record<string, unknown> => {
    const root: Record<string, unknown> = {};
    for (const [i, leaf] of fields.entries()) {
      assign(
        root,
        pathKeys(leaf.path),
        overrides.get(i) ?? convert(leafTypes[i] ?? "", leaf.value),
      );
    }
    return root;
  };

  const hash = (doc: Doc): string =>
    Buffer.from(
      TypedDataUtils.eip712Hash(
        doc as unknown as TypedMessage<MessageTypes>,
        SignTypedDataVersion.V4,
      ),
    ).toString("hex");

  const checkDifferential = (doc: Doc): void => {
    const intent = decodeEvm(typed(doc), SIGNER);
    const fields = fieldsOf(intent) ?? [];
    fc.pre(fields.length > 0);
    const expanded = expand(encodeTypeStructs(doc), doc.primaryType, doc.message);
    const leafTypes = expanded.map((e) => e.type);
    expect(fields.map((f) => f.path)).toStrictEqual(expanded.map((e) => e.path));
    expect(hash({ ...doc, message: buildMessage(fields, leafTypes, new Map()) })).toBe(hash(doc));
    for (const [i, leaf] of fields.entries()) {
      const mutated = buildMessage(
        fields,
        leafTypes,
        new Map([[i, mutate(doc, leafTypes[i] ?? "", leaf.value)]]),
      );
      expect(hash({ ...doc, message: mutated })).not.toBe(hash(doc));
    }
  };

  it("leaf order, rebuilt hash and single-leaf mutations match the reference hasher", () => {
    expect.hasAssertions();
    fc.assert(fc.property(docArb, checkDifferential), { numRuns: 60 });
  });
});

describe("personal messages", () => {
  it("non-UTF-8 bytes are blind; text is not", () => {
    const hash32 = new Uint8Array(32).fill(0xab);
    const blind = decodeEvm(personal(hash32), SIGNER);
    expect(blind.message).toMatchObject({ kind: "bytes" });
    expect(blind.blind).toBe("message-bytes");
    expect(isBlindIntent(blind)).toBe(true);

    const text = decodeEvm(personal(new TextEncoder().encode("Welcome to Example")), SIGNER);
    expect(text.message).toMatchObject({ kind: "text" });
    expect(text.blind).toBeUndefined();
    expect(isBlindIntent(text)).toBe(false);
  });
});
