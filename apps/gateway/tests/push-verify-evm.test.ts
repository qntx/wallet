// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture accounts is inherent to
// asserting on them.
/**
 * `evmVerifier` through a real `createForwarder` over a scripted fake fetch: one JSON-RPC batch per
 * network (finalized head then receipts), failover on provider failure, `ProviderFailure`-class
 * errors for malformed answers, `unknown` for every uncertainty, and `PROVIDER_BUDGET` billed
 * exactly `rpcCost` of the batch.
 */
import { describe, expect, it } from "vite-plus/test";

import { rpcCost } from "../src/budget/costs.ts";
import { indexNetworks } from "../src/middleware/network.ts";
import type { ResolvedNetwork } from "../src/middleware/network.ts";
import { createForwarder } from "../src/providers/forward.ts";
import type { Forwarder } from "../src/providers/forward.ts";
import type { CheckResult } from "../src/push/rules.ts";
import { evmVerifier } from "../src/push/verify-evm.ts";
import type { ProviderBudget } from "../src/types.ts";
import { TEST_ACCOUNTS, fakeFetch } from "./helpers.ts";

const NETWORK_ID = "eip155:1";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const FROM = `0x${"1".repeat(40)}`;

const served: ReadonlyMap<string, ResolvedNetwork> = indexNetworks(
  [
    {
      id: NETWORK_ID,
      providers: [
        { id: "alchemy", url: "https://a.test/evm" },
        { id: "drpc", url: "https://b.test/evm" },
      ],
    },
  ],
  {},
  TEST_ACCOUNTS,
);

const receipt = (hash: string, status = "0x1", block = "0x64", from = FROM): unknown => ({
  transactionHash: hash,
  status,
  blockNumber: block,
  from,
  to: `0x${"2".repeat(40)}`,
});

const head = (number = "0x96"): unknown => ({ number, hash: `0x${"f".repeat(64)}` });

/** The batch reply: `eth_getBlockByNumber` head plus each receipt answer in request order. */
const batchReply = (_body: string, finalized: unknown, receipts: unknown[]): Response =>
  Response.json([
    { jsonrpc: "2.0", id: 0, result: finalized },
    ...receipts.map((result, index) => ({ jsonrpc: "2.0", id: index + 1, result })),
  ]);

type Setup = {
  readonly verify: ReturnType<typeof evmVerifier>;
  readonly takes: Array<{ account: string; units: number }>;
};

const setup = (handlers: Record<string, Parameters<typeof fakeFetch>[0][string]>): Setup => {
  const { fetch } = fakeFetch(handlers);
  const takes: Array<{ account: string; units: number }> = [];
  const budget: ProviderBudget = {
    take: async (account, units) => {
      await Promise.resolve();
      takes.push({ account, units });
      return { ok: true };
    },
  };
  const forwarder: Forwarder = createForwarder(fetch, () => undefined, { budget });
  return { verify: evmVerifier({ forwarder, served }), takes };
};

const absent: CheckResult = { kind: "absent" };
const unknown: CheckResult = { kind: "unknown" };
const included = (block = 0x64, final = true, success = true, from = FROM): CheckResult => ({
  kind: "included",
  success,
  block,
  final,
  from,
});

describe("evmVerifier", () => {
  it("answers absent, included and failed receipts in target order", async () => {
    const { verify } = setup({
      "https://a.test/": (call) => batchReply(call.body, head(), [receipt(HASH_A), null]),
    });
    const results = await verify([
      { network: NETWORK_ID, hash: HASH_A },
      { network: NETWORK_ID, hash: HASH_B },
    ]);
    expect(results).toStrictEqual([included(), absent]);
  });

  it("marks a receipt final only at or below the finalized head", async () => {
    const { verify } = setup({
      "https://a.test/": (call) =>
        batchReply(call.body, head("0x64"), [receipt(HASH_A, "0x1", "0x64")]),
    });
    const [atHead] = await verify([{ network: NETWORK_ID, hash: HASH_A }]);
    expect(atHead).toStrictEqual(included(0x64, true));
    const { verify: notFinal } = setup({
      "https://a.test/": (call) =>
        batchReply(call.body, head("0x63"), [receipt(HASH_A, "0x1", "0x64")]),
    });
    const [pastHead] = await notFinal([{ network: NETWORK_ID, hash: HASH_A }]);
    expect(pastHead).toStrictEqual(included(0x64, false));
  });

  it("stays non-final when the finalized tag is unsupported", async () => {
    const { verify } = setup({
      "https://a.test/": (call) =>
        batchReply(
          call.body,
          null, // no finalized head answered
          [receipt(HASH_A, "0x0")],
        ),
    });
    const [result] = await verify([{ network: NETWORK_ID, hash: HASH_A }]);
    expect(result).toStrictEqual(included(0x64, false, false));
  });

  it("answers unknown for a malformed batch, a mismatched hash and a missing id", async () => {
    const { verify: malformed } = setup({ "https://a.test/": () => new Response("not json") });
    await expect(malformed([{ network: NETWORK_ID, hash: HASH_A }])).resolves.toStrictEqual([
      unknown,
    ]);

    const { verify: mismatched } = setup({
      "https://a.test/": (call) => batchReply(call.body, head(), [receipt(HASH_B)]),
    });
    await expect(mismatched([{ network: NETWORK_ID, hash: HASH_A }])).resolves.toStrictEqual([
      unknown,
    ]);

    const { verify: missingId } = setup({
      "https://a.test/": (call) => {
        void call;
        return Response.json([{ jsonrpc: "2.0", id: 0, result: head() }]);
      },
    });
    await expect(missingId([{ network: NETWORK_ID, hash: HASH_A }])).resolves.toStrictEqual([
      unknown,
    ]);
  });

  it("fails a provider failure over to the next provider", async () => {
    const seen: string[] = [];
    const { verify } = setup({
      "https://a.test/": (call) => {
        seen.push("a");
        void call;
        return new Response(null, { status: 500 });
      },
      "https://b.test/": (call) => {
        seen.push("b");
        return batchReply(call.body, head(), [receipt(HASH_A, "0x0")]);
      },
    });
    const [result] = await verify([{ network: NETWORK_ID, hash: HASH_A }]);
    expect(result).toStrictEqual(included(0x64, true, false));
    expect(seen).toStrictEqual(["a", "b"]);
  });

  it("bills the provider account exactly rpcCost of the batch", async () => {
    const { verify, takes } = setup({
      "https://a.test/": (call) =>
        batchReply(call.body, head(), [receipt(HASH_A), receipt(HASH_B)]),
    });
    await verify([
      { network: NETWORK_ID, hash: HASH_A },
      { network: NETWORK_ID, hash: HASH_B },
    ]);
    // alchemy's model: 20 CU for eth_getBlockByNumber + 20 CU per receipt = 60.
    expect(takes).toStrictEqual([{ account: "alchemy", units: 60 }]);
    const model = TEST_ACCOUNTS["alchemy"]?.costs;
    if (model === undefined) {
      throw new TypeError("fixture: alchemy account");
    }
    expect(takes[0]?.units).toBe(
      rpcCost(model, [
        { method: "eth_getBlockByNumber" },
        { method: "eth_getTransactionReceipt" },
        { method: "eth_getTransactionReceipt" },
      ]),
    );
  });

  it("answers unknown for every target when every provider fails", async () => {
    const { verify } = setup({
      "https://a.test/": () => new Response(null, { status: 500 }),
      "https://b.test/": () => new Response(null, { status: 500 }),
    });
    await expect(verify([{ network: NETWORK_ID, hash: HASH_A }])).resolves.toStrictEqual([unknown]);
  });
});
