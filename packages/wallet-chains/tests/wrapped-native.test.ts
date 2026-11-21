import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { EVM_NATIVE_ASSET, decodeEvm } from "../src/evm/index.ts";
import { evmTokenTable } from "../src/evm/tokens.ts";
import { decodeWrappedNative } from "../src/evm/wrapped-native.ts";
import { attempt } from "./fuzz.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEPOSIT = "0xd0e30db0";
const WITHDRAW_5 = `0x2e1a7d4d${"5".padStart(64, "0")}`;

const call = (to: string | undefined, data: string, value = 0n) => ({ to, value, data });
const decode = (to: string | undefined, data: string, value = 0n, chainId = 1) =>
  decodeWrappedNative(chainId, call(to, data, value), SIGNER, evmTokenTable);

const txReq = (to: string, data: string, value = "0x0") => ({
  kind: "evm.transaction" as const,
  network: "eip155:1",
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
  tx: {
    type: "eip1559" as const,
    chainId: 1,
    to,
    data,
    value,
    nonce: 0,
    gas: "0x5208",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    accessList: [],
  },
});

/** The decoder returned (never threw) undefined or a single-outflow, single-receive result. */
const undefinedOrWellFormed = (
  got: ReturnType<typeof attempt<ReturnType<typeof decodeWrappedNative>>>,
): boolean =>
  got.ok &&
  (got.value === undefined ||
    (got.value.outflows.length === 1 &&
      got.value.minimumReceived.length === 1 &&
      got.value.outflows[0]?.verified === true &&
      got.value.minimumReceived[0]?.to === SIGNER));

const arbitraryCalldata = fc
  .uint8Array()
  .map((bytes) => `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);

describe("wrapped-native decode", () => {
  it("deposit() is a full-verified wrap: native out, token minted to the signer", () => {
    expect(decode(WETH, DEPOSIT, 2n)).toStrictEqual({
      outflows: [{ to: WETH, amount: { asset: EVM_NATIVE_ASSET, amount: "2" }, verified: true }],
      minimumReceived: [
        { to: SIGNER, amount: { asset: WETH, amount: "2", symbol: "WETH", decimals: 18 } },
      ],
    });
    const intent = decodeEvm(txReq(WETH, DEPOSIT, "0xde0b6b3a7640000"), SIGNER);
    expect(intent).toMatchObject({ summary: "swap", verifiability: "full" });
    expect(intent.outflows).toStrictEqual([
      {
        to: WETH,
        amount: {
          asset: EVM_NATIVE_ASSET,
          amount: "1000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        verified: true,
      },
    ]);
    expect(intent.minimumReceived).toStrictEqual([
      {
        to: SIGNER,
        amount: { asset: WETH, amount: "1000000000000000000", symbol: "WETH", decimals: 18 },
      },
    ]);
  });

  it("withdraw(wad) is a full-verified unwrap: token out, native received", () => {
    expect(decode(WETH, WITHDRAW_5)).toStrictEqual({
      outflows: [
        {
          to: WETH,
          amount: { asset: WETH, amount: "5", symbol: "WETH", decimals: 18 },
          verified: true,
        },
      ],
      minimumReceived: [{ to: SIGNER, amount: { asset: EVM_NATIVE_ASSET, amount: "5" } }],
    });
    const intent = decodeEvm(txReq(WETH, WITHDRAW_5), SIGNER);
    expect(intent).toMatchObject({ summary: "swap", verifiability: "full" });
    expect(intent.minimumReceived).toStrictEqual([
      {
        to: SIGNER,
        amount: { asset: EVM_NATIVE_ASSET, amount: "5", symbol: "ETH", decimals: 18 },
      },
    ]);
  });

  it("withdraw carrying native value is not a recognised unwrap", () => {
    expect(decode(WETH, WITHDRAW_5, 1n)).toBeUndefined();
  });

  it("non-canonical encodings are not recognised", () => {
    expect(decode(WETH, `${DEPOSIT}00`)).toBeUndefined(); // trailing byte
    expect(decode(WETH, `${WITHDRAW_5}00`)).toBeUndefined(); // trailing byte
    expect(decode(WETH, WITHDRAW_5.slice(0, -2))).toBeUndefined(); // short argument
    expect(decode(WETH, "0xd0e30db1")).toBeUndefined(); // wrong selector
  });

  it("an unlisted address or a listed non-wrapped token is not recognised", () => {
    expect(decode("0x0000000000000000000000000000000000C0FFEE", DEPOSIT, 1n)).toBeUndefined();
    expect(decode(USDC, DEPOSIT, 1n)).toBeUndefined();
    expect(decode(USDC, WITHDRAW_5)).toBeUndefined();
    expect(decode(undefined, DEPOSIT, 1n)).toBeUndefined();
  });

  it(
    "arbitrary calldata to a wrapped native returns undefined or a well-formed result",
    { timeout: 10_000 },
    () => {
      fc.assert(
        fc.property(arbitraryCalldata, fc.bigInt({ min: 0n, max: 2n ** 64n }), (data, value) => {
          expect(undefinedOrWellFormed(attempt(() => decode(WETH, data, value)))).toBe(true);
        }),
        { numRuns: 500 },
      );
    },
  );
});
