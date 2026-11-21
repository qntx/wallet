// oxlint-disable eslint/no-bitwise -- makerTraits flags are built
// with explicit bit shifts
/**
 * Executed confirmations of sound bound handling: which 1inch makerTraits bits still decode vs
 * blind the order, which amount of a decaying UniswapX curve is the displayed bound, and that a CoW
 * internal-balance order exposes no balance field in `message.order`.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm, PERMIT2_ADDRESS } from "../../src/evm/index.ts";
import type { EvmTokenTable } from "../../src/evm/tokens.ts";
import type { SignRequest } from "../../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const ROUTER_1INCH = "0x111111125421cA6dc452d289314280a0f8842A65";
const EXCLUSIVE_REACTOR = "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4";
const V3_REACTOR = "0x0000000015757c461808EA25Eb309638B62681cf";
const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const RECEIVER = "0x00000000000000000000000000000000DeaDBeef";
const ZERO = "0x0000000000000000000000000000000000000000";
const table: EvmTokenTable = { "1": { [USDC]: { symbol: "USDC", decimals: 6 } } };

const ALLOW_MULTIPLE_FILLS = 1n << 254n;
const USE_PERMIT2 = 1n << 248n;

const decode = (doc: unknown) =>
  decodeEvm(
    {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: ACCOUNT,
      typedData: JSON.stringify(doc),
    } satisfies SignRequest,
    SIGNER,
    table,
  );
const orderOf = (doc: unknown) => {
  const { message } = decode(doc);
  return message?.kind === "typed-data" ? message.order : undefined;
};

const inchDoc = (makerTraits: bigint) => ({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: [
      { name: "salt", type: "uint256" },
      { name: "maker", type: "address" },
      { name: "receiver", type: "address" },
      { name: "makerAsset", type: "address" },
      { name: "takerAsset", type: "address" },
      { name: "makingAmount", type: "uint256" },
      { name: "takingAmount", type: "uint256" },
      { name: "makerTraits", type: "uint256" },
    ],
  },
  primaryType: "Order",
  domain: {
    name: "1inch Aggregation Router",
    version: "6",
    chainId: 1,
    verifyingContract: ROUTER_1INCH,
  },
  message: {
    salt: "0",
    maker: SIGNER,
    receiver: RECEIVER,
    makerAsset: USDC,
    takerAsset: WETH,
    makingAmount: "1000000",
    takingAmount: "500000000000000000",
    makerTraits: makerTraits.toString(),
  },
});

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });
const INFO =
  "address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData";
const DUTCH_OUTPUT = "address token,uint256 startAmount,uint256 endAmount,address recipient";

const orderTypes = (witness: string, extra: Record<string, Field[]>) => ({
  EIP712Domain: fields("string name,uint256 chainId,address verifyingContract"),
  TokenPermissions: fields("address token,uint256 amount"),
  PermitWitnessTransferFrom: [
    ...fields("TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline"),
    { name: "witness", type: witness },
  ],
  OrderInfo: fields(INFO),
  ...extra,
});

const info = (reactor: string) => ({
  reactor,
  swapper: SIGNER,
  nonce: "0",
  deadline: "2000000000",
  additionalValidationContract: ZERO,
  additionalValidationData: "0x",
});

const permitDoc = (
  types: Record<string, Field[]>,
  witness: Record<string, unknown>,
  spender: string,
) => ({
  types,
  primaryType: "PermitWitnessTransferFrom",
  domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS },
  message: {
    /* Well above every order bound in this file so the clamp stays on the witness side. */
    permitted: { token: WETH, amount: "100000000000000000000" },
    spender,
    nonce: "0",
    deadline: "2000000000",
    witness,
  },
});

const exclusiveDoc = (
  input: { start: string; end: string },
  output?: { start: string; end: string },
) =>
  permitDoc(
    orderTypes("ExclusiveDutchOrder", {
      ExclusiveDutchOrder: fields(
        "OrderInfo info,uint256 decayStartTime,uint256 decayEndTime,address exclusiveFiller,uint256 exclusivityOverrideBps,address inputToken,uint256 inputStartAmount,uint256 inputEndAmount,DutchOutput[] outputs",
      ),
      DutchOutput: fields(DUTCH_OUTPUT),
    }),
    {
      info: info(EXCLUSIVE_REACTOR),
      decayStartTime: "1900000000",
      decayEndTime: "2000000000",
      exclusiveFiller: ZERO,
      exclusivityOverrideBps: "0",
      inputToken: WETH,
      inputStartAmount: input.start,
      inputEndAmount: input.end,
      outputs: [
        {
          token: USDC,
          startAmount: output?.start ?? "1000000",
          endAmount: output?.end ?? "1000000",
          recipient: SIGNER,
        },
      ],
    },
    EXCLUSIVE_REACTOR,
  );

