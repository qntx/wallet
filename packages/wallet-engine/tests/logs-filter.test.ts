import { createPublicClient, custom, parseAbi } from "viem";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  LOGS_ADDRESS_MAX,
  LOGS_BLOCK_RANGE_MAX,
  LOGS_TOPIC_ALTERNATIVES_MAX,
  accepts,
  evmRpcRequest,
  logsFilterViolation,
} from "../src/gateway/contract/index.ts";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HASH = `0x${"ab".repeat(32)}`;
const hex = (n: number): string => `0x${n.toString(16)}`;

const ACCEPTED: ReadonlyArray<readonly [string, unknown]> = [
  ["no range: the latest block", [{ address: TOKEN }]],
  ["one block by hash", [{ blockHash: HASH, topics: [TRANSFER] }]],
  ["recent-block tags", [{ fromBlock: "finalized", toBlock: "latest" }]],
  ["a single numbered block", [{ fromBlock: "0x10", toBlock: "0x10" }]],
  [
    "the widest numbered range",
    [{ fromBlock: hex(1000), toBlock: hex(1000 + LOGS_BLOCK_RANGE_MAX - 1) }],
  ],
  [
    "the most addresses and topic alternatives",
    [
      {
        address: Array.from({ length: LOGS_ADDRESS_MAX }, () => TOKEN),
        topics: [null, Array.from({ length: LOGS_TOPIC_ALTERNATIVES_MAX }, () => TRANSFER)],
      },
    ],
  ],
];

const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
  ["no filter", []],
  ["two filters", [{}, {}]],
  ["a filter that is not an object", ["latest"]],
  ["an unknown key", [{ limit: 5 }]],
  ["the whole chain", [{ fromBlock: "earliest", toBlock: "latest" }]],
  ["a number against a tag", [{ fromBlock: "0x10", toBlock: "latest" }]],
  ["a number with no end", [{ fromBlock: "0x10" }]],
  ["a range one block too wide", [{ fromBlock: hex(0), toBlock: hex(LOGS_BLOCK_RANGE_MAX) }]],
  ["a reversed range", [{ fromBlock: "0x20", toBlock: "0x10" }]],
  ["a block hash together with a range", [{ blockHash: HASH, fromBlock: "0x1", toBlock: "0x2" }]],
  ["too many addresses", [{ address: Array.from({ length: LOGS_ADDRESS_MAX + 1 }, () => TOKEN) }]],
  ["an empty address list", [{ address: [] }]],
  [
    "too many topic alternatives",
    [{ topics: [Array.from({ length: LOGS_TOPIC_ALTERNATIVES_MAX + 1 }, () => TRANSFER)] }],
  ],
  ["five topic positions", [{ topics: [null, null, null, null, null] }]],
  ["a malformed address", [{ address: "0x1234" }]],
];

const call = (params: unknown) => ({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params });

describe("eth_getLogs filter bounds", () => {
  it.each(ACCEPTED)("accepts %s", (_name, params) => {
    expect(logsFilterViolation(params)).toBeUndefined();
    expect(accepts(evmRpcRequest, call(params))).toBe(true);
  });

  it.each(REFUSED)("refuses %s", (_name, params) => {
    expect(logsFilterViolation(params)).toBeTypeOf("string");
    expect(accepts(evmRpcRequest, call(params))).toBe(false);
  });

  it("refuses a batch that carries one unbounded filter", () => {
    const blockNumber = { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] };
    expect(accepts(evmRpcRequest, [blockNumber, call([{ address: TOKEN }])])).toBe(true);
    expect(accepts(evmRpcRequest, [blockNumber, call([{ fromBlock: "earliest" }])])).toBe(false);
  });
});

const LOG = {
  address: TOKEN,
  topics: [TRANSFER, `0x${"00".repeat(31)}01`, `0x${"00".repeat(31)}02`],
  data: `0x${"00".repeat(31)}05`,
  blockHash: HASH,
  transactionHash: HASH,
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
};

/** The wallet's read passthrough: no filter methods, `eth_getLogs` only within the bounds. */
let block = 100;
const passthrough = ({ method, params }: { method: string; params: unknown }): unknown => {
  if (method === "eth_blockNumber") {
    block += 1;
    return hex(block);
  }
  if (method === "eth_getLogs" && logsFilterViolation(params) === undefined) {
    return [{ ...LOG, blockNumber: hex(block) }];
  }
  throw Object.assign(new Error(`${method} does not exist`), { code: -32_601 });
};

describe("a viem event watcher over the bounded read", () => {
  it("falls back from filters to eth_getLogs and delivers the logs", async () => {
    const requested: Array<{ method: string; params: unknown }> = [];
    const client = createPublicClient({
      pollingInterval: 10,
      transport: custom({
        // The wallet's passthrough: no filter methods, eth_getLogs only within the bounds.
        request: async (request: { method: string; params: unknown }) => {
          requested.push(request);
          await Promise.resolve();
          return passthrough(request);
        },
      }),
    });
    const onLogs = vi.fn<(logs: ReadonlyArray<{ args: unknown }>) => void>();
    const unwatch = client.watchContractEvent({
      address: TOKEN,
      abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
      eventName: "Transfer",
      onLogs,
    });
    await vi.waitFor(() => {
      expect(onLogs).toHaveBeenCalled();
    });
    unwatch();
    expect(onLogs.mock.calls[0]?.[0][0]?.args).toMatchObject({ value: 5n });
    expect(requested.some((r) => r.method === "eth_newFilter")).toBe(true);
    const logsCalls = requested.filter((r) => r.method === "eth_getLogs");
    expect(logsCalls.length).toBeGreaterThan(0);
    expect(logsCalls.every((r) => logsFilterViolation(r.params) === undefined)).toBe(true);
  });
});
