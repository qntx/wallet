/**
 * R4 PoC — finding: "a post-commit Spark failure is categorized by message text, not by class,
 * and escapes WebLN as an opaque internal error". `categorize` tests the message for
 * /rejected/ before it looks at `error.name === "SparkRequestError"`, so a real network failure
 * ("status 502 … rejected the request") is filed `rejected` — not `network`, not retried under
 * the same transfer id. A definite post-commit refusal from the coordinator ("send request is
 * for a different invoice") is likewise `internal`: the payment was already committed yet the
 * caller is told an ordinary failure rather than `unknown`. Expected-correct behaviour: error
 * class and structured code decide the category, and a post-commit failure surfaces as
 * `unknown` (or `payment-pending` over the bridge) so the dApp does not retry blindly.
 * `retryRig` is a copy of tests/spark-controller.test.ts's; the Webln rig is a copy of
 * tests/webln.test.ts's with `requests.outcome` rejecting.
 */
import { SparkError, SparkRequestError } from "@qntx/spark";
import type { SparkClient, SparkEvent } from "@qntx/spark";
import { describe, expect, it } from "vite-plus/test";

import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { PAYMENT_PENDING_CODE, ProviderError } from "../../src/connect/errors.ts";
import { WeblnHandler } from "../../src/connect/webln.ts";
import type { EngineLogger } from "../../src/events.ts";
import { RequestEndedError } from "../../src/requests/controller.ts";
import { SparkController } from "../../src/spark/controller.ts";
import { SparkControllerError, categorize } from "../../src/spark/errors.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { encodeTestBolt11 } from "../support/bolt11.ts";

const PK = new Uint8Array(33).fill(2);
const REF: SparkAccountRef = { walletId: "w1", groupIndex: 0, network: "regtest" };
const VERIFY = { kind: "password", password: new Uint8Array([1]) } as never;
const LOGGER: EngineLogger = { warn: () => {} };
const TID = "01936f00-1111-7111-8111-111111111111";

type Method = "send" | "pay" | "invoicePay" | "exit";

/** Copied from tests/spark-controller.test.ts — client calls queue scripted outcomes. */
function retryRig(script: Partial<Record<Method, ReadonlyArray<Error | "ok">>>) {
  const calls: Array<{ method: Method; params: unknown }> = [];
  const waits: number[] = [];
  const queues: Record<Method, Array<Error | "ok">> = {
    send: [...(script.send ?? ["ok"])],
    pay: [...(script.pay ?? ["ok"])],
    invoicePay: [...(script.invoicePay ?? ["ok"])],
    exit: [...(script.exit ?? ["ok"])],
  };
  const commit = async (method: Method, params: unknown): Promise<unknown> => {
    calls.push({ method, params });
    const outcome = queues[method].shift() ?? "ok";
    return outcome === "ok" ? Promise.resolve(params) : Promise.reject(outcome);
  };
  const client = {
    identityPublicKey: async () => Promise.resolve(PK),
    balance: async () => Promise.resolve(42),
    transfers: {
      claimPending: async () => Promise.resolve({ leaves: [], failures: [] }),
      claim: async () => Promise.resolve([]),
      history: async () => Promise.resolve({ payments: [], nextOffset: undefined }),
      send: async (o: unknown) => commit("send", o),
    },
    lightning: {
      createInvoice: async (o: unknown) => Promise.resolve(o),
      pay: async (o: unknown) => commit("pay", o),
    },
    invoices: {
      pay: async (_invoice: unknown, o: unknown) => commit("invoicePay", o),
    },
    withdrawals: {
      quoteCooperativeExit: async () =>
        Promise.resolve({ fees: { fast: 5, medium: 3, slow: 1 } }),
      cooperativeExit: async (o: unknown) => commit("exit", o),
    },
    // The stream never ends — the loop parks inside it and never takes a resubscribe backoff.
    events: () =>
      (async function* (): AsyncGenerator<SparkEvent> {
        await new Promise(() => undefined);
        yield* [];
      })(),
    close: () => undefined,
  };
  const approvals: unknown[] = [];
  const c = new SparkController({
    // Backoff sleeps resolve on the next microtask — the test never waits on the wall clock.
    setTimer: (ms, fn) => {
      waits.push(ms);
      queueMicrotask(fn);
      return () => undefined;
    },
    spark: {
      signer: () => null as never,
      approve: async (p: unknown) => {
        approvals.push(p);
        return Promise.resolve({});
      },
    },
    fetch: async () => Promise.reject(new Error("no fetch")),
    now: () => 0,
    logger: LOGGER,
    createClient: () => client as unknown as SparkClient,
  });
  c.setAccounts([REF]);
  c.setStore(createMemoryEngineStore());
  return { c, calls, waits, approvals };
}

