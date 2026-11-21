import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import { hexToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import * as fc from "fast-check";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { describe, expect, it } from "vite-plus/test";

import {
  PERMIT2_ADDRESS,
  checksumEvmAddress,
  decodeBatchExecute,
  decodeEvm,
  encodeBatchExecute,
  evmTokenTable,
  isEvmAddress,
  lookupEvmToken,
} from "../src/evm/index.ts";
import { SEAPORT_CONTRACTS } from "../src/evm/seaport.ts";
import { RECOGNISED_FAMILIES } from "../src/families.ts";
import type { FamilyClaim } from "../src/families.ts";
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

const orderOf = (intent: ReturnType<typeof decodeEvm>) =>
  intent.message?.kind === "typed-data" ? intent.message.order : undefined;

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

  /* The CoW decoder claims the GPv2 order: its appData hash is a commitment the family names,
     so the order is described as a swap rather than blind as a commitment. */
  it("a CoW GPv2 order decodes as a swap order", () => {
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
    expect(intent.verifiability).toBe("partial");
    expect(intent.blind).toBeUndefined();
    expect(isBlindIntent(intent)).toBe(false);
    expect(orderOf(intent)).toStrictEqual({
      protocol: "cow",
      maker: SIGNER,
      give: {
        asset: checksumEvmAddress(USDC),
        amount: "1000000",
        symbol: "USDC",
        decimals: 6,
      },
      receive: [
        {
          recipient: checksumEvmAddress(SIGNER),
          amount: { asset: checksumEvmAddress(WETH), amount: "1" },
        },
      ],
      expiry: 2_000_000_000,
      partialFill: false,
    });
    expect(fieldsOf(intent)).toBeUndefined();
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
    /* bytesN is a commitment leaf — the document is blind, but the leaves still display
       in canonical form. */
    expect(intent.blind).toBe("typed-data-commitment");
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
    /* The bytes leaf is a commitment and blinds the document; the leaves still show. */
    expect(intent.blind).toBe("typed-data-commitment");
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
    domain?: Record<string, unknown>,
  ) => ({
    types: { EIP712Domain: [{ name: "chainId", type: "uint256" }], ...types },
    primaryType,
    domain: domain ?? { chainId: 1 },
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

  it("a string leaf encoding 32 bytes is a commitment; real text is not", () => {
    const digest = new Uint8Array(32).fill(0xab);
    const strings = [
      RAW_HASH,
      `0X${"ab".repeat(32)}`,
      "ab".repeat(32),
      `0x${"ab".repeat(32)}a`,
      Array.from({ length: 32 }, () => "ab").join(" "),
      Array.from({ length: 32 }, () => "ab").join(":"),
      base64.encode(digest),
      base58.encode(digest),
    ];
    for (const s of strings) {
      const intent = decodeEvm(
        typed(doc("Root", { s }, { Root: [{ name: "s", type: "string" }] })),
        SIGNER,
      );
      expect(intent.blind).toBe("typed-data-commitment");
    }
    /* A two-line encoding cannot be shown on one field line, so the document blinds as
       unshowable rather than as a commitment — still blind either way. */
    const multiline = decodeEvm(
      typed(
        doc(
          "Root",
          { s: `${"ab".repeat(16)}\n${"ab".repeat(16)}` },
          { Root: [{ name: "s", type: "string" }] },
        ),
      ),
      SIGNER,
    );
    expect(multiline.blind).toBe("typed-data-oversize");
    expect(isBlindIntent(multiline)).toBe(true);
    for (const s of ["hello", `0x${"ab".repeat(20)}`, `nonce ${"ab".repeat(16)} ok`]) {
      const intent = decodeEvm(
        typed(doc("Root", { s }, { Root: [{ name: "s", type: "string" }] })),
        SIGNER,
      );
      expect(intent.blind).toBeUndefined();
      expect(isBlindIntent(intent)).toBe(false);
    }
  });

  /* Any commitment leaf blinds the document, readable neighbours or not: nothing bounds what the
     hash or bytes commit the signature to. */
  it.each([
    [
      "Msg(bytes32 hash, uint256 nonce)",
      doc(
        "Msg",
        { hash: RAW_HASH, nonce: "0" },
        {
          Msg: [
            { name: "hash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
          ],
        },
      ),
    ],
    [
      "Msg(address account, bytes32 hash)",
      doc(
        "Msg",
        { account: SIGNER, hash: RAW_HASH },
        {
          Msg: [
            { name: "account", type: "address" },
            { name: "hash", type: "bytes32" },
          ],
        },
      ),
    ],
    [
      "a nested struct pairing a commitment with a readable leaf",
      doc(
        "Outer",
        { inner: { digest: RAW_HASH }, tag: "ok" },
        {
          Outer: [
            { name: "inner", type: "Inner" },
            { name: "tag", type: "string" },
          ],
          Inner: [{ name: "digest", type: "bytes32" }],
        },
      ),
    ],
    [
      "a commitment split into two 31-byte hex string leaves",
      doc(
        "Msg",
        { a: `0x${"ab".repeat(31)}`, b: `0x${"cd".repeat(31)}` },
        {
          Msg: [
            { name: "a", type: "string" },
            { name: "b", type: "string" },
          ],
        },
      ),
    ],
  ])("%s is blind as a commitment", (_name, document) => {
    const intent = decodeEvm(typed(document), SIGNER);
    expect(intent.blind).toBe("typed-data-commitment");
    expect(isBlindIntent(intent)).toBe(true);
  });

  it("an empty bytes leaf is not a commitment; the document stays described", () => {
    const intent = decodeEvm(
      typed(
        doc(
          "Root",
          { data: "0x", amount: "7" },
          {
            Root: [
              { name: "data", type: "bytes" },
              { name: "amount", type: "uint256" },
            ],
          },
        ),
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
  });

  const hexOf = (b: Uint8Array): string =>
    `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const leafType = fc.oneof(
    fc.constant("bytes"),
    fc.integer({ min: 1, max: 32 }).map((n) => `bytes${n}`),
  );
  const leafValue = (type: string): fc.Arbitrary<string> =>
    type === "bytes"
      ? fc.uint8Array({ minLength: 1, maxLength: 40 }).map(hexOf)
      : fc
          .uint8Array({ minLength: Number(type.slice(5)), maxLength: Number(type.slice(5)) })
          .map(hexOf);
  const leaf = (name: string): fc.Arbitrary<Field & { value: unknown }> =>
    fc
      .tuple(leafType, fc.boolean())
      .chain(([type, isArray]) =>
        (isArray ? fc.array(leafValue(type), { minLength: 1, maxLength: 2 }) : leafValue(type)).map(
          (value) => ({ name, type: isArray ? `${type}[]` : type, value }),
        ),
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
        expect(intent.blind).toMatch(/^typed-data-(commitment|oversize)$/);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Snapshot Vote documents are recognised", () => {
  const VOTE_PREFIX: ReadonlyArray<{ name: string; type: string }> = [
    { name: "from", type: "string" },
    { name: "space", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "proposal", type: "string" },
  ];
  const VOTE_TAIL: ReadonlyArray<{ name: string; type: string }> = [
    { name: "reason", type: "string" },
    { name: "app", type: "string" },
    { name: "metadata", type: "string" },
  ];
  const voteDoc = (choice: { name: string; type: string }, value: unknown) => ({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
      ],
      Vote: [...VOTE_PREFIX, choice, ...VOTE_TAIL],
    },
    primaryType: "Vote",
    domain: { name: "snapshot", version: "0.1.4" },
    message: {
      from: SIGNER,
      space: "example.eth",
      timestamp: "1700000000",
      proposal: `0x${"ab".repeat(32)}`,
      choice: value,
      reason: "",
      app: "snapshot",
      metadata: "{}",
    },
  });

  it.each([
    ["uint32 choice", { name: "choice", type: "uint32" }, 1],
    ["uint32[] choice", { name: "choice", type: "uint32[]" }, [1, 2]],
    ["string choice", { name: "choice", type: "string" }, "1"],
  ])("a vote with %s is described, encoded proposal and all", (_n, choice, value) => {
    const intent = decodeEvm(typed(voteDoc(choice, value)), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(isBlindIntent(intent)).toBe(false);
    expect(fieldsOf(intent)?.map((leaf) => leaf.path)).toContain("proposal");
  });

  it("a Vote field list outside the three snapshot.js shapes is a variant", () => {
    const document = voteDoc({ name: "choice", type: "uint32" }, 1);
    const intent = decodeEvm(
      typed({
        ...document,
        types: {
          ...document.types,
          Vote: [...document.types.Vote, { name: "extra", type: "uint256" }],
        },
        message: { ...document.message, extra: "1" },
      }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a Vote with a third declared type is a variant", () => {
    const document = voteDoc({ name: "choice", type: "uint32" }, 1);
    const intent = decodeEvm(
      typed({
        ...document,
        types: {
          ...document.types,
          Extra: [{ name: "x", type: "uint256" }],
        },
      }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a Vote outside the snapshot domain is generic, and its hash leaf blinds it", () => {
    const document = voteDoc({ name: "choice", type: "uint32" }, 1);
    const intent = decodeEvm(
      typed({ ...document, domain: { name: "other", version: "0.1.4" } }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-commitment");
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
  const personalText = (text: string) =>
    decodeEvm(personal(new TextEncoder().encode(text)), SIGNER);

  it("non-UTF-8 bytes are blind; text is not", () => {
    const hash32 = new Uint8Array(33).fill(0xab);
    const blind = decodeEvm(personal(hash32), SIGNER);
    expect(blind.message).toMatchObject({ kind: "bytes" });
    expect(blind.blind).toBe("message-bytes");
    expect(isBlindIntent(blind)).toBe(true);

    const text = personalText("Welcome to Example");
    expect(text.message).toMatchObject({ kind: "text" });
    expect(text.blind).toBeUndefined();
    expect(isBlindIntent(text)).toBe(false);
  });

  it("a message of exactly 32 bytes is blind text, whatever its content", () => {
    /* A keccak digest that happens to be valid UTF-8. */
    const digest = hexToBytes("5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79");
    const ground = decodeEvm(personal(digest), SIGNER);
    expect(ground.message).toMatchObject({ kind: "text" });
    expect(ground.blind).toBe("message-bytes");

    const text32 = personalText("a".repeat(32));
    expect(text32.message).toMatchObject({ kind: "text" });
    expect(text32.blind).toBe("message-bytes");
    for (const n of [31, 33]) {
      const intent = personalText("a".repeat(n));
      expect(intent.message).toMatchObject({ kind: "text" });
      expect(intent.blind).toBeUndefined();
    }
  });

  it("text with a hidden code point is blind text; format characters and whitespace are not", () => {
    for (const char of ["\u0000", "\u202E", "\u200B"]) {
      const intent = personalText(`see ${char} this`);
      expect(intent.message).toMatchObject({ kind: "text" });
      expect(intent.blind).toBe("message-bytes");
    }
    const ws = personalText("line one\nline two\r\n\tindented");
    expect(ws.message).toMatchObject({ kind: "text" });
    expect(ws.blind).toBeUndefined();
    const joiner = personalText("Sign in 👨‍💻");
    expect(joiner.message).toMatchObject({ kind: "text" });
    expect(joiner.blind).toBeUndefined();
  });

  it("text that only renders bytes is blind; an address written as text is not", () => {
    for (const text of [
      `0x${"ab".repeat(32)}`,
      "ab".repeat(32),
      `0x${"AB".repeat(32)}`,
      `0X${"ab".repeat(32)}`,
      `0x${"ab".repeat(32)}a`,
      Array.from({ length: 32 }, () => "ab").join(":"),
    ]) {
      const intent = personalText(text);
      expect(intent.message).toMatchObject({ kind: "text" });
      expect(intent.blind).toBe("message-bytes");
    }
    const address = personalText(`0x${"ab".repeat(20)}`);
    expect(address.blind).toBeUndefined();
  });
});

describe("typed-data near misses of decoded families are blind", () => {
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";

  /** A doc with exactly the domain keys `domain` declares. */
  const simpleDoc = (
    primaryType: string,
    fields: ReadonlyArray<{ name: string; type: string }>,
    domain: Record<string, unknown>,
    message: Record<string, unknown>,
  ): SignRequest => {
    const domainKeys = [
      ["name", "string"],
      ["version", "string"],
      ["chainId", "uint256"],
      ["verifyingContract", "address"],
    ] as const;
    const types = {
      EIP712Domain: domainKeys
        .filter(([name]) => name in domain)
        .map(([name, type]) => ({ name, type })),
      [primaryType]: fields,
    };
    return typed({ types, primaryType, domain, message });
  };

  /* The pre-1.3.0 Safe schema uses `dataGas`/`gasPrice` where 1.3.0 uses `baseGas`/`gasPrice`. */
  const SAFE_TX_LEGACY = [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "dataGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ];
  /* The 1.3.0 schema — `baseGas` where the legacy form has `dataGas`. */
  const SAFE_TX = [
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
  ];
  const safeTxMessage = {
    to: OTHER,
    value: "0",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    dataGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: "42",
  };

  it("a SafeTx-shaped document in the legacy dataGas form is blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "SafeTx",
        SAFE_TX_LEGACY,
        { chainId: 1, verifyingContract: OTHER },
        { ...safeTxMessage, operation: 1 },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
    expect(fieldsOf(intent)?.length).toBeGreaterThan(0);
  });

  it("the same document in the canonical schema decodes to a blind delegatecall", () => {
    const intent = decodeEvm(
      simpleDoc(
        "SafeTx",
        SAFE_TX,
        { chainId: 1, verifyingContract: OTHER },
        { ...safeTxMessage, baseGas: "0", operation: 1 },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("safe-delegatecall");
  });

  it("a SafeTx with an operation beyond delegatecall is blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "SafeTx",
        SAFE_TX,
        { chainId: 1, verifyingContract: OTHER },
        { ...safeTxMessage, baseGas: "0", operation: 2 },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a SafeTx whose domain names no verifying contract is blind", () => {
    const intent = decodeEvm(
      simpleDoc("SafeTx", SAFE_TX, { chainId: 1 }, { ...safeTxMessage, baseGas: "0" }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it.each([["TransferWithAuthorization"], ["ReceiveWithAuthorization"]])(
    "an EIP-3009 %s on a table token is blind",
    (primaryType) => {
      const intent = decodeEvm(
        simpleDoc(
          primaryType,
          [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
          { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
          {
            from: SIGNER,
            to: OTHER,
            value: "1000000",
            validAfter: "0",
            validBefore: "2000000000",
            nonce: `0x${"42".repeat(32)}`,
          },
        ),
        SIGNER,
      );
      expect(intent.blind).toBe("typed-data-variant");
    },
  );

  it("the same authorization shape on a non-table token stays described", () => {
    const intent = decodeEvm(
      simpleDoc(
        "TransferWithAuthorization",
        [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
        ],
        { name: "Some Token", version: "1", chainId: 1, verifyingContract: OTHER },
        { from: SIGNER, to: OTHER, value: "1" },
      ),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)?.length).toBeGreaterThan(0);
  });

  it("a canonical Permit on a non-table token is recognised, not variant-blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "Permit",
        [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
        { name: "Some Token", version: "1", chainId: 1, verifyingContract: OTHER },
        { owner: SIGNER, spender: OTHER, value: "1", nonce: "0", deadline: "2000000000" },
      ),
      SIGNER,
    );
    expect(intent.blind).not.toBe("typed-data-variant");
  });

  it("a Permit-family document in a non-canonical form is blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "Permit",
        [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "bytes32" },
        ],
        { name: "Some Token", version: "1", chainId: 1, verifyingContract: OTHER },
        {
          owner: SIGNER,
          spender: OTHER,
          value: "1",
          nonce: "0",
          deadline: "2000000000",
          witness: `0x${"42".repeat(32)}`,
        },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an ERC-4494 Permit on a non-table contract is blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "Permit",
        [
          { name: "spender", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
        { name: "Some Token", version: "1", chainId: 1, verifyingContract: OTHER },
        { spender: OTHER, tokenId: "1", nonce: "0", deadline: "2000000000" },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a Permit2-addressed document of an unknown primary type is blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "Foo",
        [{ name: "x", type: "uint256" }],
        { chainId: 1, verifyingContract: PERMIT2 },
        { x: "1" },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a Seaport-addressed document of another primary type is blind", () => {
    const intent = decodeEvm(
      simpleDoc(
        "Foo",
        [{ name: "x", type: "uint256" }],
        { chainId: 1, verifyingContract: SEAPORT_16 },
        { x: "1" },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  /* Canonical Seaport 1.6 `OrderComponents` — the nested item types recognition requires. */
  const SEAPORT_ITEM = [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ];
  const seaportDoc = (message: Record<string, unknown>): SignRequest =>
    typed({
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
        OfferItem: SEAPORT_ITEM,
        ConsiderationItem: [...SEAPORT_ITEM, { name: "recipient", type: "address" }],
      },
      primaryType: "OrderComponents",
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: SEAPORT_16,
      },
      message: {
        offerer: SIGNER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: [],
        consideration: [],
        orderType: 0,
        startTime: "1700000000",
        endTime: "1700001000",
        zoneHash: `0x${"00".repeat(32)}`,
        salt: "123",
        conduitKey: `0x${"00".repeat(32)}`,
        counter: "0",
        ...message,
      },
    });

  it("a Seaport order item of an unknown itemType is blind", () => {
    const intent = decodeEvm(
      seaportDoc({
        offer: [
          {
            itemType: 6,
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
      }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a BulkOrder primary type is blind", () => {
    const intent = decodeEvm(
      simpleDoc("BulkOrder", [{ name: "x", type: "uint256" }], { chainId: 1 }, { x: "1" }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  /** A representative near-miss request for an evm row's claim surface. */
  const nearMissRequest = (claim: FamilyClaim): SignRequest => {
    if (claim.surface === "evm.call") {
      return tx(USDC, "0xdeadbeef");
    }
    if (claim.surface === "evm.typed-data" && "domainName" in claim) {
      const pattern = "primaryType" in claim ? claim.primaryType : undefined;
      const primaryType =
        pattern === undefined
          ? "Foo"
          : (
              {
                "^Agent$": "Agent",
                "^Vote$": "Vote",
              } as Record<string, string | undefined>
            )[pattern.source];
      if (primaryType === undefined) {
        throw new Error(`no near-miss fixture for ${pattern}`);
      }
      return simpleDoc(
        primaryType,
        [{ name: "x", type: "uint256" }],
        { name: claim.domainName, chainId: 1 },
        { x: "1" },
      );
    }
    if (claim.surface === "evm.typed-data" && "primaryType" in claim) {
      const primaryType = (
        {
          "^Permit": "PermitXYZ",
          "^SafeTx$": "SafeTx",
          "^(?:OrderComponents|BulkOrder)$": "BulkOrder",
        } as Record<string, string | undefined>
      )[claim.primaryType.source];
      if (primaryType === undefined) {
        throw new Error(`no near-miss fixture for ${claim.primaryType}`);
      }
      return simpleDoc(primaryType, [{ name: "x", type: "uint256" }], { chainId: 1 }, { x: "1" });
    }
    if (claim.surface === "evm.typed-data") {
      const verifyingContract =
        claim.verifyingContract === "permit2"
          ? PERMIT2
          : claim.verifyingContract === "seaport"
            ? SEAPORT_16
            : USDC;
      return simpleDoc(
        "Foo",
        [{ name: "x", type: "uint256" }],
        { chainId: 1, verifyingContract },
        { x: "1" },
      );
    }
    throw new Error(`no near-miss fixture for surface ${claim.surface}`);
  };

  /** The claim check `decodeEvm` runs row by row, evaluated for one request. */
  const claimsFixture = (request: SignRequest, claim: FamilyClaim): boolean => {
    if (claim.surface === "evm.call") {
      return (
        request.kind === "evm.transaction" &&
        request.tx.to !== undefined &&
        lookupEvmToken(evmTokenTable, request.tx.chainId, request.tx.to) !== undefined
      );
    }
    if (claim.surface !== "evm.typed-data" || request.kind !== "evm.typed-data") {
      return false;
    }
    const { primaryType, domain } = JSON.parse(request.typedData) as {
      primaryType: string;
      domain: Record<string, unknown>;
    };
    /* Contracts claims match on the domain name OR a verifying contract in the set — the same
       interpretation as typedDataNearMiss. */
    if ("contracts" in claim) {
      const contract = domain["verifyingContract"];
      return (
        domain["name"] === claim.domainName ||
        (typeof contract === "string" &&
          claim.contracts.some((a) => a.toLowerCase() === contract.toLowerCase()))
      );
    }
    if ("domainName" in claim) {
      return (
        domain["name"] === claim.domainName &&
        (claim.primaryType === undefined || claim.primaryType.test(primaryType))
      );
    }
    if ("primaryType" in claim) {
      return claim.primaryType.test(primaryType);
    }
    const contract = domain["verifyingContract"];
    if (typeof contract !== "string" || !isEvmAddress(contract)) {
      return false;
    }
    const chainId = Number(request.network.split(":")[1] ?? 1);
    const lower = contract.toLowerCase();
    return (
      (claim.verifyingContract === "permit2" && lower === PERMIT2_ADDRESS.toLowerCase()) ||
      (claim.verifyingContract === "seaport" && SEAPORT_CONTRACTS.has(lower)) ||
      (claim.verifyingContract === "token-table" &&
        lookupEvmToken(evmTokenTable, chainId, checksumEvmAddress(contract)) !== undefined)
    );
  };

  it("every evm family row blinds a representative near miss", () => {
    const rows = RECOGNISED_FAMILIES.filter((r) => r.claim.surface.startsWith("evm"));
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      const request = nearMissRequest(row.claim);
      // A fixture claimed by another row would prove nothing about this one.
      for (const other of rows.filter((r) => r !== row)) {
        expect(claimsFixture(request, other.claim)).toBe(false);
      }
      expect(decodeEvm(request, SIGNER).blind).toBe(row.nearMiss);
    }
  });

  it("a variant without showable fields is still variant-blind", () => {
    const huge = `0x${"ab".repeat(4000)}`;
    const intent = decodeEvm(
      simpleDoc(
        "Foo",
        [{ name: "blob", type: "bytes" }],
        { chainId: 1, verifyingContract: PERMIT2 },
        { blob: huge },
      ),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });
});

describe("only hashed domain fields reach display and recognition", () => {
  const PERMIT = [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ];
  const permitMessage = {
    owner: SIGNER,
    spender: OTHER,
    value: "1",
    nonce: "0",
    deadline: "2000000000",
  };

  it("undeclared domain keys are dropped from the display domain", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
          ],
          Mail: [{ name: "x", type: "uint256" }],
        },
        primaryType: "Mail",
        domain: {
          name: "dApp",
          version: "1",
          chainId: 1,
          verifyingContract: USDC,
          salt: `0x${"00".repeat(32)}`,
          extra: "ignored",
        },
        message: { x: "1" },
      }),
      SIGNER,
    );
    expect(intent.message?.kind).toBe("typed-data");
    expect(intent.message).toHaveProperty("domain", { name: "dApp", version: "1" });
  });

  it("a Permit whose verifyingContract is not hashed is not recognised", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          Permit: PERMIT,
        },
        primaryType: "Permit",
        domain: { name: "Some Token", version: "1", chainId: 1, verifyingContract: USDC },
        message: permitMessage,
      }),
      SIGNER,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("the same Permit is recognised when verifyingContract is declared", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Permit: PERMIT,
        },
        primaryType: "Permit",
        domain: { name: "Some Token", version: "1", chainId: 1, verifyingContract: OTHER },
        message: permitMessage,
      }),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
    expect(intent.approvals.length).toBeGreaterThan(0);
  });
});
