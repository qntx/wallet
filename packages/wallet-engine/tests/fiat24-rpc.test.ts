import type { Client, PublicClient } from "viem";
/**
 * `createFiat24Client` corroboration: the primary endpoint answered by every rule, the independent
 * endpoint compared on the binding projection when available, fail-closed on an erroring
 * corroborator, and refusal of anything outside the SDK's method set — fixed messages only, never
 * params or results.
 */
import { describe, expect, it } from "vite-plus/test";

import { createFiat24Client } from "../src/apps/fiat24/rpc.ts";
import type { AppNetworks } from "../src/apps/types.ts";
import type { Independent } from "../src/networks/controller.ts";

type Call = { readonly method: string; readonly params?: unknown };
type Handler = (call: Call) => Promise<unknown>;

const stub = (handler: Handler, calls: Call[]): PublicClient => {
  const client = {
    transport: {
      request: async ({ method, params }: Call): Promise<unknown> => {
        const call = { method, params };
        calls.push(call);
        return handler(call);
      },
    },
  };
  return client as unknown as PublicClient;
};

const networks = (primary: PublicClient, independent: Independent<PublicClient>): AppNetworks => ({
  client: () => primary,
  independentClient: () => independent,
});

/** Handlers as plain promise-returning functions — a value, a rejection, or a bespoke body. */
const value =
  (v: unknown): Handler =>
  async () =>
    Promise.resolve(v);
const failing =
  (message: string): Handler =>
  async () =>
    Promise.reject(new Error(message));

const rig = (
  primary: Handler,
  independent?: Handler | "not-needed" | "unavailable",
): {
  client: Client;
  primaryCalls: Call[];
  secondCalls: Call[];
} => {
  const primaryCalls: Call[] = [];
  const secondCalls: Call[] = [];
  const second: Independent<PublicClient> =
    independent === undefined || independent === "not-needed"
      ? { kind: "not-needed" }
      : independent === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "available", source: "host", client: stub(independent, secondCalls) };
  return {
    client: createFiat24Client(networks(stub(primary, primaryCalls), second)),
    primaryCalls,
    secondCalls,
  };
};

const request = async (client: Client, call: Call): Promise<unknown> =>
  client.transport.request(call);

const BLOCK = "0x64";
const CALL = { method: "eth_call", params: [{ to: "0x1", data: "0xdead" }, BLOCK] };
const STORAGE = { method: "eth_getStorageAt", params: ["0x1", "0x0", BLOCK] };
const GET_BLOCK = { method: "eth_getBlockByNumber", params: [BLOCK, false] };

const block = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  hash: "0xab",
  number: BLOCK,
  timestamp: "0x10",
  ...extra,
});

const log = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  address: "0xAbC",
  topics: ["0xAA", "0xbb"],
  data: "0xCC",
  blockNumber: "0x64",
  blockHash: "0xab",
  transactionHash: "0xcd",
  logIndex: "0x0",
  removed: false,
  ...extra,
});

const receipt = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  transactionHash: "0xcd",
  blockHash: "0xab",
  blockNumber: "0x64",
  status: "0x1",
  from: "0xAA",
  to: "0xBB",
  logs: [log()],
  ...extra,
});

const tx = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  hash: "0xcd",
  from: "0xAA",
  to: "0xBB",
  nonce: "0x2",
  input: "0xdead",
  value: "0x0",
  blockHash: "0xab",
  blockNumber: "0x64",
  ...extra,
});

