/**
 * Audit A1 lane parity-evm PoC (PE-02). Asserts CURRENT behaviour: everyday dApp requests outside
 * the local recognizer set decode as `opaque` and count as blind, so on a vault with the default
 * policy (blind signing off) the engine (`RequestController.blindRisk`) and the kernel
 * (`modules/chains/index.ts` `blind-signing-disabled`) refuse them before any prompt.
 */
import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/decode.ts";
import { isBlindIntent } from "../src/index.ts";
import type { EvmTransaction, SignRequest } from "../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const account = { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm.bip44" };

const tx = (to: string, data: string, value = "0x0"): SignRequest => ({
  kind: "evm.transaction",
  network: "eip155:1",
  account,
  tx: {
    type: "eip1559",
    chainId: 1,
    nonce: 0,
    gas: "0x30000",
    to,
    value,
    data,
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  } as EvmTransaction,
});

const CASES: ReadonlyArray<readonly [string, SignRequest]> = [
  [
    "WETH9 deposit() (wrap 1 ETH)",
    tx(
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) }),
      "0xde0b6b3a7640000",
    ),
  ],
  [
    "Aave V3 Pool supply(USDC)",
    tx(
      "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      encodeFunctionData({
        abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
        args: [USDC, 1_000_000n, SIGNER, 0],
      }),
    ),
  ],
  [
    "Uniswap Universal Router execute()",
    tx(
      "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
      encodeFunctionData({
        abi: parseAbi(["function execute(bytes,bytes[],uint256)"]),
        args: ["0x0b00", ["0x", "0x"], 2_000_000_000n],
      }),
      "0x2386f26fc10000",
    ),
  ],
  [
    "CoW Protocol GPv2 Order (EIP-712)",
    {
      kind: "evm.typed-data",
      network: "eip155:1",
      account,
      typedData: JSON.stringify({
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
          buyToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
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
    },
  ],
];

describe("PE-02 common dApp requests are blind under the default policy", () => {
  it.each(CASES)("%s → opaque and blind", (_name, request) => {
    const intent = decodeEvm(request, SIGNER);
    expect(intent.verifiability).toBe("opaque");
    // Gap: blind ⇒ BlindSigningDisabledError / `blind-signing-disabled` while the policy is off.
    expect(isBlindIntent(intent)).toBe(true);
  });
});
