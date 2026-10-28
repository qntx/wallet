import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { encodeSparkAddress } from "@qntx/spark";
import type { SparkNetwork } from "@qntx/spark";
import { encodeLnurl, lightningAddressUrl } from "@qntx/spark/lnurl";
import type { LnurlPayRequest, LnurlWithdrawRequest } from "@qntx/spark/lnurl";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import { PaymentError } from "../src/payments/errors.ts";
import { parsePayment } from "../src/payments/parse.ts";
import type { PaymentOption, PaymentParse } from "../src/payments/parse.ts";
import { pay } from "../src/payments/pay.ts";
import type { PayContext } from "../src/payments/pay.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";
import { mulberry32 } from "./support/mulberry32.ts";

const NOW = 1_800_000_000_000;
const SECRET = new Uint8Array(32).fill(7);
const PUBKEY = secp256k1.getPublicKey(new Uint8Array(32).fill(9), true);
const PAYMENT_HASH = new Uint8Array(32).fill(3);

const REGTEST = { network: "regtest" as SparkNetwork, now: NOW };
const MAINNET = { network: "mainnet" as SparkNetwork, now: NOW };

const REGTEST_SPARK_ADDRESS = encodeSparkAddress({
  network: "regtest",
  identityPublicKey: PUBKEY,
});
const MAINNET_SPARK_ADDRESS = encodeSparkAddress({
  network: "mainnet",
  identityPublicKey: PUBKEY,
});

type Bolt11Options = Omit<Parameters<typeof encodeTestBolt11>[0], "paymentHash" | "secretKey">;
const bolt11 = (opts: Bolt11Options): string =>
  encodeTestBolt11({ ...opts, paymentHash: PAYMENT_HASH, secretKey: SECRET });

const REGTEST_BOLT11 = bolt11({ network: "regtest", amountMsat: 21_000n, timestamp: NOW / 1000 });
const MAINNET_BOLT11 = bolt11({ network: "mainnet", amountMsat: 21_000n, timestamp: NOW / 1000 });

const MAINNET_P2PKH = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const REGTEST_P2TR = "bcrt1p6rxklt0fj70uncxvx57cup4z9apavkw0p8y0jzvrf6qydr62l9nqd94jkz";
const MAINNET_P2TR = "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9";

function options(parse: PaymentParse): ReadonlyArray<PaymentOption> {
  return requestOf(parse).options;
}

/** Narrows a parse to `request` — throws (fails the test) otherwise. */
function requestOf(parse: PaymentParse) {
  if (parse.kind !== "request") {
    throw new Error(`expected request, got ${JSON.stringify(parse)}`);
  }
  return parse.request;
}

