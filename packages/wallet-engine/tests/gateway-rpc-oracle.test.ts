import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { accepts, evmRpcRequest } from "../src/gateway/contract/index.ts";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const HASH = `0x${"ab".repeat(32)}` as const;
const STORAGE_KEY = `0x${"01".repeat(32)}` as const;

/**
 * A viem public client whose `http` transport posts to a fake `fetchFn` that captures every
 * request body — the oracle for "the gateway accepts every JSON-RPC shape the engine sends".
 */
function capture() {
  const bodies: unknown[] = [];
  const fetchFn: typeof globalThis.fetch = async (_input, init) => {
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    bodies.push(body);
    const id = typeof body === "object" && body !== null && "id" in body ? body["id"] : 1;
    await Promise.resolve();
    return Response.json({ jsonrpc: "2.0", id, result: null });
  };
  const client = createPublicClient({ transport: http("https://rpc.test", { fetchFn }) });
  const sent = async (action: Promise<unknown>): Promise<unknown[]> => {
    const before = bodies.length;
    // Result decoding runs after capture and may throw on the canned `null` — irrelevant here.
    await action.catch(() => undefined);
    const fresh = bodies.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    return fresh;
  };
  return { client, sent };
}

const expectAccepted = (bodies: ReadonlyArray<unknown>): void => {
  for (const body of bodies) {
    expect(accepts(evmRpcRequest, body), JSON.stringify(body)).toBe(true);
  }
};

describe("the gateway accepts every evm read shape viem sends", () => {
  it("getBalance, getTransactionCount, getCode, getStorageAt", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.getBalance({ address: ADDRESS })));
    expectAccepted(await sent(client.getBalance({ address: ADDRESS, blockTag: "safe" })));
    expectAccepted(await sent(client.getTransactionCount({ address: ADDRESS })));
    expectAccepted(await sent(client.getCode({ address: ADDRESS })));
    expectAccepted(await sent(client.getStorageAt({ address: ADDRESS, slot: STORAGE_KEY })));
  });

  it("getProof by tag and by EIP-1898 hash", async () => {
    const { client, sent } = capture();
    expectAccepted(
      await sent(client.getProof({ address: ADDRESS, storageKeys: [STORAGE_KEY] })),
    );
    expectAccepted(
      await sent(
        client.getProof({ address: ADDRESS, blockHash: HASH, storageKeys: [STORAGE_KEY] }),
      ),
    );
  });

  it("call, estimateGas, createAccessList", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.call({ to: ADDRESS, data: "0x" })));
    expectAccepted(await sent(client.call({ to: ADDRESS, data: "0x", account: ADDRESS })));
    expectAccepted(await sent(client.estimateGas({ to: ADDRESS, account: ADDRESS })));
    expectAccepted(await sent(client.createAccessList({ to: ADDRESS, data: "0x" })));
  });

  it("getBlock by number, tag and hash, with and without full transactions", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.getBlock()));
    expectAccepted(await sent(client.getBlock({ blockTag: "safe" })));
    expectAccepted(await sent(client.getBlock({ blockNumber: 123n })));
    expectAccepted(await sent(client.getBlock({ blockHash: HASH })));
    expectAccepted(await sent(client.getBlock({ blockNumber: 123n, includeTransactions: true })));
    expectAccepted(await sent(client.getBlock({ blockHash: HASH, includeTransactions: true })));
  });

  it("getBlockTransactionCount by number and hash", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.getBlockTransactionCount()));
    expectAccepted(await sent(client.getBlockTransactionCount({ blockHash: HASH })));
  });

  it("getTransaction by hash and by block coordinates, getTransactionReceipt", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.getTransaction({ hash: HASH })));
    expectAccepted(await sent(client.getTransaction({ blockHash: HASH, index: 0 })));
    expectAccepted(await sent(client.getTransaction({ blockNumber: 123n, index: 0 })));
    expectAccepted(await sent(client.getTransactionReceipt({ hash: HASH })));
  });

  it("getFeeHistory with and without reward percentiles", async () => {
    const { client, sent } = capture();
    expectAccepted(
      await sent(client.getFeeHistory({ blockCount: 4, rewardPercentiles: [10, 50, 90] })),
    );
    expectAccepted(await sent(client.getFeeHistory({ blockCount: 4, rewardPercentiles: [] })));
  });

  it("getGasPrice, estimateMaxPriorityFeePerGas, getChainId, getBlockNumber", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.getGasPrice()));
    expectAccepted(await sent(client.estimateMaxPriorityFeePerGas()));
    expectAccepted(await sent(client.getChainId()));
    expectAccepted(await sent(client.getBlockNumber()));
  });

  it("getLogs inside the bounded range", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.getLogs({ address: ADDRESS, fromBlock: 100n, toBlock: 200n })));
    expectAccepted(await sent(client.getLogs({ blockHash: HASH })));
  });

  it("simulateCalls (eth_simulateV1)", async () => {
    const { client, sent } = capture();
    expectAccepted(await sent(client.simulateCalls({ calls: [{ to: ADDRESS, data: "0x" }] })));
  });

  it("sendRawTransaction and the engine's raw transport calls", async () => {
    const { client, sent } = capture();
    expectAccepted(
      await sent(client.request({ method: "eth_sendRawTransaction", params: ["0x02aabb"] })),
    );
    expectAccepted(
      await sent(
        client.transport.request({
          method: "eth_feeHistory",
          params: ["0x14", "latest", [10, 50, 90]],
        }),
      ),
    );
    expectAccepted(
      await sent(client.transport.request({ method: "eth_getBlockByNumber", params: ["finalized", false] })),
    );
  });
});

describe("the gateway rejects malformed calls before any upstream", () => {
  it.each([
    ["a null id", { jsonrpc: "2.0", id: null, method: "eth_chainId", params: [] }],
    [
      "a malformed address",
      { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xzz", "latest"] },
    ],
    [
      "a missing address",
      { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [] },
    ],
    [
      "an extra arg",
      { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: ["latest"] },
    ],
  ])("rejects %s", (_name, body) => {
    expect(accepts(evmRpcRequest, body)).toBe(false);
  });
});