describe("fiat24 rpc corroboration", () => {
  it("answers eth_chainId only when every endpoint answers arbitrum one", async () => {
    const ok = rig(value("0xa4b1"), value("0xa4b1"));
    await expect(request(ok.client, { method: "eth_chainId" })).resolves.toBe("0xa4b1");
    const wrongPrimary = rig(value("0x89"), value("0xa4b1"));
    await expect(request(wrongPrimary.client, { method: "eth_chainId" })).rejects.toThrow(
      "different chain",
    );
    const wrongSecond = rig(value("0xa4b1"), value("0x89"));
    await expect(request(wrongSecond.client, { method: "eth_chainId" })).rejects.toThrow(
      "different chain",
    );
  });

  it("eth_blockNumber returns the lower head", async () => {
    const { client } = rig(value("0x200"), value("0x100"));
    await expect(request(client, { method: "eth_blockNumber" })).resolves.toBe("0x100");
  });

  it("pinned eth_call compares both endpoints; a mismatch throws", async () => {
    const same = rig(value("0xABCD"), value("0xabcd"));
    await expect(request(same.client, CALL)).resolves.toBe("0xABCD");
    const diff = rig(value("0xaaaa"), value("0xbbbb"));
    await expect(request(diff.client, CALL)).rejects.toThrow("disagree");
  });

  it("eth_call at an unpinned tag refuses before any endpoint call", async () => {
    const { client, primaryCalls, secondCalls } = rig(value("0x00"), value("0x00"));
    await expect(
      request(client, { method: "eth_call", params: [{ to: "0x1", data: "0xdead" }, "latest"] }),
    ).rejects.toThrow("explicit block");
    await expect(
      request(client, { method: "eth_call", params: [{ to: "0x1", data: "0xdead" }] }),
    ).rejects.toThrow("explicit block");
    expect(primaryCalls).toHaveLength(0);
    expect(secondCalls).toHaveLength(0);
  });

  it("pinned eth_getStorageAt compares both endpoints; a mismatch throws", async () => {
    const diff = rig(value(`0x${"0".repeat(64)}`), value(`0x${"f".repeat(64)}`));
    await expect(request(diff.client, STORAGE)).rejects.toThrow("disagree");
    const unpinned = rig(value("0x0"));
    await expect(
      request(unpinned.client, {
        method: "eth_getStorageAt",
        params: ["0x1", "0x0", "latest"],
      }),
    ).rejects.toThrow("explicit block");
  });

  it("eth_getTransactionCount returns the higher count at pending/latest", async () => {
    const { client } = rig(value("0x5"), value("0x9"));
    await expect(
      request(client, { method: "eth_getTransactionCount", params: ["0x1", "pending"] }),
    ).resolves.toBe("0x9");
    await expect(
      request(client, { method: "eth_getTransactionCount", params: ["0x1", "latest"] }),
    ).resolves.toBe("0x9");
  });

  it("eth_getTransactionCount at a pinned block must agree", async () => {
    const same = rig(value("0x5"), value("0x5"));
    await expect(
      request(same.client, { method: "eth_getTransactionCount", params: ["0x1", BLOCK] }),
    ).resolves.toBe("0x5");
    const diff = rig(value("0x5"), value("0x6"));
    await expect(
      request(diff.client, { method: "eth_getTransactionCount", params: ["0x1", BLOCK] }),
    ).rejects.toThrow("disagree");
    await expect(
      request(same.client, {
        method: "eth_getTransactionCount",
        params: ["0x1", "earliest"],
      }),
    ).rejects.toThrow("explicit block");
  });

  it("eth_getBlockByNumber compares hash, number and timestamp only", async () => {
    /* Extra fields (miner, gasUsed, full tx objects) are outside the projection. */
    const { client } = rig(value(block({ miner: "0x1" })), value(block({ miner: "0x2" })));
    await expect(request(client, GET_BLOCK)).resolves.toMatchObject({ number: BLOCK });
    const offTime = rig(value(block()), value(block({ timestamp: "0x11" })));
    await expect(request(offTime.client, GET_BLOCK)).rejects.toThrow("disagree");
    const oneNull = rig(value(block()), value(null));
    await expect(request(oneNull.client, GET_BLOCK)).rejects.toThrow("disagree");
    await expect(
      request(client, { method: "eth_getBlockByNumber", params: ["latest", false] }),
    ).rejects.toThrow("explicit block");
  });

  it("eth_getLogs compares the normalised array over a numeric range", async () => {
    const { client } = rig(value([log()]), value([log()]));
    const call = {
      method: "eth_getLogs",
      params: [{ fromBlock: "0x60", toBlock: BLOCK, topics: ["0xaa"] }],
    };
    await expect(request(client, call)).resolves.toStrictEqual([log()]);
    const extra = rig(value([log()]), value([log(), log({ logIndex: "0x1" })]));
    await expect(request(extra.client, call)).rejects.toThrow("disagree");
    const cased = rig(value([log()]), value([log({ address: "0xabc", data: "0xcc" })]));
    await expect(request(cased.client, call)).resolves.toStrictEqual([log()]);
    await expect(
      request(client, {
        method: "eth_getLogs",
        params: [{ fromBlock: "0x60", toBlock: "latest" }],
      }),
    ).rejects.toThrow("explicit block");
  });

  it("a null receipt on either endpoint answers null; two present must agree", async () => {
    const oneNull = rig(value(receipt()), value(null));
    await expect(
      request(oneNull.client, { method: "eth_getTransactionReceipt", params: ["0xcd"] }),
    ).resolves.toBeNull();
    const bothNull = rig(value(null), value(null));
    await expect(
      request(bothNull.client, { method: "eth_getTransactionReceipt", params: ["0xcd"] }),
    ).resolves.toBeNull();
    const same = rig(value(receipt()), value(receipt()));
    await expect(
      request(same.client, { method: "eth_getTransactionReceipt", params: ["0xcd"] }),
    ).resolves.toMatchObject({ status: "0x1" });
    const diff = rig(value(receipt()), value(receipt({ status: "0x0" })));
    await expect(
      request(diff.client, { method: "eth_getTransactionReceipt", params: ["0xcd"] }),
    ).rejects.toThrow("disagree");
  });

  it("a null transaction on either endpoint answers null; two present must agree", async () => {
    const oneNull = rig(value(tx()), value(null));
    await expect(
      request(oneNull.client, { method: "eth_getTransactionByHash", params: ["0xcd"] }),
    ).resolves.toBeNull();
    const diff = rig(value(tx()), value(tx({ nonce: "0x3" })));
    await expect(
      request(diff.client, { method: "eth_getTransactionByHash", params: ["0xcd"] }),
    ).rejects.toThrow("disagree");
  });

  it("an erroring independent endpoint fails the call closed", async () => {
    const { client } = rig(value("0xaaaa"), failing("upstream down"));
    await expect(request(client, CALL)).rejects.toThrow("second rpc endpoint failed");
  });

  it("a primary error propagates to the caller", async () => {
    const { client } = rig(failing("connection refused"), value("0xaaaa"));
    await expect(request(client, CALL)).rejects.toThrow("connection refused");
  });

  it("not-needed and unavailable corroborators leave the primary alone", async () => {
    let secondCalls = 0;
    const notNeeded = rig(value("0xaaaa"), "not-needed");
    await expect(request(notNeeded.client, CALL)).resolves.toBe("0xaaaa");
    const unavailable = rig(value("0xaaaa"), "unavailable");
    await expect(request(unavailable.client, CALL)).resolves.toBe("0xaaaa");
    const counted = rig(value("0xaaaa"), async (call) => {
      secondCalls += 1;
      return value("0xaaaa")(call);
    });
    await expect(request(counted.client, CALL)).resolves.toBe("0xaaaa");
    expect(secondCalls).toBe(1);
  });

  it("refuses methods outside the sdk set", async () => {
    const { client, primaryCalls } = rig(value("0x0"));
    for (const method of [
      "eth_sendTransaction",
      "eth_estimateGas",
      "eth_getCode",
      "eth_subscribe",
      "net_version",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential refusals
      await expect(request(client, { method })).rejects.toThrow("not allowed");
    }
    expect(primaryCalls).toHaveLength(0);
  });

  it("error messages never carry params or results", async () => {
    const { client } = rig(value("0xaaaa"), value("0xbbbb"));
    const failure = await request(client, {
      method: "eth_call",
      params: [{ to: "0x50873C8501143e55349f9938795f69A2BB64b6ca", data: "0x8da5cb5b" }, BLOCK],
    }).catch((error: unknown) => error);
    const text = JSON.stringify(failure);
    expect(text).not.toContain("50873C8501143e55349f9938795f69A2BB64b6ca");
    expect(text).not.toContain("8da5cb5b");
    expect(text).not.toContain("0xaaaa");
    expect(text).not.toContain("0xbbbb");
  });

  it("refuses a non-quantity count answer as malformed, not a disagreement", async () => {
    const { client } = rig(value("not-hex"), value("0x9"));
    await expect(
      request(client, { method: "eth_getTransactionCount", params: ["0x1", "pending"] }),
    ).rejects.toThrow("malformed result");
  });

  it("eth_getLogs refuses a non-array answer and disagrees on a non-object entry", async () => {
    const call = {
      method: "eth_getLogs",
      params: [{ fromBlock: "0x60", toBlock: BLOCK, topics: ["0xaa"] }],
    };
    const junk = rig(value("junk"), value("junk"));
    await expect(request(junk.client, call)).rejects.toThrow("malformed result");
    const notObject = rig(value([log()]), value(["0xdead"]));
    await expect(request(notObject.client, call)).rejects.toThrow("disagree");
  });

  it("eth_getTransactionByHash disagrees on a hex-field difference", async () => {
    const { client } = rig(value(tx()), value(tx({ hash: "0xde" })));
    await expect(
      request(client, { method: "eth_getTransactionByHash", params: ["0xcd"] }),
    ).rejects.toThrow("disagree");
  });
});
