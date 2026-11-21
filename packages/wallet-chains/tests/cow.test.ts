import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { EVM_NATIVE_ASSET } from "../src/evm/assets.ts";
import { decodeEvm } from "../src/evm/index.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_MARKER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const RECEIVER = "0x00000000000000000000000000000000DeaDBeef";
const ZERO = "0x0000000000000000000000000000000000000000";
const table: EvmTokenTable = { "1": { [USDC]: { symbol: "USDC", decimals: 6 } } };

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const orderTypes = () => ({
  EIP712Domain: fields("string name, string version, uint256 chainId, address verifyingContract"),
  Order: fields(
    "address sellToken, address buyToken, address receiver, uint256 sellAmount, uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, string kind, bool partiallyFillable, string sellTokenBalance, string buyTokenBalance",
  ),
});

const order = (overrides: Record<string, unknown> = {}) => ({
  sellToken: USDC,
  buyToken: WETH,
  receiver: RECEIVER,
  sellAmount: "1000000",
  buyAmount: "500000000000000000",
  validTo: 2_000_000_000,
  appData: `0x${"00".repeat(32)}`,
  feeAmount: "1000",
  kind: "sell",
  partiallyFillable: false,
  sellTokenBalance: "erc20",
  buyTokenBalance: "erc20",
  ...overrides,
});

const doc = (
  domain: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
  types: Record<string, Field[]> = orderTypes(),
) => ({
  types,
  primaryType: "Order",
  domain: {
    name: "Gnosis Protocol",
    version: "v2",
    chainId: 1,
    verifyingContract: SETTLEMENT,
    ...domain,
  },
  message: order(message),
});

const decodeOn = (network: string, d: unknown) =>
  decodeEvm(
    { kind: "evm.typed-data", network, account: ACCOUNT, typedData: JSON.stringify(d) },
    SIGNER,
    table,
  );
const decode = (d: unknown) => decodeOn("eip155:1", d);

const orderOf = (d: unknown) => {
  const { message } = decode(d);
  return message?.kind === "typed-data" ? message.order : undefined;
};

describe("decodeEvm: CoW GPv2 orders", () => {
  it("a sell order is a swap giving sellAmount plus fee, receiving at least buyAmount", () => {
    const intent = decode(doc());
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("swap");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([]);
    const order = orderOf(doc());
    expect(order).toStrictEqual({
      protocol: "cow",
      maker: SIGNER,
      give: { asset: USDC, amount: "1001000", symbol: "USDC", decimals: 6 },
      receive: [{ recipient: RECEIVER, amount: { asset: WETH, amount: "500000000000000000" } }],
      expiry: 2_000_000_000,
      partialFill: false,
    });
  });

  it("a zero receiver means the maker; the buy ETH marker is the native asset", () => {
    const order = orderOf(
      doc({}, { receiver: ZERO, buyToken: ETH_MARKER, partiallyFillable: true }),
    );
    expect(order?.receive).toStrictEqual([
      {
        recipient: SIGNER,
        amount: {
          asset: EVM_NATIVE_ASSET,
          amount: "500000000000000000",
          decimals: 18,
          symbol: "ETH",
        },
      },
    ]);
    expect(order?.partialFill).toBe(true);
  });

  it("a buy order and every documented balance marker decode", () => {
    for (const sellTokenBalance of ["erc20", "external", "internal"]) {
      const order = orderOf(doc({}, { kind: "buy", sellTokenBalance }));
      expect(order?.protocol).toBe("cow");
    }
    const internal = orderOf(doc({}, { kind: "buy", buyTokenBalance: "internal" }));
    expect(internal?.protocol).toBe("cow");
  });

  it.each([
    ["an unknown kind", { kind: "swap" }],
    ["an unknown sellTokenBalance", { sellTokenBalance: "vault" }],
    ["an external buyTokenBalance", { buyTokenBalance: "external" }],
    ["partiallyFillable as a string", { partiallyFillable: "false" }],
    ["validTo above uint32", { validTo: "4294967296" }],
    ["sellAmount overflowing with the fee", { sellAmount: `${2n ** 256n - 1n}` }],
    ["a malformed sellToken", { sellToken: "0x1234" }],
    ["a zero sellToken", { sellToken: ZERO }],
    ["the native marker as sellToken", { sellToken: ETH_MARKER }],
    ["a zero buyToken", { buyToken: ZERO }],
  ])("%s is a near miss, not an order", (_name, message) => {
    expect(decode(doc({}, message)).blind).toBe("typed-data-variant");
    expect(orderOf(doc({}, message))).toBeUndefined();
  });

  it.each([
    ["a wrong version", { version: "v3" }],
    ["a wrong domain name", { name: "CowSwap" }],
    ["a chainId the message does not sign", { chainId: 10 }],
    [
      "a missing verifyingContract",
      { verifyingContract: "0x0000000000000000000000000000000000000001" },
    ],
  ])("%s is a near miss", (_name, domain) => {
    expect(decode(doc(domain)).blind).toBe("typed-data-variant");
  });

  it("an order on an unverified chain is a near miss", () => {
    const intent = decodeOn("eip155:999", doc({ chainId: 999 }));
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an extra type or Order field is a near miss", () => {
    const extraType = {
      ...doc(),
      types: { ...orderTypes(), Extra: fields("uint256 a") },
    };
    expect(decode(extraType).blind).toBe("typed-data-variant");
    const extraField = {
      ...doc(),
      types: {
        ...orderTypes(),
        Order: [...orderTypes().Order, { name: "extra", type: "uint256" }],
      },
      message: { ...order(), extra: "1" },
    };
    expect(decode(extraField).blind).toBe("typed-data-variant");
  });

  it("the claim works either way around: name at another contract, or the settlement under another name", () => {
    expect(
      decode(doc({ verifyingContract: "0x0000000000000000000000000000000000000001" })).blind,
    ).toBe("typed-data-variant");
    const renamed = doc({ name: "Not Gnosis" });
    const intent = decode(renamed);
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("the canonical document hashes identically under two independent EIP-712 hashers", () => {
    const d = doc();
    const reference = `0x${Buffer.from(
      TypedDataUtils.eip712Hash(
        d as unknown as TypedMessage<MessageTypes>,
        SignTypedDataVersion.V4,
      ),
    ).toString("hex")}`;
    const ours = hashTypedData({
      domain: {
        ...d.domain,
        verifyingContract: d.domain.verifyingContract as `0x${string}`,
      },
      types: d.types,
      primaryType: "Order",
      message: d.message,
    });
    expect(ours).toBe(reference);
  });
});
