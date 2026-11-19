/**
 * The broadcast classifier only fails a transaction when the node itself refused its bytes.
 * `evmBroadcastVerdict` is driven with real viem errors produced by the same `fallback([http(url, {
 * fetchFn })])` transport the engine uses — never hand-built stand-ins.
 */
import { createPublicClient, fallback, http } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { EsploraError } from "../src/chains/bitcoin.ts";
import { esploraBroadcastVerdict } from "../src/transactions/bitcoin.ts";
import { broadcastOutcome, submitInOrder } from "../src/transactions/broadcast.ts";
import type { BroadcastAttempt } from "../src/transactions/broadcast.ts";
import { evmBroadcastVerdict } from "../src/transactions/evm.ts";
import { solanaBroadcastVerdict } from "../src/transactions/solana.ts";

const attempt = (over: Partial<BroadcastAttempt>): BroadcastAttempt => ({
  id: "tx-1",
  send: async () => Promise.resolve("tx-1"),
  verdict: () => undefined,
  known: async () => Promise.resolve(false),
  ...over,
});

describe("broadcastOutcome", () => {
  it("the endpoint echoing the same id is accepted", async () => {
    const outcome = await broadcastOutcome(attempt({}));
    expect(outcome).toStrictEqual({ kind: "accepted" });
  });

  it("the endpoint answering another id is unknown", async () => {
    const outcome = await broadcastOutcome(
      attempt({ send: async () => Promise.resolve("tx-other") }),
    );
    expect(outcome.kind).toBe("unknown");
  });

  it("a held verdict is accepted without asking whether the node knows it", async () => {
    let knownCalls = 0;
    const outcome = await broadcastOutcome(
      attempt({
        send: async () => Promise.reject(new Error("already known")),
        verdict: () => "held",
        known: async () => {
          knownCalls += 1;
          return Promise.resolve(true);
        },
      }),
    );
    expect(outcome).toStrictEqual({ kind: "accepted" });
    expect(knownCalls).toBe(0);
  });

  it("an unclassified error is unknown and the node is not asked", async () => {
    let knownCalls = 0;
    const outcome = await broadcastOutcome(
      attempt({
        send: async () => Promise.reject(new Error("socket hangup")),
        verdict: () => undefined,
        known: async () => {
          knownCalls += 1;
          return Promise.resolve(true);
        },
      }),
    );
    expect(outcome.kind).toBe("unknown");
    expect(knownCalls).toBe(0);
  });

  it("a refused verdict is accepted when the node turns out to know the id", async () => {
    const outcome = await broadcastOutcome(
      attempt({
        send: async () => Promise.reject(new Error("nonce too low")),
        verdict: () => "refused",
        known: async () => Promise.resolve(true),
      }),
    );
    expect(outcome).toStrictEqual({ kind: "accepted" });
  });

  it("a refused verdict stays refused when the node does not know the id", async () => {
    const outcome = await broadcastOutcome(
      attempt({
        send: async () => Promise.reject(new Error("nonce too low")),
        verdict: () => "refused",
        known: async () => Promise.resolve(false),
      }),
    );
    expect(outcome.kind).toBe("refused");
  });

  it("a refused verdict stays refused when the lookup fails", async () => {
    const outcome = await broadcastOutcome(
      attempt({
        send: async () => Promise.reject(new Error("nonce too low")),
        verdict: () => "refused",
        known: async () => Promise.reject(new Error("lookup down")),
      }),
    );
    expect(outcome.kind).toBe("refused");
  });
});

/**
 * Throws the error viem builds for one canned node answer — HTTP status, body, or a dead socket —
 * through the same `fallback([http])` transport the engine's clients use. `retryCount: 0` on both
 * transports keeps retriable answers (5xx, -32603) from re-firing with backoff.
 */
const viemError = async (response: () => Promise<Response>): Promise<unknown> => {
  const client = createPublicClient({
    transport: fallback([http("http://node.local", { fetchFn: response, retryCount: 0 })], {
      retryCount: 0,
    }),
  });
  try {
    await client.transport.request({ method: "eth_sendRawTransaction", params: ["0x01"] });
  } catch (error) {
    return error;
  }
  throw new Error("the request unexpectedly succeeded");
};

