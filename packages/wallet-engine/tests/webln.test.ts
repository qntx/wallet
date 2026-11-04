import { describe, expect, it } from "vite-plus/test";

import type { LightningSendStatus } from "@qntx/spark";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { unauthorized } from "../src/connect/errors.ts";
import { WeblnHandler } from "../src/connect/webln.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";

const SITE = "https://app.example.com";
const REF: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "mainnet" };

const session = { id: "s1" } as never;

function rig(options: {
  authorized?: boolean;
  balancePolicy?: boolean;
  balance?: number;
  paymentStatus?: () => Promise<LightningSendStatus>;
  prepareResult?: unknown;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const sleeps: number[] = [];
  const requestsCalls: string[] = [];
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
    sparkAccount: () => REF,
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
  return { handler, sleeps, requestsCalls };
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

  it("still pending past the budget rejects -32603", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["pending"]),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: -32603 });
  }, 15000);

  it("success without a preimage rejects -32603", async () => {
    const { handler } = rig({
      prepareResult: payment,
      paymentStatus: paymentStatus(["succeeded"]),
    });
    await expect(
      handler.handle(SITE, { method: "sendPayment", params: invoice }),
    ).rejects.toMatchObject({ code: -32603 });
  });
});
