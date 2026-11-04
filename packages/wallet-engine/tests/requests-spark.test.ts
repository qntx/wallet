import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import type { Event } from "@qntx/nostr";
import { encodeSparkAddress } from "@qntx/spark";
import type { LnurlPayRequest } from "@qntx/spark/lnurl";
import { WalletError } from "@qntx/wallet";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { WalletEngine } from "../src/engine.ts";
import type { PaymentOption } from "../src/payments/parse.ts";
import { withdrawLnurl } from "../src/payments/pay.ts";
import type { PayInput } from "../src/requests/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import type { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, simulateSolanaStub } from "./send-helpers.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";

const NOW = 1_800_000_000_000;
const SECRET = new Uint8Array(32).fill(7);
const PAYEE = secp256k1.getPublicKey(SECRET, true);
const VERIFY = { kind: "password", password: "pw" } as const;
const REF: SparkAccountRef = { walletId: "w", groupIndex: 0, network: "regtest" };

const invoice = (amountMsat: bigint, metadata?: string): string =>
  encodeTestBolt11({
    network: "regtest",
    amountMsat,
    paymentHash: new Uint8Array(32).fill(3),
    secretKey: SECRET,
    timestamp: NOW / 1000,
    ...(metadata === undefined ? {} : { descriptionHash: sha256(utf8ToBytes(metadata)) }),
  });

const LIGHTNING_INVOICE = invoice(21_000n);

const lightningOption = (expiresAt: number): PaymentOption => ({
  kind: "lightning",
  invoice: LIGHTNING_INVOICE,
  amountSats: 21,
  paymentHash: "03".repeat(32),
  description: "coffee",
  expiresAt,
});

function world() {
  const calls: Array<{ method: string; params: unknown }> = [];
  let failWith: Error | undefined;
  const record = async (method: string, params: unknown) => {
    calls.push({ method, params });
    await Promise.resolve();
    if (failWith !== undefined) {
      throw failWith;
    }
    return { state: "succeeded" };
  };
  const spark = {
    send: async (_r: unknown, p: unknown) => record("send", p),
    payInvoice: async (_r: unknown, p: unknown) => record("payInvoice", p),
    paySparkInvoice: async (_r: unknown, p: unknown) => record("paySparkInvoice", p),
    withdraw: async (_r: unknown, p: unknown) => record("withdraw", p),
    createInvoice: async (_r: unknown, p: unknown) => {
      calls.push({ method: "createInvoice", params: p });
      await Promise.resolve();
      return { invoice: "lnbcrt1stub" };
    },
  } as unknown as SparkController;
  const fetchCalls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    await Promise.resolve();
    const amountMsat = BigInt(new URL(url).searchParams.get("amount") ?? "0");
    return Response.json({ pr: invoice(amountMsat, PAY_REQUEST.metadata), routes: [] });
  };
  let now = NOW;
  let counter = 0;
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    simulateSolana: simulateSolanaStub,
    nostrSign: async (_ref, _event): Promise<Event> => {
      await Promise.resolve();
      throw new Error("nostr-sign is not wired in this test");
    },
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("solana-sign is not wired in this test");
    },
    transactions: {} as TransactionController,
    ...bookDeps(),
    spark,
    fetch: fetchImpl,
    random: (n) => {
      counter += 1;
      return new Uint8Array(n).fill(counter);
    },
    now: () => now,
    setTimer: () => () => undefined,
    logger: { warn: () => undefined },
  });
  return {
    requests,
    calls,
    fetchCalls,
    advance: (ms: number) => {
      now += ms;
    },
    failWith: (error: Error | undefined) => {
      failWith = error;
    },
    spark,
    fetch: fetchImpl,
    now: () => now,
  };
}

const PAY_REQUEST: LnurlPayRequest = {
  tag: "payRequest",
  callback: "https://service.io/invoice",
  minSendableMsat: 1000,
  maxSendableMsat: 100_000_000,
  metadata: "[]",
  description: "pay Alice",
  commentAllowed: 0,
  allowsNostr: false,
};