const rpcError = async (code: number, message: string): Promise<Response> =>
  Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } }));

describe("evmBroadcastVerdict", () => {
  it.each([
    ["nonce too low: next nonce 5, tx nonce 3", -32000, "refused"],
    ["insufficient funds for gas * price + value: have 0 want 1", -32000, "refused"],
    ["replacement transaction underpriced", -32000, "refused"],
    ["transaction rejected", -32003, "refused"],
    ["already known", -32000, "held"],
    ["Known transaction", -32000, "held"],
    ["internal error", -32603, undefined],
    ["txpool is full", -32000, undefined],
  ] as const)("%s → %s", async (message, code, expected) => {
    const error = await viemError(async () => rpcError(code, message));
    expect(evmBroadcastVerdict(error)).toBe(expected);
  });

  it("an HTTP 502 with a text body says nothing about the bytes", async () => {
    const error = await viemError(async () =>
      Promise.resolve(new Response("Bad Gateway", { status: 502 })),
    );
    expect(evmBroadcastVerdict(error)).toBeUndefined();
  });

  it("an HTTP 500 still lets the node's JSON-RPC error speak", async () => {
    const error = await viemError(async () =>
      Promise.resolve(
        Response.json(
          { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nonce too low" } },
          { status: 500 },
        ),
      ),
    );
    expect(evmBroadcastVerdict(error)).toBe("refused");
  });

  it("a dead socket says nothing about the bytes", async () => {
    const error = await viemError(async () => Promise.reject(new TypeError("fetch failed")));
    expect(evmBroadcastVerdict(error)).toBeUndefined();
  });

  it("a non-viem error is never a verdict, even with a node's wording", () => {
    expect(evmBroadcastVerdict(new Error("nonce too low"))).toBeUndefined();
  });
});

describe("solanaBroadcastVerdict", () => {
  it.each([
    [
      "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
      "refused",
    ],
    [
      "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1",
      "refused",
    ],
    ["Transaction simulation failed: Blockhash not found", undefined],
    ["Transaction simulation failed: This transaction has already been processed", "held"],
    ["Transaction signature verification failure", "refused"],
    ["invalid transaction: Transaction failed to sanitize accounts offsets correctly", "refused"],
    ["Node is unhealthy", undefined],
  ] as const)("%s → %s", (message, expected) => {
    expect(solanaBroadcastVerdict(new Error(message))).toBe(expected);
  });

  it("a transport error says nothing about the bytes", () => {
    expect(solanaBroadcastVerdict(new TypeError("fetch failed"))).toBeUndefined();
  });
});

describe("esploraBroadcastVerdict", () => {
  it("a 4xx node rejection is refused", () => {
    expect(esploraBroadcastVerdict(new EsploraError("esplora /tx: 400", false))).toBe("refused");
  });

  it("a 5xx or timeout says nothing about the bytes", () => {
    expect(esploraBroadcastVerdict(new EsploraError("esplora /tx: 502", true))).toBeUndefined();
    expect(esploraBroadcastVerdict(new TypeError("fetch failed"))).toBeUndefined();
    expect(esploraBroadcastVerdict(new Error("anything"))).toBeUndefined();
  });
});

describe("submitInOrder", () => {
  it("returns every id when all submissions go out", async () => {
    const batch = await submitInOrder(3, async (index) => Promise.resolve(`id-${index}`));
    expect(batch).toStrictEqual({ ids: ["id-0", "id-1", "id-2"] });
  });

  it("a failure of the first submission is thrown — nothing went out", async () => {
    let submitted = 0;
    await expect(
      submitInOrder(2, async () => {
        submitted += 1;
        return Promise.reject(new Error("refused"));
      }),
    ).rejects.toThrow("refused");
    expect(submitted).toBe(1);
  });

  it("a failure past the first returns the earlier ids and stops — later items never submit", async () => {
    const submitted: number[] = [];
    const batch = await submitInOrder(4, async (index) => {
      submitted.push(index);
      if (index === 1) {
        return Promise.reject(new Error("the node refused"));
      }
      return Promise.resolve(`id-${index}`);
    });
    expect(submitted).toStrictEqual([0, 1]);
    expect(batch).toStrictEqual({
      ids: ["id-0"],
      refused: { index: 1, error: "the node refused" },
    });
  });
});
