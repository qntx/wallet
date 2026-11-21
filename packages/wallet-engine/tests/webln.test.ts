import { describe, expect, it } from "vite-plus/test";

import type { LightningSendStatus } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { PAYMENT_PENDING_CODE, unauthorized } from "../src/connect/errors.ts";
import { WeblnHandler } from "../src/connect/webln.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";

const SITE = "https://app.example.com";
const REF: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "mainnet" };

const session = { id: "s1" } as never;

function rig(options: {
  authorized?: boolean;
  bound?: { walletId: string; groupIndex: number } | null;
  balancePolicy?: boolean;
  balance?: number;
  paymentStatus?: () => Promise<LightningSendStatus>;
  prepareResult?: unknown;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const sleeps: number[] = [];
  const requestsCalls: string[] = [];
  const preparedInputs: unknown[] = [];
  const handler = new WeblnHandler({
    connections: {
      checkOrigin: (origin) => ({ kind: "browser", origin }),
      authorize: () => {
        if (options.authorized === false) {
          throw unauthorized("test unauthorized");
        }
        return session;
      },
      session: () => session,
      sessionAccounts: () => {
        const bound =
          "bound" in options
            ? options.bound
            : { walletId: REF.walletId, groupIndex: REF.groupIndex };
        return bound === null || bound === undefined
          ? undefined
          : { group: bound, addresses: [`spark:${bound.walletId}:${String(bound.groupIndex)}`] };
      },
      lightningPolicy: () =>
        options.authorized === false ? undefined : { balance: options.balancePolicy === true },
      request: async () => {
        await Promise.resolve();
        throw new Error("connection request is not wired in this test");
      },
      touch: async () => Promise.resolve(),
    },
    requests: {
      prepare: async (input) => {
        await Promise.resolve();
        requestsCalls.push(input.method);
        preparedInputs.push(input);
        return { id: "req-1" } as never;
      },
      outcome: async () => Promise.resolve(options.prepareResult as never),
    },
    spark: {
      accountBalance: () => options.balance,
      paymentStatus: async () =>
        options.paymentStatus === undefined
          ? Promise.resolve({ outcome: "pending" } as LightningSendStatus)
          : options.paymentStatus(),
    },
    sparkNetwork: REF.network,
    now: options.now ?? (() => 0),
    alias: "qntx",
    lightningMaxFee: () => 10,
    sleep: async (ms) => {
      sleeps.push(ms);
      await Promise.resolve();
      if (options.sleep !== undefined) {
        await options.sleep(ms);
      }
    },
  });
  return { handler, sleeps, requestsCalls, preparedInputs };
}

describe("WeblnHandler", () => {
  it("rejects unauthorized origins with 4100", async () => {
    const { handler } = rig({ authorized: false });
    await expect(handler.handle(SITE, { method: "getInfo" })).rejects.toMatchObject({ code: 4100 });
  });

  it("enable resolves true when authorized", async () => {
    const { handler } = rig({});
    await expect(handler.handle(SITE, { method: "enable" })).resolves.toBe(true);
  });

  it("getInfo returns the alias and methods", async () => {
    const { handler } = rig({});
    await expect(handler.handle(SITE, { method: "getInfo" })).resolves.toMatchObject({
      node: { alias: "qntx" },
      methods: expect.arrayContaining(["sendPayment", "makeInvoice"]),
    });
  });

  it("makeInvoice validates amount and returns the payment request", async () => {
    const { handler, requestsCalls } = rig({
      prepareResult: { kind: "lightning.invoice", paymentRequest: "lnbc1x" },
    });
    const result = await handler.handle(SITE, {
      method: "makeInvoice",
      params: { amount: 100, defaultMemo: "hi" },
    });
    expect(result).toMatchObject({ paymentRequest: "lnbc1x" });
    expect(requestsCalls).toStrictEqual(["webln-invoice"]);
  });

  it("makeInvoice rejects a missing amount", async () => {
    const { handler } = rig({});
    await expect(
      handler.handle(SITE, { method: "makeInvoice", params: { memo: "x" } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("sendPayment rejects a non-BOLT11 invoice", async () => {
    const { handler } = rig({});
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: "not-an-invoice" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("getBalance needs lightningPolicy.balance", async () => {
    const { handler } = rig({ balancePolicy: false });
    await expect(handler.handle(SITE, { method: "getBalance" })).rejects.toMatchObject({
      code: 4100,
    });
  });

  it("builds the spark ref from the session's bound group", async () => {
    const { handler, preparedInputs } = rig({
      bound: { walletId: "w2", groupIndex: 1 },
      prepareResult: { kind: "lightning.invoice", paymentRequest: "lnbc1x" },
    });
    await handler.handle(SITE, { method: "makeInvoice", params: { amount: "10" } });
    expect(preparedInputs[0]).toMatchObject({
      ref: { walletId: "w2", groupIndex: 1, network: "mainnet" },
    });
  });

  it("rejects with 4100 when the session binds no lightning account", async () => {
    const { handler } = rig({ bound: null });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: "lnbc1x" }),
    ).rejects.toMatchObject({ code: 4100 });
  });

  it("getBalance returns the cached balance", async () => {
    const { handler } = rig({ balancePolicy: true, balance: 42000 });
    await expect(handler.handle(SITE, { method: "getBalance" })).resolves.toStrictEqual({
      balance: 42000,
      currency: "sats",
    });
  });
});

describe("WeblnHandler clock", () => {
  const TIMESTAMP = 1_700_000_000;
  const invoice = encodeTestBolt11({
    network: "mainnet",
    amountMsat: 100_000n,
    timestamp: TIMESTAMP,
    expirySeconds: 600,
    paymentHash: new Uint8Array(32).fill(9),
    secretKey: new Uint8Array(32).fill(1),
  });
  const payment = {
    kind: "lightning",
    payment: { requestId: "r1", paymentHash: new Uint8Array(32), amountSats: 100 },
  };

  it("rejects an invoice that expired by the injected clock", async () => {
    const { handler, requestsCalls } = rig({
      prepareResult: payment,
      now: () => (TIMESTAMP + 700) * 1000,
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(requestsCalls).toStrictEqual([]);
  });

  it("accepts the same invoice while the injected clock is inside its expiry", async () => {
    const { handler, requestsCalls } = rig({
      prepareResult: payment,
      paymentStatus: async () =>
        Promise.resolve({ outcome: "succeeded", preimage: new Uint8Array(32) } as never),
      now: () => (TIMESTAMP + 10) * 1000,
    });
    await handler.handle(SITE, { method: "sendPayment", params: invoice });
    expect(requestsCalls).toStrictEqual(["pay"]);
  });
});

describe("WeblnHandler preimage polling", () => {
  const invoice = encodeTestBolt11({
    network: "mainnet",
    amountMsat: 100_000n,
    paymentHash: new Uint8Array(32).fill(9),
    secretKey: new Uint8Array(32).fill(1),
  });
  const payment = {
    kind: "lightning",
    payment: { requestId: "r1", paymentHash: new Uint8Array(32), amountSats: 100 },
  };
  const paymentStatus = (
    statuses: Array<LightningSendStatus["outcome"]>,
    preimage?: Uint8Array,
  ) => {
    let i = 0;
    return async () => {
      const outcome = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      await Promise.resolve();
      return {
        outcome,
        ...(preimage === undefined ? {} : { preimage }),
      } as LightningSendStatus;
    };
  };

  it("returns the preimage once the payment settles succeeded", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["pending", "succeeded"], new Uint8Array(32).fill(7)),
    });
    const result = await handler.handle(SITE, { method: "sendPayment", params: invoice });
    expect(result).toStrictEqual({ preimage: "07".repeat(32) });
  });

  it("a failed terminal status rejects with -32603 payment failed", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["failed"]),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: -32603 });
  });

  it("still pending past the budget rejects with the payment-pending code", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["pending"]),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: PAYMENT_PENDING_CODE });
  }, 15000);

  it("a request that settles pending rejects with the payment-pending code", async () => {
    // An "unknown" controller error surfaces as a pending outcome — the dApp must see the
    // payment-pending code, never an opaque internal error it might retry blindly.
    const { handler } = rig({
      prepareResult: { kind: "pending", payment: { id: "tid-1" } },
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: PAYMENT_PENDING_CODE });
  });

  it("a paymentStatus read error inside the poll is pending, not failed", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: async () => Promise.reject(new Error("spark is unreachable")),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: PAYMENT_PENDING_CODE });
  });

  it("a returned terminal status still rejects -32603 payment failed", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["returned"]),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: -32603, message: "payment failed" });
  });

  it("success without a preimage rejects with the payment-pending code, never as failed", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["succeeded"]),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({
      code: PAYMENT_PENDING_CODE,
      message: "the payment settled but its preimage is unavailable; do not retry it",
    });
  });
});