const v3Doc = (maxAmount: string, minAmount: string) =>
  permitDoc(
    orderTypes("V3DutchOrder", {
      V3DutchOrder: fields(
        "OrderInfo info,address cosigner,uint256 startingBaseFee,V3DutchInput baseInput,V3DutchOutput[] baseOutputs",
      ),
      V3DutchInput: fields(
        "address token,uint256 startAmount,NonlinearDutchDecay curve,uint256 maxAmount,uint256 adjustmentPerGweiBaseFee",
      ),
      V3DutchOutput: fields(
        "address token,uint256 startAmount,NonlinearDutchDecay curve,address recipient,uint256 minAmount,uint256 adjustmentPerGweiBaseFee",
      ),
      NonlinearDutchDecay: fields("uint256 relativeBlocks,int256[] relativeAmounts"),
    }),
    {
      info: info(V3_REACTOR),
      cosigner: SIGNER,
      startingBaseFee: "0",
      baseInput: {
        token: WETH,
        startAmount: "1",
        curve: { relativeBlocks: "0", relativeAmounts: ["0"] },
        maxAmount,
        adjustmentPerGweiBaseFee: "0",
      },
      baseOutputs: [
        {
          token: USDC,
          startAmount: "999999999",
          curve: { relativeBlocks: "0", relativeAmounts: ["0"] },
          recipient: SIGNER,
          minAmount,
          adjustmentPerGweiBaseFee: "0",
        },
      ],
    },
    V3_REACTOR,
  );

const cowDoc = (buyTokenBalance: string) => ({
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
    verifyingContract: GPV2_SETTLEMENT,
  },
  message: {
    sellToken: USDC,
    buyToken: WETH,
    receiver: ZERO,
    sellAmount: "1000000",
    buyAmount: "500000000000000000",
    validTo: 2_000_000_000,
    appData: `0x${"ab".repeat(32)}`,
    feeAmount: "0",
    kind: "sell",
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance,
  },
});

describe("order bounds", () => {
  it("1inch: ALLOW_MULTIPLE_FILLS + USE_PERMIT2 still decodes as a partial-fill order", () => {
    const flags = ALLOW_MULTIPLE_FILLS | USE_PERMIT2;
    const intent = decode(inchDoc(flags));
    expect(intent.blind).toBeUndefined();
    const order = orderOf(inchDoc(flags));
    expect(order?.give).toStrictEqual({
      asset: USDC,
      amount: "1000000",
      symbol: "USDC",
      decimals: 6,
    });
    expect(order?.receive).toStrictEqual([
      { recipient: RECEIVER, amount: { asset: WETH, amount: "500000000000000000" } },
    ]);
    expect(order?.partialFill).toBe(true);
  });

  it.each([
    ["UNWRAP_WETH", 1n << 247n],
    ["HAS_EXTENSION", 1n << 249n],
    ["POST_INTERACTION_CALL", 1n << 251n],
    ["PRE_INTERACTION_CALL", 1n << 252n],
    ["spare bit 253", 1n << 253n],
    ["undefined bit 200", 1n << 200n],
    ["undefined bit 246", 1n << 246n],
  ])("1inch: %s alone is a near-miss blind", (_name, bit) => {
    expect(decode(inchDoc(bit)).blind).toBe("typed-data-variant");
  });

  it("UniswapX ExclusiveDutchOrder: a rising input gives at its end amount", () => {
    expect(orderOf(exclusiveDoc({ start: "1", end: "5" }))?.give).toStrictEqual({
      asset: WETH,
      amount: "5",
    });
  });

  it("UniswapX ExclusiveDutchOrder: a falling input gives at its start amount", () => {
    expect(orderOf(exclusiveDoc({ start: "7", end: "3" }))?.give).toStrictEqual({
      asset: WETH,
      amount: "7",
    });
  });

  it("UniswapX ExclusiveDutchOrder: a decaying output receives at its end amount", () => {
    const order = orderOf(
      exclusiveDoc({ start: "1", end: "1" }, { start: "1000000", end: "500000" }),
    );
    expect(order?.receive[0]?.amount).toStrictEqual({
      asset: USDC,
      amount: "500000",
      symbol: "USDC",
      decimals: 6,
    });
  });

  it("UniswapX V3: give is baseInput.maxAmount and receive is the output minAmount", () => {
    const order = orderOf(v3Doc("6000000000000000000", "123456"));
    expect(order?.give).toStrictEqual({ asset: WETH, amount: "6000000000000000000" });
    expect(order?.receive[0]?.amount).toStrictEqual({
      asset: USDC,
      amount: "123456",
      symbol: "USDC",
      decimals: 6,
    });
  });

  it("CoW: buyTokenBalance internal still decodes and no order key mentions balance", () => {
    const intent = decode(cowDoc("internal"));
    expect(intent.blind).toBeUndefined();
    const order = orderOf(cowDoc("internal"));
    expect(order).toBeDefined();
    const keys = Object.keys(order!);
    expect(keys.filter((k) => k.includes("balance"))).toStrictEqual([]);
    expect(keys).toStrictEqual(["protocol", "maker", "give", "receive", "expiry", "partialFill"]);
  });
});
