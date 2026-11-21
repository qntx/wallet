// oxlint-disable eslint/no-bitwise, oxc/bad-bitwise-operator -- makerTraits flags are built
// with explicit bit shifts

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";
const ZKSYNC_ROUTER = "0x6fd4383cB451173D5f9304F041C7BCBf27d561fF";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const RECEIVER = "0x00000000000000000000000000000000DeaDBeef";
const ZERO = "0x0000000000000000000000000000000000000000";
const table: EvmTokenTable = { "1": { [USDC]: { symbol: "USDC", decimals: 6 } } };

/* MakerTraitsLib bit positions (refs/1inch-lop-4.0.0/contracts/libraries/MakerTraitsLib.sol). */
const NO_PARTIAL_FILLS = 1n << 255n;
const ALLOW_MULTIPLE_FILLS = 1n << 254n;
const NEED_CHECK_EPOCH_MANAGER = 1n << 250n;
const HAS_EXTENSION = 1n << 249n;
const USE_PERMIT2 = 1n << 248n;
const UNWRAP_WETH = 1n << 247n;
const PRE_INTERACTION_CALL = 1n << 252n;
const POST_INTERACTION_CALL = 1n << 251n;
const SPARE = 1n << 253n;
const UNDEFINED_LOW = 1n << 200n;
const UNDEFINED_HIGH = 1n << 246n;
const expiration = (seconds: bigint) => seconds << 80n;
const allowedSender = (low80: bigint) => low80;

const orderFields = [
  "uint256 salt",
  "address maker",
  "address receiver",
  "address makerAsset",
  "address takerAsset",
  "uint256 makingAmount",
  "uint256 takingAmount",
  "uint256 makerTraits",
].map((part) => {
  const [type, name] = part.split(" ");
  return { type: type ?? "", name: name ?? "" };
});

const doc = (overrides: Record<string, unknown> = {}, domain: Record<string, unknown> = {}) => ({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: orderFields,
  },
  primaryType: "Order",
  domain: {
    name: "1inch Aggregation Router",
    version: "6",
    chainId: 1,
    verifyingContract: ROUTER,
    ...domain,
  },
  message: {
    salt: "0",
    maker: SIGNER,
    receiver: RECEIVER,
    makerAsset: USDC,
    takerAsset: WETH,
    makingAmount: "1000000",
    takingAmount: "500000000000000000",
    makerTraits: "0",
    ...overrides,
  },
});

const decode = (d: unknown) =>
  decodeEvm(
    { kind: "evm.typed-data", network: "eip155:1", account: ACCOUNT, typedData: JSON.stringify(d) },
    SIGNER,
    table,
  );
const orderOf = (d: unknown) => {
  const { message } = decode(d);
  return message?.kind === "typed-data" ? message.order : undefined;
};

describe("decodeEvm: 1inch LOP v4 orders at Aggregation Router v6", () => {
  it("a plain order decodes as a swap", () => {
    const intent = decode(doc());
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("swap");
    expect(intent.verifiability).toBe("partial");
    expect(orderOf(doc())).toStrictEqual({
      protocol: "1inch",
      maker: SIGNER,
      give: { asset: USDC, amount: "1000000", symbol: "USDC", decimals: 6 },
      receive: [
        {
          recipient: RECEIVER,
          amount: { asset: WETH, amount: "500000000000000000" },
        },
      ],
      partialFill: true,
    });
  });

  it("a zero receiver means the maker; expiry, allowed sender and fill flags come from makerTraits", () => {
    const order = orderOf(
      doc({
        receiver: ZERO,
        makerTraits: (
          NO_PARTIAL_FILLS |
          expiration(2_000_000_000n) |
          allowedSender(0x11111111111111111111n)
        ).toString(),
      }),
    );
    expect(order?.receive[0]?.recipient).toBe(SIGNER);
    expect(order?.expiry).toBe(2_000_000_000);
    expect(order?.partialFill).toBe(false);
    expect(order?.allowedSender).toBe("0x11111111111111111111");
  });

  it("fill-shape flags that keep the bounds decode", () => {
    const order = orderOf(
      doc({
        makerTraits: (ALLOW_MULTIPLE_FILLS | NEED_CHECK_EPOCH_MANAGER | USE_PERMIT2).toString(),
      }),
    );
    expect(order?.protocol).toBe("1inch");
  });

  it.each([
    ["HAS_EXTENSION", HAS_EXTENSION],
    ["PRE_INTERACTION_CALL", PRE_INTERACTION_CALL],
    ["POST_INTERACTION_CALL", POST_INTERACTION_CALL],
    ["UNWRAP_WETH", UNWRAP_WETH],
    ["the spare bit 253", SPARE],
    ["the lowest undefined bit 200", UNDEFINED_LOW],
    ["the highest undefined bit 246", UNDEFINED_HIGH],
  ])("an order with %s set is a near miss", (_name, flag) => {
    const intent = decode(doc({ salt: `0x${"ab".repeat(32)}`, makerTraits: flag.toString() }));
    expect(intent.blind).toBe("typed-data-variant");
    expect(orderOf(doc({ makerTraits: flag.toString() }))).toBeUndefined();
  });

  it.each([
    ["version 4", { version: "4" }],
    ["the standalone LOP domain name", { name: "1inch Limit Order Protocol" }],
    ["the zkSync router on mainnet", { verifyingContract: ZKSYNC_ROUTER }],
    ["a chainId the message does not sign", { chainId: 10 }],
  ])("a domain with %s is a near miss", (_name, domain) => {
    expect(decode(doc({}, domain)).blind).toBe("typed-data-variant");
  });

  it("an order on an unverified chain is a near miss", () => {
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:999",
        account: ACCOUNT,
        typedData: JSON.stringify(doc({}, { chainId: 999 })),
      },
      SIGNER,
      table,
    );
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an extra Order field or an extra type is a near miss", () => {
    const extraField = {
      ...doc(),
      types: {
        ...doc().types,
        Order: [...orderFields, { name: "extra", type: "uint256" }],
      },
      message: { ...doc().message, extra: "1" },
    };
    expect(decode(extraField).blind).toBe("typed-data-variant");
    const extraType = { ...doc(), types: { ...doc().types, Extra: orderFields } };
    expect(decode(extraType).blind).toBe("typed-data-variant");
  });

  it("a v5-router document is claimed by contract and blind as a variant", () => {
    const v5 = doc(
      {},
      {
        name: "1inch Aggregation Router",
        version: "5",
        verifyingContract: "0x1111111254EEB25477B68fb85Ed929f73A960582",
      },
    );
    expect(decode(v5).blind).toBe("typed-data-variant");
  });
});
