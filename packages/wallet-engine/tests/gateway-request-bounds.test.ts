import { describe, expect, it } from "vite-plus/test";

import {
  FEE_HISTORY_BLOCKS_MAX,
  FEE_HISTORY_PERCENTILES_MAX,
  RPC_PROOF_KEYS_MAX,
  RPC_SIMULATE_BLOCKS_MAX,
  RPC_SIMULATE_CALLS_MAX,
  accepts,
  evmRpcRequest,
} from "../src/gateway/contract/index.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const key = (i: number): string => `0x${i.toString(16).padStart(64, "0")}`;

const call = (method: string, params: unknown[]) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method,
  params,
});

const ok = (body: unknown): boolean => accepts(evmRpcRequest, body);

describe("request parameter bounds", () => {
  it(`accepts ${String(RPC_PROOF_KEYS_MAX)} eth_getProof keys and refuses one more`, () => {
    expect(
      ok(
        call("eth_getProof", [
          OWNER,
          Array.from({ length: RPC_PROOF_KEYS_MAX }, (_v, i) => key(i)),
          "latest",
        ]),
      ),
    ).toBe(true);
    expect(
      ok(
        call("eth_getProof", [
          OWNER,
          Array.from({ length: RPC_PROOF_KEYS_MAX + 1 }, (_v, i) => key(i)),
          "latest",
        ]),
      ),
    ).toBe(false);
  });

  it(`accepts ${String(RPC_SIMULATE_BLOCKS_MAX)} simulate blocks and refuses one more`, () => {
    const blocks = (n: number) =>
      Array.from({ length: n }, () => ({ calls: [{ from: OWNER, to: OWNER }] }));
    expect(ok(call("eth_simulateV1", [{ blockStateCalls: blocks(RPC_SIMULATE_BLOCKS_MAX) }]))).toBe(
      true,
    );
    expect(
      ok(call("eth_simulateV1", [{ blockStateCalls: blocks(RPC_SIMULATE_BLOCKS_MAX + 1) }])),
    ).toBe(false);
  });

  it(`accepts ${String(RPC_SIMULATE_CALLS_MAX)} simulate calls across blocks and refuses one more`, () => {
    const block = (calls: number) => ({
      calls: Array.from({ length: calls }, () => ({ from: OWNER, to: OWNER })),
    });
    expect(
      ok(
        call("eth_simulateV1", [
          { blockStateCalls: [block(50), block(RPC_SIMULATE_CALLS_MAX - 50)] },
        ]),
      ),
    ).toBe(true);
    expect(
      ok(
        call("eth_simulateV1", [
          { blockStateCalls: [block(50), block(RPC_SIMULATE_CALLS_MAX - 50 + 1)] },
        ]),
      ),
    ).toBe(false);
  });

  it(`accepts ${String(FEE_HISTORY_BLOCKS_MAX)} fee-history blocks and refuses one more`, () => {
    expect(ok(call("eth_feeHistory", [FEE_HISTORY_BLOCKS_MAX, "latest", [50]]))).toBe(true);
    expect(ok(call("eth_feeHistory", [FEE_HISTORY_BLOCKS_MAX + 1, "latest", [50]]))).toBe(false);
    expect(
      ok(call("eth_feeHistory", [`0x${FEE_HISTORY_BLOCKS_MAX.toString(16)}`, "latest", [50]])),
    ).toBe(true);
    expect(
      ok(
        call("eth_feeHistory", [`0x${(FEE_HISTORY_BLOCKS_MAX + 1).toString(16)}`, "latest", [50]]),
      ),
    ).toBe(false);
  });

  it(`accepts ${String(FEE_HISTORY_PERCENTILES_MAX)} percentiles and refuses one more`, () => {
    const percentiles = (n: number) => Array.from({ length: n }, (_v, i) => i % 100);
    expect(
      ok(call("eth_feeHistory", [10, "latest", percentiles(FEE_HISTORY_PERCENTILES_MAX)])),
    ).toBe(true);
    expect(
      ok(call("eth_feeHistory", [10, "latest", percentiles(FEE_HISTORY_PERCENTILES_MAX + 1)])),
    ).toBe(false);
  });
});