describe("parsePayment", () => {
  it("parses a bare spark address", () => {
    const result = parsePayment(REGTEST_SPARK_ADDRESS, REGTEST);
    const opts = options(result);
    expect(opts).toStrictEqual([{ kind: "spark", address: REGTEST_SPARK_ADDRESS }]);
  });

  it("rejects a spark address on the wrong network", () => {
    expect(parsePayment(MAINNET_SPARK_ADDRESS, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "network",
    });
    expect(parsePayment(REGTEST_SPARK_ADDRESS, MAINNET)).toStrictEqual({
      kind: "invalid",
      reason: "network",
    });
  });

  it("parses a bare bolt11 with amount", () => {
    const result = parsePayment(REGTEST_BOLT11, REGTEST);
    const opts = options(result);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({
      kind: "lightning",
      invoice: REGTEST_BOLT11,
      amountSats: 21,
      paymentHash: bytesToHex(PAYMENT_HASH),
    });
  });

  it("accepts the lightning: prefix", () => {
    const result = parsePayment(`lightning:${REGTEST_BOLT11}`, REGTEST);
    expect(result.kind).toBe("request");
  });

  it("rejects a bolt11 for the wrong network", () => {
    expect(parsePayment(MAINNET_BOLT11, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "network",
    });
  });

  it("rejects an expired bolt11", () => {
    const expired = bolt11({ network: "regtest", timestamp: NOW / 1000 - 90_000 });
    expect(parsePayment(expired, REGTEST)).toStrictEqual({ kind: "invalid", reason: "expired" });
  });

  it("rejects a bolt11 expiring within 60 seconds", () => {
    const soon = bolt11({
      network: "regtest",
      timestamp: NOW / 1000 - 3550,
      expirySeconds: 3600,
    });
    expect(parsePayment(soon, REGTEST)).toStrictEqual({ kind: "invalid", reason: "expired" });
  });

  it("parses a bare bitcoin address", () => {
    const result = parsePayment(REGTEST_P2TR, REGTEST);
    expect(options(result)).toStrictEqual([{ kind: "bitcoin", address: REGTEST_P2TR }]);
  });

  it("rejects a bitcoin address on the wrong network", () => {
    expect(parsePayment(MAINNET_P2TR, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "network",
    });
    expect(parsePayment(REGTEST_P2TR, MAINNET)).toStrictEqual({
      kind: "invalid",
      reason: "network",
    });
    expect(parsePayment(MAINNET_P2PKH, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "network",
    });
  });

  it("parses BIP-21 with address and amount", () => {
    const uri = `bitcoin:${REGTEST_P2TR}?amount=0.001&label=Luke-Jr&message=Donation%20xyz`;
    const request = requestOf(parsePayment(uri, REGTEST));
    expect(request.amountSats).toBe(100_000);
    expect(request.label).toBe("Luke-Jr");
    expect(request.message).toBe("Donation xyz");
    expect(request.options.at(-1)).toStrictEqual({
      kind: "bitcoin",
      address: REGTEST_P2TR,
    });
  });

  it("accepts a case-insensitive BITCOIN: scheme", () => {
    const result = parsePayment(`BITCOIN:${REGTEST_P2TR}?amount=1`, REGTEST);
    expect(result.kind).toBe("request");
  });

  it("orders BIP-21 options spark → lightning → bitcoin", () => {
    const uri = `bitcoin:${REGTEST_P2TR}?spark=${REGTEST_SPARK_ADDRESS}&lightning=${REGTEST_BOLT11}`;
    const request = requestOf(parsePayment(uri, REGTEST));
    expect(request.options.map((o) => o.kind)).toStrictEqual(["spark", "lightning", "bitcoin"]);
  });

  it("rejects BIP-21 duplicate params and unknown req- params", () => {
    expect(parsePayment(`bitcoin:${REGTEST_P2TR}?amount=1&amount=2`, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "malformed",
    });
    expect(parsePayment(`bitcoin:${REGTEST_P2TR}?req-unknown=1`, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "malformed",
    });
  });

  it("rejects a BIP-21 amount with >8 decimals", () => {
    expect(parsePayment(`bitcoin:${REGTEST_P2TR}?amount=1.123456789`, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "malformed",
    });
  });

  it("rejects a BIP-21 amount that mismatches the bolt11 amount", () => {
    const uri = `bitcoin:${REGTEST_P2TR}?amount=0.5&lightning=${REGTEST_BOLT11}`;
    expect(parsePayment(uri, REGTEST)).toStrictEqual({
      kind: "invalid",
      reason: "amount-mismatch",
    });
  });

  it("accepts a matching BIP-21 amount and bolt11", () => {
    const uri = `bitcoin:${REGTEST_P2TR}?amount=0.00000021&lightning=${REGTEST_BOLT11}`;
    const request = requestOf(parsePayment(uri, REGTEST));
    expect(request.amountSats).toBe(21);
  });

  it("reports bolt12-only BIP-21 as unsupported", () => {
    const result = parsePayment(`bitcoin:?lno=lno1qcp4256ypg`, REGTEST);
    expect(result).toStrictEqual({ kind: "unsupported", format: "bolt12" });
  });

  it("reports silent-payment-only BIP-21 as unsupported", () => {
    const result = parsePayment(`bitcoin:?sp=sp1qqgste7k9hx0q8`, REGTEST);
    expect(result).toStrictEqual({ kind: "unsupported", format: "silent-payment" });
  });

  it("parses a spark invoice address into a spark-invoice option", () => {
    const invoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PUBKEY,
      invoice: {
        version: 1,
        id: "01936f00-0000-7000-8000-000000000001",
        payment: { type: "sats", amount: 500 },
        memo: "for coffee",
      },
    });
    const result = parsePayment(invoice, REGTEST);
    const opts = options(result);
    expect(opts).toStrictEqual([
      {
        kind: "spark-invoice",
        invoice,
        amountSats: 500,
        memo: "for coffee",
      },
    ]);
  });

  it("reports a spark token invoice as unsupported", () => {
    const invoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PUBKEY,
      invoice: {
        version: 1,
        id: "01936f00-0000-7000-8000-000000000002",
        payment: { type: "tokens", amount: new Uint8Array([0, 1]) },
      },
    });
    expect(parsePayment(invoice, REGTEST)).toStrictEqual({
      kind: "unsupported",
      format: "spark-token-invoice",
    });
  });

  it("reports an expired spark invoice", () => {
    const invoice = encodeSparkAddress({
      network: "regtest",
      identityPublicKey: PUBKEY,
      invoice: {
        version: 1,
        id: "01936f00-0000-7000-8000-000000000003",
        payment: { type: "sats", amount: 500 },
        expiresAt: NOW - 1,
      },
    });
    expect(parsePayment(invoice, REGTEST)).toStrictEqual({ kind: "invalid", reason: "expired" });
  });

  it("decodes a bech32 LNURL into an lnurl result", () => {
    const url = "https://service.io/api/lnurl-pay?tag=payRequest";
    const result = parsePayment(encodeLnurl(url), REGTEST);
    expect(result).toStrictEqual({ kind: "lnurl", url });
  });

  it("maps lnurlp:// and lnurlw:// to https urls", () => {
    const pay = parsePayment("lnurlp://service.io/api?tag=payRequest", REGTEST);
    expect(pay).toStrictEqual({ kind: "lnurl", url: "https://service.io/api?tag=payRequest" });
    const withdraw = parsePayment("lnurlw://service.io/api?tag=withdrawRequest", REGTEST);
    expect(withdraw).toStrictEqual({
      kind: "lnurl",
      url: "https://service.io/api?tag=withdrawRequest",
    });
  });

  it("rejects lnurl login endpoints as unsupported auth", () => {
    const keyauth = parsePayment("keyauth://auth.example/login?tag=login", REGTEST);
    expect(keyauth).toStrictEqual({ kind: "unsupported", format: "lnurl-auth" });
    const loginLnurl = parsePayment(
      encodeLnurl("https://auth.example/login?tag=login&k1=00"),
      REGTEST,
    );
    expect(loginLnurl).toStrictEqual({ kind: "unsupported", format: "lnurl-auth" });
  });

  it("maps a lightning address to an lnurl result with the address attached", () => {
    const result = parsePayment("satoshi@wallet.example", REGTEST);
    expect(result).toStrictEqual({
      kind: "lnurl",
      url: lightningAddressUrl("satoshi@wallet.example"),
      address: "satoshi@wallet.example",
    });
  });

  it("reports nostr+walletconnect as unsupported", () => {
    const result = parsePayment(
      "nostr+walletconnect://abcdef?relay=wss://relay.example&secret=00",
      REGTEST,
    );
    expect(result).toStrictEqual({ kind: "unsupported", format: "nostr-wallet-connect" });
  });

  it("returns unrecognized for garbage", () => {
    expect(parsePayment("hello world", REGTEST)).toStrictEqual({ kind: "unrecognized" });
    expect(parsePayment("lnbc1notaninvoice", REGTEST)).toStrictEqual({ kind: "unrecognized" });
    expect(parsePayment("", REGTEST)).toStrictEqual({ kind: "unrecognized" });
  });
});

