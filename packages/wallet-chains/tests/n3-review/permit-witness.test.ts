/**
 * Permit2 witness bounds: a UniswapX order whose Permit2 spender is not the reactor named in the
 * order info must NOT decode as an order, and a witness bigger than the leaf budget stays blind
 * oversize whether or not the witness type was recognized.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm, PERMIT2_ADDRESS } from "../../src/evm/index.ts";
import type { SignRequest } from "../../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
/* Arbitrum USDC/WETH and the verified V3DutchOrder reactor (uniswapx.ts REACTORS[42161]). */
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const V3_REACTOR_ARB = "0xB274d5F4B833b61B340b654d600A864fB604a87c";
const WRONG_SPENDER = "0x00000000000000000000000000000000DeaDBeef";
const ZERO = "0x0000000000000000000000000000000000000000";

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });
const INFO =
  "address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData";

const types = {
  EIP712Domain: fields("string name,uint256 chainId,address verifyingContract"),
  TokenPermissions: fields("address token,uint256 amount"),
  PermitWitnessTransferFrom: [
    ...fields("TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline"),
    { name: "witness", type: "V3DutchOrder" },
  ],
  OrderInfo: fields(INFO),
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
};

const v3Doc = (spender: string, outputCount: number) => ({
  types,
  primaryType: "PermitWitnessTransferFrom",
  domain: { name: "Permit2", chainId: 42161, verifyingContract: PERMIT2_ADDRESS },
  message: {
    permitted: { token: WETH, amount: "100000000000000000000" },
    spender,
    nonce: "0",
    deadline: "2000000000",
    witness: {
      info: {
        reactor: V3_REACTOR_ARB,
        swapper: SIGNER,
        nonce: "0",
        deadline: "2000000000",
        additionalValidationContract: ZERO,
        additionalValidationData: "0x",
      },
      cosigner: SIGNER,
      startingBaseFee: "0",
      baseInput: {
        token: WETH,
        startAmount: "1",
        curve: { relativeBlocks: "0", relativeAmounts: ["0"] },
        maxAmount: "1000000000000000000",
        adjustmentPerGweiBaseFee: "0",
      },
      baseOutputs: Array.from({ length: outputCount }, () => ({
        token: USDC,
        startAmount: "1000000",
        curve: { relativeBlocks: "0", relativeAmounts: ["0"] },
        recipient: SIGNER,
        minAmount: "900000",
        adjustmentPerGweiBaseFee: "0",
      })),
    },
  },
});

const orderOf = (doc: unknown) => {
  const { message } = decode(doc);
  return message?.kind === "typed-data" ? message.order : undefined;
};

const decode = (doc: unknown) =>
  decodeEvm(
    {
      kind: "evm.typed-data",
      network: "eip155:42161",
      account: ACCOUNT,
      typedData: JSON.stringify(doc),
    } satisfies SignRequest,
    SIGNER,
  );

describe("Permit2 witness bounds", () => {
  it("a V3DutchOrder whose spender is not the order reactor is not decoded as an order", () => {
    const doc = v3Doc(WRONG_SPENDER, 1);
    const intent = decode(doc);
    expect(orderOf(doc)).toBeUndefined();
    expect(intent.blind).toBe("typed-data-oversize");
    expect(intent.warnings).toContainEqual({
      kind: "permit2-witness",
      message: expect.any(String),
    });
    expect(intent.verifiability).toBe("partial");
  });

  it("a 9-output V3DutchOrder stays blind oversize", () => {
    const doc = v3Doc(V3_REACTOR_ARB, 9);
    const intent = decode(doc);
    expect(intent.blind).toBe("typed-data-oversize");
    expect(orderOf(doc)).toBeUndefined();
  });
});