const SITE = "https://app.example.com";
const WEBLN_REF: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "mainnet" };
const session = { id: "s1" } as never;

/** Copied from tests/webln.test.ts, extended with `outcomeError` for a rejecting request. */
function weblnRig(options: { outcomeError?: unknown; now?: () => number }) {
  const handler = new WeblnHandler({
    connections: {
      checkOrigin: (origin) => ({ kind: "browser", origin }),
      authorize: () => session,
      session: () => session,
      sessionAccounts: () => ({
        group: { walletId: WEBLN_REF.walletId, groupIndex: WEBLN_REF.groupIndex },
        addresses: [`spark:${WEBLN_REF.walletId}:${String(WEBLN_REF.groupIndex)}`],
      }),
      lightningPolicy: () => ({ balance: false }),
      request: async () => {
        await Promise.resolve();
        throw new Error("connection request is not wired in this test");
      },
      touch: async () => Promise.resolve(),
    },
    requests: {
      prepare: async () => {
        await Promise.resolve();
        return { id: "req-1" } as never;
      },
      outcome: async () =>
        options.outcomeError === undefined
          ? Promise.resolve({ kind: "lightning", payment: {} } as never)
          : Promise.reject(options.outcomeError as Error),
    },
    spark: {
      accountBalance: () => undefined,
      paymentStatus: async () => Promise.resolve({ outcome: "pending" } as never),
    },
    sparkNetwork: WEBLN_REF.network,
    now: options.now ?? (() => 0),
    alias: "qntx",
    lightningMaxFee: () => 10,
    sleep: async () => Promise.resolve(),
  });
  return { handler };
}

describe("post-commit spark failures mislabel their category", () => {
  it("categorize reads 'rejected' inside a network failure's message before its class name", () => {
    // A coordinator refusal after commit: no keyword, no network shape — "internal".
    expect(categorize(new SparkError("sendTransfer: coordinator returned no transfer"))).toBe(
      "internal",
    );
    // An HTTP 502 IS a network failure — but the message regex runs first and "rejected the
    // request" wins over the SparkRequestError name check.
    expect(
      categorize(
        new SparkRequestError("ssp request failed with status 502: upstream rejected the request", {
          code: "http_502",
        }),
      ),
    ).toBe("rejected");
  });

  it("a definite post-commit refusal fails 'internal' — approved, committed, never retried", async () => {
    const { c, calls, waits, approvals } = retryRig({
      pay: [new SparkError("lightning pay: ssp send request is for a different invoice")],
    });
    await c.init();
    let commits = 0;
    const failure = await c
      .payInvoice(REF, {
        invoice: "lnbcrt1x",
        maxFeeSats: 5,
        transferId: TID,
        verify: VERIFY,
        commit: () => {
          commits += 1;
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // The payment was committed before the coordinator's refusal; "internal" hides that the
    // outcome may have settled — the correct surface is "unknown".
    expect(failure).toBeInstanceOf(SparkControllerError);
    expect(failure).toMatchObject({ category: "internal" });
    expect(approvals).toHaveLength(1); // the spend was approved
    expect(commits).toBe(1); // commit() ran — the payment may be live
    expect(calls.filter((x) => x.method === "pay")).toHaveLength(1);
    expect(waits).toStrictEqual([]); // no retry under the same transfer id
    await c.destroy();
  });

  it("a failed request escapes WeblnHandler as a raw RequestEndedError — the bridge maps it to -32603", async () => {
    const TIMESTAMP = 1_700_000_000;
    const invoice = encodeTestBolt11({
      network: "mainnet",
      amountMsat: 100_000n,
      timestamp: TIMESTAMP,
      expirySeconds: 600,
      paymentHash: new Uint8Array(32).fill(9),
      secretKey: new Uint8Array(32).fill(1),
    });
    const { handler } = weblnRig({
      outcomeError: new RequestEndedError("failed", "spark action failed"),
      now: () => (TIMESTAMP + 10) * 1000,
    });
    const failure = await handler
      .handle(SITE, { method: "sendPayment", params: invoice })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // The raw RequestEndedError escapes the handler; it is not a ProviderError, so
    // createBrowserBridge's errorData reports it to the page as -32603 "internal error" — a
    // possibly-settled payment is indistinguishable from a crash.
    expect(failure).toBeInstanceOf(RequestEndedError);
    expect(failure).not.toBeInstanceOf(ProviderError);
    expect((failure as { code?: number }).code).not.toBe(PAYMENT_PENDING_CODE);
  });
});