describe("parsePayment fuzz", () => {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/?&=@.%+-_#![]()";

  it("never throws on random strings", () => {
    const rand = mulberry32(0xdeadbeef);
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(rand() * 200);
      let input = "";
      for (let j = 0; j < length; j++) {
        input += alphabet[Math.floor(rand() * alphabet.length)];
      }
      const result = parsePayment(input, REGTEST);
      expect(["request", "lnurl", "unsupported", "invalid", "unrecognized"]).toContain(result.kind);
    }
  });

  it("never throws on mutations of valid inputs", () => {
    const rand = mulberry32(0x1234);
    const seeds = [
      REGTEST_BOLT11,
      REGTEST_SPARK_ADDRESS,
      `bitcoin:${REGTEST_P2TR}?amount=0.001&label=x`,
      encodeLnurl("https://service.io/api?tag=payRequest"),
      "satoshi@wallet.example",
      REGTEST_P2TR,
    ];
    for (const seed of seeds) {
      for (let i = 0; i < 200; i++) {
        const chars = seed.split("");
        const position = Math.floor(rand() * chars.length);
        chars[position] = alphabet[Math.floor(rand() * alphabet.length)]!;
        const result = parsePayment(chars.join(""), REGTEST);
        expect(["request", "lnurl", "unsupported", "invalid", "unrecognized"]).toContain(
          result.kind,
        );
      }
    }
  });
});