describe("WeblnHandler pending payment outcomes", () => {
  const TIMESTAMP = 1_700_000_000;
  const invoice = encodeTestBolt11({
    network: "mainnet",
    amountMsat: 100_000n,
    timestamp: TIMESTAMP,
    expirySeconds: 600,
    paymentHash: new Uint8Array(32).fill(9),
    secretKey: new Uint8Array(32).fill(1),
  });
  const TRANSFER = "0190f0f0-0000-7000-8000-000000000000";

  it("a pending (lost commit answer) payment rejects with the pending code naming the transfer", async () => {
    const { handler, requestsCalls } = rig({
      prepareResult: {
        kind: "pending",
        payment: {
          id: TRANSFER,
          kind: "lightning",
          state: "unknown",
          receiver: "payee",
          amount: "100",
          submittedAt: TIMESTAMP * 1000,
        },
      },
      now: () => (TIMESTAMP + 10) * 1000,
    });
    const err = await handler.handle(SITE, { method: "sendPayment", params: invoice }).then(
      () => {
        throw new Error("sendPayment resolved");
      },
      (error: unknown) => error,
    );
    expect(err).toMatchObject({ code: PAYMENT_PENDING_CODE });
    expect((err as Error).message).toContain(TRANSFER);
    expect((err as { code: number }).code).not.toBe(-32603);
    expect(requestsCalls).toStrictEqual(["pay"]);
  });

  it("a settled lightning payment still resolves the preimage", async () => {
    const { handler } = rig({
      prepareResult: {
        kind: "lightning",
        payment: { requestId: "r1", paymentHash: new Uint8Array(32), amountSats: 100 },
      },
      paymentStatus: async () =>
        Promise.resolve({ outcome: "succeeded", preimage: new Uint8Array(32).fill(7) } as never),
      now: () => (TIMESTAMP + 10) * 1000,
    });
    const result = await handler.handle(SITE, { method: "sendPayment", params: invoice });
    expect(result).toStrictEqual({ preimage: "07".repeat(32) });
  });
});
