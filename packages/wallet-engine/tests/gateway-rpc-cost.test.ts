import { describe, expect, it } from "vite-plus/test";

import {
  RPC_ELEMENTS_PER_UNIT,
  rpcCallCost,
  rpcRequestCost,
} from "../src/gateway/contract/index.ts";

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = `0x${"11".repeat(32)}`;
const PUBKEY = "11111111111111111111111111111111";
const SIGNATURE = "1".repeat(64);

const call = (method: string, params: unknown[]) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("rpc cost follows the size the caller picks", () => {
  it.each([
    [0, 3],
    [1, 3],
    [RPC_ELEMENTS_PER_UNIT, 3],
    [RPC_ELEMENTS_PER_UNIT + 1, 6],
    [7000, 2100],
  ])("prices eth_getProof with %i storage keys at %i units", (keys, units) => {
    const storage = Array.from({ length: keys }, () => KEY);
    expect(rpcCallCost(call("eth_getProof", [ADDRESS, storage, "latest"]))).toBe(units);
  });

  it.each([
    ["no blocks", { blockStateCalls: [] }, 3],
    ["one call", { blockStateCalls: [{ calls: [{}] }] }, 3],
    ["three calls", { blockStateCalls: [{ calls: [{}, {}, {}] }] }, 9],
    ["calls across blocks", { blockStateCalls: [{ calls: [{}, {}] }, { calls: [{}, {}] }] }, 12],
    ["empty blocks", { blockStateCalls: [{}, {}, {}, {}] }, 12],
    ["a shape it cannot read", { blockStateCalls: "x" }, 3],
  ])("prices eth_simulateV1 with %s", (_label, payload, units) => {
    expect(rpcCallCost(call("eth_simulateV1", [payload, "latest"]))).toBe(units);
  });

  it.each([
    ["getMultipleAccounts", 1, PUBKEY, 1],
    ["getMultipleAccounts", 50, PUBKEY, 5],
    ["getMultipleAccounts", 100, PUBKEY, 10],
    ["getSignatureStatuses", 1, SIGNATURE, 1],
    ["getSignatureStatuses", 256, SIGNATURE, 26],
  ])("prices %s with %i elements", (method, count, element, units) => {
    const list = Array.from({ length: count }, () => element);
    expect(rpcCallCost(call(method, [list]))).toBe(units);
  });

  it("sums a batch of sized calls", () => {
    const list = Array.from({ length: 256 }, () => SIGNATURE);
    expect(
      rpcRequestCost([call("getSignatureStatuses", [list]), call("getSignatureStatuses", [list])]),
    ).toBe(52);
  });
});