const REF: SparkAccountRef = {
  walletId: "w",
  groupIndex: 0,
  network: "regtest",
};

const VERIFY = { kind: "password", password: "pw" } as never;

const PAY_REQUEST: LnurlPayRequest = {
  tag: "payRequest",
  callback: "https://service.io/invoice",
  minSendableMsat: 1000,
  maxSendableMsat: 100_000,
  metadata: "[]",
  description: "desc",
  commentAllowed: 255,
  allowsNostr: false,
};

const WITHDRAW_REQUEST: LnurlWithdrawRequest = {
  tag: "withdrawRequest",
  callback: "https://service.io/withdraw",
  k1: "k1",
  defaultDescription: "withdraw",
  minWithdrawableMsat: 1000,
  maxWithdrawableMsat: 100_000,
};

describe("payments.pay", () => {
  function context() {
    const calls: Array<{ method: string; params: unknown }> = [];
    const spark = {
      send: async (_ref: unknown, params: unknown) => {
        calls.push({ method: "send", params });
        await Promise.resolve();
        return {};
      },
      paySparkInvoice: async (_ref: unknown, params: unknown) => {
        calls.push({ method: "paySparkInvoice", params });
        await Promise.resolve();
        return {};
      },
      payInvoice: async (_ref: unknown, params: unknown) => {
        calls.push({ method: "payInvoice", params });
        await Promise.resolve();
        return {};
      },
      createInvoice: async (_ref: unknown, params: unknown) => {
        calls.push({ method: "createInvoice", params });
        await Promise.resolve();
        return { invoice: "lnbcrt1stub" };
      },
      withdraw: async (_ref: unknown, params: unknown) => {
        calls.push({ method: "withdraw", params });
        await Promise.resolve();
        return {};
      },
    } as unknown as SparkController;
    const fetchCalls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push(url);
      await Promise.resolve();
      if (url.includes("invoice")) {
        // requestInvoice verifies amount, network, and h = sha256(raw metadata).
        const amountMsat = BigInt(new URL(url).searchParams.get("amount") ?? "0");
        const invoice = bolt11({
          network: "regtest",
          amountMsat,
          descriptionHash: sha256(utf8ToBytes(PAY_REQUEST.metadata)),
          timestamp: Math.floor(NOW / 1000),
        });
        return Response.json({ pr: invoice, routes: [] }, { status: 200 });
      }
      return Response.json({ status: "OK" }, { status: 200 });
    }) as typeof globalThis.fetch;
    const ctx: PayContext = { spark, fetch, now: () => NOW };
    return { ctx, calls, fetchCalls };
  }

  it("spark requires an amount", async () => {
    const { ctx } = context();
    await expect(
      pay(ctx, { account: REF, option: { kind: "spark", address: "spark1x" }, verify: VERIFY }),
    ).rejects.toThrow(PaymentError);
  });

  it("spark sends with the supplied amount", async () => {
    const { ctx, calls } = context();
    await pay(ctx, {
      account: REF,
      option: { kind: "spark", address: "spark1x" },
      amountSats: 42,
      verify: VERIFY,
    });
    expect(calls[0]).toStrictEqual({
      method: "send",
      params: { receiver: "spark1x", amountSats: 42, verify: VERIFY },
    });
  });

  it("spark-invoice delegates to paySparkInvoice", async () => {
    const { ctx, calls } = context();
    await pay(ctx, {
      account: REF,
      option: { kind: "spark-invoice", invoice: "spark1inv" },
      amountSats: 7,
      verify: VERIFY,
    });
    expect(calls[0]).toStrictEqual({
      method: "paySparkInvoice",
      params: { invoice: "spark1inv", amountSats: 7, verify: VERIFY },
    });
  });

  it("lightning requires maxFeeSats and pays", async () => {
    const { ctx, calls } = context();
    await expect(
      pay(ctx, {
        account: REF,
        option: {
          kind: "lightning",
          invoice: "lnbcrt1",
          amountSats: 5,
          paymentHash: "h",
          expiresAt: NOW + 120_000,
        },
        verify: VERIFY,
      }),
    ).rejects.toThrow(PaymentError);
    expect(calls).toHaveLength(0);

    await pay(ctx, {
      account: REF,
      option: {
        kind: "lightning",
        invoice: "lnbcrt1",
        amountSats: 5,
        paymentHash: "h",
        expiresAt: NOW + 120_000,
      },
      maxFeeSats: 3,
      verify: VERIFY,
    });
    // the declared option amount is not forwarded — the kernel derives it from the invoice.
    expect(calls[0]).toStrictEqual({
      method: "payInvoice",
      params: { invoice: "lnbcrt1", maxFeeSats: 3, verify: VERIFY },
    });
  });

  it("lnurl-pay validates the amount range before requesting an invoice", async () => {
    const { ctx, calls } = context();
    await expect(
      pay(ctx, {
        account: REF,
        option: { kind: "lnurl-pay", request: PAY_REQUEST },
        amountSats: 200,
        maxFeeSats: 1,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/outside the service's range/);
    expect(calls).toHaveLength(0);
  });

  it("lnurl-pay rejects a comment when the service allows none", async () => {
    const { ctx, calls } = context();
    await expect(
      pay(ctx, {
        account: REF,
        option: {
          kind: "lnurl-pay",
          request: { ...PAY_REQUEST, commentAllowed: 0 },
        },
        amountSats: 10,
        comment: "hi",
        maxFeeSats: 1,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/comments not accepted/);
    expect(calls).toHaveLength(0);
  });

  it("lnurl-pay requests the invoice then pays it", async () => {
    const { ctx, calls, fetchCalls } = context();
    await pay(ctx, {
      account: REF,
      option: { kind: "lnurl-pay", request: PAY_REQUEST },
      amountSats: 10,
      comment: "hi",
      maxFeeSats: 1,
      verify: VERIFY,
    });
    expect(fetchCalls[0]).toContain("https://service.io/invoice");
    expect(calls.at(-1)).toMatchObject({ method: "payInvoice" });
  });

  it("lnurl-withdraw creates an invoice and submits — never approving", async () => {
    const { ctx, calls, fetchCalls } = context();
    await pay(ctx, {
      account: REF,
      option: { kind: "lnurl-withdraw", request: WITHDRAW_REQUEST },
      amountSats: 50,
      verify: VERIFY,
    });
    expect(calls.map((c) => c.method)).toStrictEqual(["createInvoice"]);
    expect(fetchCalls[0]).toContain("https://service.io/withdraw");
    expect(calls[0]?.params).toMatchObject({
      amountSats: 50,
      memo: "withdraw",
    });
  });

  it("lnurl-withdraw rejects an out-of-range amount", async () => {
    const { ctx, calls } = context();
    await expect(
      pay(ctx, {
        account: REF,
        option: { kind: "lnurl-withdraw", request: WITHDRAW_REQUEST },
        amountSats: 500,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/outside the service's range/);
    expect(calls).toHaveLength(0);
  });

  it("bitcoin delegates to withdraw", async () => {
    const { ctx, calls } = context();
    await pay(ctx, {
      account: REF,
      option: { kind: "bitcoin", address: REGTEST_P2TR },
      amountSats: 10,
      maxFeeSats: 1,
      verify: VERIFY,
    });
    expect(calls[0]).toStrictEqual({
      method: "withdraw",
      params: {
        address: REGTEST_P2TR,
        amountSats: 10,
        maxFeeSats: 1,
        speed: "MEDIUM",
        verify: VERIFY,
      },
    });
  });
});

describe("review fixes", () => {
  it("a lightning address starting with 'lno' is not bolt12", () => {
    const result = parsePayment("lnolan@getalby.com", REGTEST);
    expect(result).toStrictEqual({
      kind: "lnurl",
      url: lightningAddressUrl("lnolan@getalby.com"),
      address: "lnolan@getalby.com",
    });
  });

  it("a real bolt12 offer is unsupported", () => {
    expect(parsePayment("lno1qcp4256ypgq2y4k8d8", REGTEST)).toStrictEqual({
      kind: "unsupported",
      format: "bolt12",
    });
  });

  it("lnurlp:// maps .onion hosts to http and others to https", () => {
    expect(parsePayment("lnurlp://service.io/api?tag=payRequest", REGTEST)).toStrictEqual({
      kind: "lnurl",
      url: "https://service.io/api?tag=payRequest",
    });
    expect(
      parsePayment("lnurlp://abcdwxyz1234567890.onion/api?tag=payRequest", REGTEST),
    ).toStrictEqual({
      kind: "lnurl",
      url: "http://abcdwxyz1234567890.onion/api?tag=payRequest",
    });
    expect(
      parsePayment("lnurlw://abcdef0123456789.onion/api?tag=withdrawRequest", REGTEST),
    ).toStrictEqual({
      kind: "lnurl",
      url: "http://abcdef0123456789.onion/api?tag=withdrawRequest",
    });
  });

  it("lightning rejects a caller amount conflicting with a fixed invoice", async () => {
    const spark = {
      payInvoice: () => {
        throw new Error("should not reach payInvoice");
      },
    } as unknown as SparkController;
    const ctx: PayContext = {
      spark,
      fetch: async () => {
        await Promise.resolve();
        return Response.json({});
      },
      now: () => NOW,
    };
    await expect(
      pay(ctx, {
        account: REF,
        option: {
          kind: "lightning",
          invoice: "lnbcrt1",
          amountSats: 5,
          paymentHash: "h",
          expiresAt: NOW + 120_000,
        },
        amountSats: 7,
        maxFeeSats: 3,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/conflicts with the invoice amount/);
  });

  it("lightning re-checks expiry at pay time", async () => {
    const spark = {
      payInvoice: () => {
        throw new Error("should not reach payInvoice");
      },
    } as unknown as SparkController;
    const ctx: PayContext = {
      spark,
      fetch: async () => {
        await Promise.resolve();
        return Response.json({});
      },
      now: () => NOW,
    };
    await expect(
      pay(ctx, {
        account: REF,
        option: {
          kind: "lightning",
          invoice: "lnbcrt1",
          amountSats: 5,
          paymentHash: "h",
          expiresAt: NOW + 30_000,
        },
        maxFeeSats: 3,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("spark-invoice re-checks expiry at pay time", async () => {
    const spark = {
      paySparkInvoice: () => {
        throw new Error("should not reach paySparkInvoice");
      },
    } as unknown as SparkController;
    const ctx: PayContext = {
      spark,
      fetch: async () => {
        await Promise.resolve();
        return Response.json({});
      },
      now: () => NOW,
    };
    await expect(
      pay(ctx, {
        account: REF,
        option: { kind: "spark-invoice", invoice: "spark1inv", amountSats: 5, expiresAt: NOW - 1 },
        verify: VERIFY,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("spark-invoice rejects a caller amount conflicting with a fixed invoice", async () => {
    const spark = {
      paySparkInvoice: () => {
        throw new Error("should not reach paySparkInvoice");
      },
    } as unknown as SparkController;
    const ctx: PayContext = {
      spark,
      fetch: async () => {
        await Promise.resolve();
        return Response.json({});
      },
      now: () => NOW,
    };
    await expect(
      pay(ctx, {
        account: REF,
        option: {
          kind: "spark-invoice",
          invoice: "spark1inv",
          amountSats: 5,
          expiresAt: NOW + 60_000,
        },
        amountSats: 9,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/conflicts with the invoice amount/);
  });

  it("bitcoin requires an explicit amountSats — no implicit sweep", async () => {
    let called = false;
    const spark = {
      withdraw: async () => {
        called = true;
        await Promise.resolve();
        return {};
      },
    } as unknown as SparkController;
    const ctx: PayContext = {
      spark,
      fetch: async () => {
        await Promise.resolve();
        return Response.json({});
      },
      now: () => NOW,
    };
    await expect(
      pay(ctx, {
        account: REF,
        option: { kind: "bitcoin", address: REGTEST_P2TR },
        verify: VERIFY,
      }),
    ).rejects.toThrow(/amountSats is required/);
    expect(called).toBe(false);
  });
});
