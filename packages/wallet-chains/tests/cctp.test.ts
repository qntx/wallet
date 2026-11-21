/**
 * CCTP TokenMessengerV2 `depositForBurnWithHook` on Arbitrum → the Hyperliquid forwarder on domain
 * 19: a fully matching call describes the deposit (outflow + `hyperliquidDeposit`), and every other
 * call to the messenger on these chains is blind with `cctp-destination`.
 */
import * as AbiFunction from "ox/AbiFunction";
import { describe, expect, it } from "vite-plus/test";

import { decodeCctp, isCctpMessenger } from "../src/evm/cctp.ts";
import { decodeEvm } from "../src/evm/decode.ts";
import type { EvmTransaction } from "../src/index.ts";

const ARBITRUM = "eip155:42161";
const SEPOLIA = "eip155:421614";
const MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const FORWARDER = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
const SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const pad32 = (addr: string) => `0x${addr.slice(2).padStart(64, "0")}`;

const hook = (recipient = SIGNER, dex: "perps" | "spot" = "perps"): string =>
  `0x636374702d666f7277617264${"00".repeat(12)}0000000000000018${recipient
    .slice(2)
    .toLowerCase()}${dex === "perps" ? "00000000" : "ffffffff"}`;

const DEPOSIT = AbiFunction.from(
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
);

const data = (over: Partial<Parameters<typeof build>[0]> = {}) =>
  build({ amount: 5_000_000n, hook: hook(), ...over });
const build = (o: {
  amount?: bigint;
  domain?: number;
  mintRecipient?: string;
  burnToken?: string;
  destinationCaller?: string;
  maxFee?: bigint;
  finality?: number;
  hook?: string;
}) =>
  AbiFunction.encodeData(DEPOSIT, [
    o.amount ?? 5_000_000n,
    o.domain ?? 19,
    (o.mintRecipient ?? pad32(FORWARDER)) as `0x${string}`,
    (o.burnToken ?? USDC) as `0x${string}`,
    (o.destinationCaller ?? pad32(FORWARDER)) as `0x${string}`,
    o.maxFee ?? 10_000n,
    o.finality ?? 1000,
    (o.hook ?? hook()) as `0x${string}`,
  ]);

const call = (
  data_: string,
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  type: "0x2",
  chainId: "0xa4b1",
  nonce: "0x1",
  gas: "0x30000",
  maxFeePerGas: "0x59682f00",
  maxPriorityFeePerGas: "0x3b9aca00",
  gasPrice: "0x59682f00",
  to: MESSENGER,
  data: data_,
  value: "0x0",
  ...over,
});

const txReq = (tx: EvmTransaction, network = ARBITRUM) => ({
  kind: "evm.transaction" as const,
  network,
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
  tx,
});

describe("cctp depositForBurnWithHook", () => {
  it("describes the Hyperliquid deposit with the worst-case fee", () => {
    const intent = decodeEvm(txReq(call(data()) as EvmTransaction), SIGNER);
    expect(intent.summary).toBe("transfer");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows[0]).toMatchObject({
      to: MESSENGER,
      amount: { amount: "5000000" },
      verified: true,
    });
    expect(intent.hyperliquidDeposit).toMatchObject({
      recipient: SIGNER,
      dex: "perps",
      maxFee: { amount: "10000" },
    });
  });

  it("describes a spot deposit on Arbitrum Sepolia", () => {
    const sepoliaData = build({
      burnToken: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      mintRecipient: pad32("0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2"),
      destinationCaller: pad32("0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2"),
      hook: hook(SIGNER, "spot"),
    });
    const intent = decodeEvm(
      txReq(
        call(sepoliaData, { to: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" }) as EvmTransaction,
        SEPOLIA,
      ),
      SIGNER,
    );
    expect(intent.hyperliquidDeposit).toMatchObject({ dex: "spot", recipient: SIGNER });
  });

  it.each([
    ["a nonzero value", call(data(), { value: "0x1" })],
    ["a trailing byte", call(`${data()}00`)],
    ["a different domain", call(data({ domain: 3 }))],
    ["a different burnToken", call(data({ burnToken: SIGNER }))],
    ["a different caller", call(data({ destinationCaller: pad32(SIGNER) }))],
    [
      "a different recipient",
      call(data({ hook: hook("0x1111111111111111111111111111111111111111") })),
    ],
    ["a bad dex", call(data({ hook: `${hook().slice(0, -8)}00000001` }))],
    ["maxFee ≥ amount", call(data({ maxFee: 5_000_000n }))],
    ["a zero maxFee", call(data({ maxFee: 0n }))],
    ["a different selector", call(`0x12345678${data().slice(10)}`)],
  ])("is blind for %s", (_name, c) => {
    const intent = decodeEvm(txReq(c as EvmTransaction), SIGNER);
    expect(intent.blind).toBe("cctp-destination");
    expect(intent.verifiability).toBe("opaque");
  });

  it("decodeCctp ignores calls to other contracts and other chains", () => {
    expect(isCctpMessenger(42161, MESSENGER)).toBe(true);
    expect(isCctpMessenger(1, MESSENGER)).toBe(false);
    expect(decodeCctp(1, { to: MESSENGER, data: data(), value: 0n }, SIGNER)).toBeUndefined();
    expect(
      decodeCctp(
        42161,
        { to: "0x1111111111111111111111111111111111111111", data: data(), value: 0n },
        SIGNER,
      ),
    ).toBeUndefined();
  });
});