describe("Spark requests", () => {
  it("a lightning request carries a display that matches what is paid", async () => {
    const w = world();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "pay",
      account: REF,
      option: lightningOption(NOW + 120_000),
      maxFeeSats: 5,
    });
    expect(request).toMatchObject({
      method: "pay",
      stage: "awaiting-approval",
      verification: "verified",
      checks: [],
      display: {
        family: "spark",
        kind: "lightning",
        network: "regtest",
        amountSats: 21,
        maxFeeSats: 5,
        receiver: bytesToHex(PAYEE),
        description: "coffee",
      },
    });
    const result = await w.requests.approve(request.id, "pay", VERIFY);
    expect(result.kind).toBe("lightning");
    expect(w.calls).toStrictEqual([
      {
        method: "payInvoice",
        params: { invoice: LIGHTNING_INVOICE, maxFeeSats: 5, verify: VERIFY },
      },
    ]);
    expect(w.requests.getState().requests[request.id]?.stage).toBe("submitted");
  });

  it("a transfer display names the receiver and amount", async () => {
    const w = world();
    await w.requests.init();
    const address = encodeSparkAddress({ network: "regtest", identityPublicKey: PAYEE });
    const request = await w.requests.prepare({
      method: "pay",
      account: REF,
      option: { kind: "spark", address },
      amountSats: 42,
    });
    expect(request.display).toStrictEqual({
      family: "spark",
      kind: "transfer",
      network: "regtest",
      amountSats: 42,
      receiver: address,
    });
    await w.requests.approve(request.id, "pay", VERIFY);
    expect(w.calls[0]).toStrictEqual({
      method: "send",
      params: { receiver: address, amountSats: 42, verify: VERIFY },
    });
  });

  it("an invoice that nears expiry after prepare fails approval without touching spark", async () => {
    const w = world();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "pay",
      account: REF,
      option: lightningOption(NOW + 120_000),
      maxFeeSats: 5,
    });
    w.advance(60_001);
    await expect(w.requests.approve(request.id, "pay", VERIFY)).rejects.toThrow("expired");
    expect(w.requests.getState().requests[request.id]).toMatchObject({ stage: "failed" });
    expect(w.calls).toStrictEqual([]);
  });

  it("an LNURL invoice is fetched once, at prepare", async () => {
    const w = world();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "pay",
      account: REF,
      option: { kind: "lnurl-pay", request: PAY_REQUEST },
      amountSats: 50,
      maxFeeSats: 5,
    });
    expect(w.fetchCalls).toHaveLength(1);
    expect(request.display).toMatchObject({ amountSats: 50, description: "pay Alice" });
    await w.requests.approve(request.id, "pay", VERIFY);
    expect(w.fetchCalls).toHaveLength(1);
    expect(w.calls.map((c) => c.method)).toStrictEqual(["payInvoice"]);
  });

  it("records fee-exceeds-amount exactly when maxFeeSats reaches the amount", async () => {
    const w = world();
    await w.requests.init();
    const lightning = async (maxFeeSats: number) =>
      w.requests.prepare({
        method: "pay",
        account: REF,
        option: lightningOption(NOW + 120_000),
        maxFeeSats,
      });
    const below = await lightning(20);
    const at = await lightning(21);
    const above = await lightning(22);
    expect(below.checks).toStrictEqual([]);
    expect(at).toMatchObject({ checks: ["fee-exceeds-amount"], verification: "unverifiable" });
    expect(above.checks).toStrictEqual(["fee-exceeds-amount"]);

    const exit = async (maxFeeSats: number) =>
      w.requests.prepare({
        method: "pay",
        account: REF,
        option: { kind: "bitcoin", address: "bcrt1pexample" },
        amountSats: 1000,
        maxFeeSats,
      });
    const exitBelow = await exit(999);
    const exitAt = await exit(1000);
    expect(exitBelow.checks).toStrictEqual([]);
    expect(exitAt.checks).toStrictEqual(["fee-exceeds-amount"]);
  });

  it("a zap request pays the prepared invoice with its fee ceiling", async () => {
    const w = world();
    await w.requests.init();
    const zap = {
      zapRequest: {} as never,
      invoice: LIGHTNING_INVOICE,
      paymentHash: "03".repeat(32),
      expiresAt: NOW + 300_000,
      amountSats: 21,
      receiptPubkey: "aa".repeat(32),
      recipientPubkey: "ee".repeat(32),
      comment: "gm",
      lightning: "alice@svc.test",
    };
    const request = await w.requests.prepare({ method: "zap", account: REF, zap, maxFeeSats: 5 });
    expect(request.display).toMatchObject({ kind: "lightning", amountSats: 21, description: "gm" });
    await w.requests.approve(request.id, "zap", VERIFY);
    expect(w.calls[0]).toMatchObject({
      method: "payInvoice",
      params: { invoice: LIGHTNING_INVOICE, maxFeeSats: 5, note: { kind: "zap" } },
    });
  });

  it("a lock invalidates an unfinished Spark request", async () => {
    const w = world();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "pay",
      account: REF,
      option: lightningOption(NOW + 120_000),
      maxFeeSats: 5,
    });
    w.requests.lock();
    expect(w.requests.getState().requests[request.id]?.stage).toBe("invalidated");
    await expect(w.requests.approve(request.id, "pay", VERIFY)).rejects.toThrow("invalidated");
    expect(w.calls).toStrictEqual([]);
  });

  it("a failed payment is `failed`, a refused verification `rejected`", async () => {
    const w = world();
    await w.requests.init();
    const prepare = async () =>
      w.requests.prepare({
        method: "pay",
        account: REF,
        option: lightningOption(NOW + 120_000),
        maxFeeSats: 5,
      });
    w.failWith(new Error("route not found"));
    const a = await prepare();
    await expect(w.requests.approve(a.id, "pay", VERIFY)).rejects.toThrow("route not found");
    expect(w.requests.getState().requests[a.id]?.stage).toBe("failed");

    w.failWith(new WalletError("cancelled", "user cancelled"));
    const b = await prepare();
    await expect(w.requests.approve(b.id, "pay", VERIFY)).rejects.toThrow("cancelled");
    expect(w.requests.getState().requests[b.id]?.stage).toBe("rejected");
  });

  it("the method must match: a pay request cannot be approved as zap", async () => {
    const w = world();
    await w.requests.init();
    const request = await w.requests.prepare({
      method: "pay",
      account: REF,
      option: lightningOption(NOW + 120_000),
      maxFeeSats: 5,
    });
    await expect(w.requests.approve(request.id, "zap", VERIFY)).rejects.toThrow("not zap");
    expect(w.calls).toStrictEqual([]);
  });

  it("withdrawLnurl needs no verification factor", async () => {
    const w = world();
    await withdrawLnurl(
      { spark: w.spark, fetch: w.fetch, now: w.now },
      {
        account: REF,
        option: {
          kind: "lnurl-withdraw",
          request: {
            tag: "withdrawRequest",
            callback: "https://service.io/withdraw",
            k1: "k",
            minWithdrawableMsat: 1000,
            maxWithdrawableMsat: 100_000,
            defaultDescription: "withdraw",
          },
        },
        amountSats: 50,
      },
    ).catch(() => undefined);
    expect(w.calls.map((c) => c.method)).toStrictEqual(["createInvoice"]);
    expect(JSON.stringify(w.calls[0]?.params)).not.toContain("verify");
  });
});

describe("engine surface", () => {
  it("engine.spark no longer exposes the payment methods", () => {
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("send");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("payInvoice");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("paySparkInvoice");
    expectTypeOf<WalletEngine["spark"]>().not.toHaveProperty("withdraw");
    expectTypeOf<WalletEngine["spark"]>().toHaveProperty("createInvoice");
    expectTypeOf<WalletEngine["payments"]>().not.toHaveProperty("pay");
    expectTypeOf<WalletEngine["zaps"]>().not.toHaveProperty("pay");
    expectTypeOf<WalletEngine["payments"]>().toHaveProperty("withdrawLnurl");
    expectTypeOf<PayInput>().toHaveProperty("method");
  });
});
