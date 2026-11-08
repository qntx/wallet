import { keccak256 } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { EVM_DELEGATOR, checksumEvmAddress } from "@qntx/wallet-chains/evm";

import { EvmChainAdapter } from "../src/chains/evm.ts";

const DELEGATOR = EVM_DELEGATOR.address;
const OTHER = checksumEvmAddress("0x0000000000000000000000000000000000c0ffee");

const client = (code: string) =>
  ({
    transport: {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_getCode") {
          return Promise.resolve(code);
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  }) as never;

describe("delegation state", () => {
  it("parses none / ours / other and refuses a non-EOA account", async () => {
    const evm = new EvmChainAdapter();
    await expect(evm.delegation(client("0x"), "0x1")).resolves.toStrictEqual({ kind: "none" });
    await expect(
      evm.delegation(client(`0xef0100${DELEGATOR.slice(2)}`), "0x1"),
    ).resolves.toStrictEqual({
      kind: "ours",
    });
    await expect(
      evm.delegation(client(`0xef0100${OTHER.slice(2).toLowerCase()}`), "0x1"),
    ).resolves.toStrictEqual({ kind: "other", address: OTHER });
    await expect(evm.delegation(client("0x60806040"), "0x1")).rejects.toThrow(/not an EOA/);
  });

  it("delegatorVerified matches the code hash; altered code fails", async () => {
    const evm = new EvmChainAdapter();
    const code = "0x608060405260043610";
    const hash = keccak256(code as `0x${string}`);
    await expect(evm.delegatorVerified(client(code), hash)).resolves.toBe(true);
    await expect(evm.delegatorVerified(client("0xdead"), hash)).resolves.toBe(false);
    await expect(evm.delegatorVerified(client("0x"), hash)).resolves.toBe(false);
  });
});
