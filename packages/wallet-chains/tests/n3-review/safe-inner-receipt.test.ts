/**
 * Inside a recognized SafeTx the inner calls are decoded with the EOA signer, so bound-recipient
 * fields (WETH wrap/unwrap recipients, a Lido withdrawal owner of `address(0)`) name the signer,
 * not the Safe that will actually receive the funds. Pins current behaviour.
 */
import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../../src/evm/index.ts";
import type { DisplayIntent } from "../../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const SAFE = "0xD5Ffe748b45F5253Fc9975fDd96FDdeC052e6D52";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const LIDO_QUEUE = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
const ZERO = "0x0000000000000000000000000000000000000000";

const safeDoc = (message: Record<string, unknown>) => ({
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
  domain: { chainId: 1, verifyingContract: SAFE },
  message: {
    value: "0",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: "42",
    ...message,
  },
});

const decode = (doc: unknown): DisplayIntent =>
  decodeEvm(
    {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: ACCOUNT,
      typedData: JSON.stringify(doc),
    },
    SIGNER,
  );

const firstStaking = (call: DisplayIntent) => call.staking?.[0];

const innerCall = (doc: unknown): DisplayIntent => {
  const { message } = decode(doc);
  if (message?.kind !== "typed-data" || message.safe === undefined) {
    throw new Error("expected a recognized SafeTx");
  }
  const [call] = message.safe.calls;
  if (call === undefined) {
    throw new Error("expected one inner call");
  }
  return call;
};

describe("SafeTx inner-call recipients name the EOA signer, not the Safe", () => {
  it("WETH deposit() inside a SafeTx reports the wrapped ETH to the signer", () => {
    const call = innerCall(
      safeDoc({
        to: WETH,
        value: "1000000000000000000",
        data: encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) }),
      }),
    );
    expect(call.minimumReceived?.[0]?.to).toBe(SIGNER);
    expect(call.verifiability).toBe("full");
  });

  it("WETH withdraw(1e18) inside a SafeTx reports the native ETH to the signer", () => {
    const call = innerCall(
      safeDoc({
        to: WETH,
        data: encodeFunctionData({
          abi: parseAbi(["function withdraw(uint256 wad)"]),
          args: [1_000_000_000_000_000_000n],
        }),
      }),
    );
    const received = call.minimumReceived?.[0];
    expect(received?.to).toBe(SIGNER);
    expect(received?.amount.asset).toBe("native");
  });

  it("Lido requestWithdrawals(amounts, 0) inside a SafeTx resolves owner to the signer", () => {
    const call = innerCall(
      safeDoc({
        to: LIDO_QUEUE,
        data: encodeFunctionData({
          abi: parseAbi(["function requestWithdrawals(uint256[] amounts, address owner)"]),
          args: [[1_000_000_000_000_000_000n], ZERO as `0x${string}`],
        }),
      }),
    );
    expect(firstStaking(call)).toMatchObject({ kind: "lido-request", owner: SIGNER });
  });
});
