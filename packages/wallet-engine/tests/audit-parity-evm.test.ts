/**
 * Audit A1 lane parity-evm PoCs. Each test asserts the CURRENT behaviour so it passes today and
 * documents a parity gap; a fix should flip the marked expectation.
 */
import { encodeFunctionData } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { AssetsController } from "../src/assets/controller.ts";
import { ERC20_ABI } from "../src/chains/evm.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OWNER = "0x2222222222222222222222222222222222222222";
const enc = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

const balanceOf = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: "balanceOf",
  args: [OWNER],
});

/** Every balanceOf answers 1_000 USDC; symbol/decimals answer USDC/6. */
const client = (): PublicClient =>
  ({
    transport: {
      request: async ({
        method,
        params,
      }: {
        method: string;
        params?: unknown[];
      }): Promise<string> => {
        if (method === "eth_getBalance") {
          return Promise.resolve("0x0");
        }
        if (method === "eth_call") {
          const [{ data }] = params as [{ data: string }];
          if (data === balanceOf) {
            return Promise.resolve(enc(1_000_000_000n));
          }
          if (data === encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" })) {
            return Promise.resolve(enc(6n));
          }
          return Promise.resolve(
            "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000455534443",
          );
        }
        return Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  }) as unknown as PublicClient;

const assets = () =>
  new AssetsController({
    networks: { client, info: () => ({ chainId: 1, family: "evm" }) } as never,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger: { warn: () => {} },
  });

describe("PE-01 built-in tokens are not part of the balance view", () => {
  it("refresh reads no ERC-20 balance for a holder of the built-in USDC", async () => {
    const ctl = assets();
    await ctl.init();
    const balances = await ctl.refresh(OWNER, "eip155:1");
    // Gap: the account holds 1,000 USDC (built-in, issuer-verified) but the view lists no token.
    expect(balances.tokens).toStrictEqual([]);
    expect(ctl.isTracked("eip155:1", USDC_MAINNET)).toBe(true);
  });

  it("adding the built-in USDC by hand shows it as unverified", async () => {
    const ctl = assets();
    await ctl.init();
    await ctl.addToken("eip155:1", USDC_MAINNET);
    const balances = await ctl.refresh(OWNER, "eip155:1");
    expect(balances.tokens).toHaveLength(1);
    expect(balances.tokens[0]?.balance).toBe("1000000000");
    // Gap: the issuer-verified table entry is labelled `verified: false` in the balance view.
    expect(balances.tokens[0]?.verified).toBe(false);
  });
});
