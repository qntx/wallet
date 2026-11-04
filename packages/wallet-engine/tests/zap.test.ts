import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";

import type { Event, NostrSigner } from "@qntx/nostr";
import { Keys, KeysSigner, verifyEvent } from "@qntx/nostr";
import { encodeLnurl } from "@qntx/spark/lnurl";

import { prepareZap, prepareZapAction } from "../src/payments/zap.ts";
import type { PreparedZap, PrepareZapParams } from "../src/payments/zap.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { encodeTestBolt11 } from "./support/bolt11.ts";

const PAY_BODY = {
  tag: "payRequest",
  callback: "https://svc.test/cb",
  minSendable: 1000,
  maxSendable: 1_000_000_000,
  metadata: '[["text/plain","svc"]]',
  allowsNostr: true,
  nostrPubkey: "aa".repeat(32),
  commentAllowed: 100,
};

const SECRET = hexToBytes("01".repeat(32));

/** A real KeysSigner wrapped so tests can count signEvent calls. */
function recordingSigner(): { signer: NostrSigner; signed: Event[] } {
  const inner = new KeysSigner(Keys.fromSecretKey(SECRET));
  const signed: Event[] = [];
  return {
    signed,
    signer: {
      getPublicKey: async () => inner.getPublicKey(),
      signEvent: async (e) => {
        const out = await inner.signEvent(e);
        signed.push(out);
        return out;
      },
    },
  };
}

const paid: unknown[] = [];
const fakeSpark = {
  payInvoice: async (_ref: unknown, params: unknown) => {
    paid.push(params);
    return Promise.resolve({ state: "succeeded", amountSats: 700 });
  },
} as unknown as SparkController;

const params = (over: Partial<PrepareZapParams> = {}): PrepareZapParams => ({
  signer: recordingSigner().signer,
  recipient: { pubkey: "ee".repeat(32), lightning: "alice@svc.test" },
  amountSats: 10_000,
  relays: ["wss://r.test"],
  network: "regtest",
  ...over,
});

/**
 * Answers LNURL-pay resolution; the callback captures `nostr` and replies an invoice whose
 * description hash commits to the signed 9734 — like a real service.
 */
const zapFetch = (payBody: object) =>
  (async (input: unknown) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/cb")) {
      return Promise.resolve(Response.json(payBody));
    }
    const nostr = url.searchParams.get("nostr");
    const invoice = encodeTestBolt11({
      network: "regtest",
      amountMsat: 10_000_000n,
      paymentHash: randomBytes(32),
      descriptionHash: sha256(utf8ToBytes(nostr ?? "")),
      secretKey: SECRET,
    });
    return Promise.resolve(Response.json({ pr: invoice }));
  }) as typeof fetch;

const context = (payBody: object = PAY_BODY) => ({
  fetch: zapFetch(payBody),
  now: () => Date.now(),
  verifyEvent,
});

const badInvoiceFetch = (async (input: unknown) => {
  const url = new URL(String(input));
  return Promise.resolve(
    Response.json(url.pathname.endsWith("/cb") ? { pr: "not-an-invoice" } : PAY_BODY),
  );
}) as typeof fetch;

describe("prepareZap", () => {
  test("an external KeysSigner prepares a verifiable 9734 + decoded PreparedZap", async () => {
    const { signer, signed } = recordingSigner();
    const prepared = await prepareZap(params({ signer }), context());
    expect(signed).toHaveLength(1);
    const req = prepared.zapRequest;
    expect(req.kind).toBe(9734);
    expect(verifyEvent(req)).toBe(true);
    const tags = new Map(req.tags.map((t) => [t[0], t.slice(1)]));
    expect(tags.get("p")).toStrictEqual(["ee".repeat(32)]);
    expect(tags.get("amount")).toStrictEqual(["10000000"]);
    expect(tags.get("relays")).toStrictEqual(["wss://r.test"]);
    expect(tags.get("lnurl")?.[0]).toMatch(/^lnurl1/);
    expect(prepared.recipientPubkey).toBe("ee".repeat(32));
    expect(prepared.receiptPubkey).toBe("aa".repeat(32));
    expect(prepared.amountSats).toBe(10_000);
    expect(prepared.lightning).toBe("alice@svc.test");
    expect(prepared.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.expiresAt).toBeGreaterThan(Date.now());
  });

  test("rejects a signer that returns a 9734 differing from the template", async () => {
    const inner = new KeysSigner(Keys.fromSecretKey(SECRET));
    const lying: NostrSigner = {
      getPublicKey: async () => inner.getPublicKey(),
      signEvent: async (e) => inner.signEvent({ ...e, content: `${e.content} (altered)` }),
    };
    await expect(prepareZap(params({ signer: lying }), context())).rejects.toMatchObject({
      category: "rejected",
    });
  });

  test("rejects a service without allowsNostr before signing", async () => {
    const { signer, signed } = recordingSigner();
    await expect(
      prepareZap(params({ signer }), context({ ...PAY_BODY, allowsNostr: false })),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(signed).toHaveLength(0);
  });

  test("rejects a service that is not payRequest", async () => {
    await expect(
      prepareZap(
        params(),
        context({
          tag: "withdrawRequest",
          callback: "https://x.test",
          k1: "ab".repeat(16),
          defaultDescription: "d",
          minWithdrawable: 1,
          maxWithdrawable: 2,
        }),
      ),
    ).rejects.toMatchObject({ category: "rejected" });
  });

  test("rejects amounts outside bounds or not a safe integer before signing", async () => {
    const { signer, signed } = recordingSigner();
    await expect(prepareZap(params({ signer, amountSats: 0 }), context())).rejects.toMatchObject({
      category: "invalid-input",
    });
    await expect(
      prepareZap(params({ signer, amountSats: 2_000_000 }), context()),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(signed).toHaveLength(0);
  });

  test("rejects a comment over commentAllowed, or any comment when allowed is 0", async () => {
    const { signer, signed } = recordingSigner();
    await expect(
      prepareZap(params({ signer, comment: "x".repeat(101) }), context()),
    ).rejects.toMatchObject({ category: "rejected" });
    await expect(
      prepareZap(params({ signer, comment: "hi" }), context({ ...PAY_BODY, commentAllowed: 0 })),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(signed).toHaveLength(0);
  });

  test("uppercase LNURL is detected and lowercased on the 9734", async () => {
    const upper = encodeLnurl("https://svc.test/lnurl").toUpperCase();
    const { signer } = recordingSigner();
    const prepared = await prepareZap(
      params({ signer, recipient: { pubkey: "ee".repeat(32), lightning: upper } }),
      context(),
    );
    const tags = new Map(prepared.zapRequest.tags.map((t) => [t[0], t.slice(1)]));
    expect(tags.get("lnurl")?.[0]).toBe(upper.toLowerCase());
    expect(prepared.lightning).toBe(upper);
  });

  test("a bad invoice from the service fails before payment, signed 9734 unchanged", async () => {
    const s2 = recordingSigner();
    await expect(
      prepareZap(params({ signer: s2.signer }), {
        fetch: badInvoiceFetch,
        now: () => Date.now(),
        verifyEvent,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(s2.signed).toHaveLength(1);
  });
});

const ZAP_INVOICE = encodeTestBolt11({
  network: "regtest",
  amountMsat: 700_000n,
  paymentHash: new Uint8Array(32).fill(4),
  secretKey: SECRET,
});

describe("prepareZapAction", () => {
  const prepared = (over: Partial<PreparedZap> = {}): PreparedZap => ({
    zapRequest: {
      id: "cc".repeat(32),
      sig: "dd".repeat(64),
      pubkey: "bb".repeat(32),
      kind: 9734,
      created_at: 1,
      tags: [],
      content: "",
    },
    invoice: ZAP_INVOICE,
    paymentHash: "ab".repeat(32),
    expiresAt: Date.now() + 600_000,
    amountSats: 700,
    receiptPubkey: "aa".repeat(32),
    recipientPubkey: "ee".repeat(32),
    lightning: "alice@svc.test",
    ...over,
  });

  const account = { walletId: "w", groupIndex: 0, network: "regtest" } as const;
  const verify = { kind: "password", password: "p" } as const;

  test("refuses a near-expiry invoice at prepare — nothing is ever paid", () => {
    paid.length = 0;
    expect(() =>
      prepareZapAction(account, prepared({ expiresAt: Date.now() + 30_000 }), {
        maxFeeSats: 50,
        now: () => Date.now(),
      }),
    ).toThrow("zap invoice expired");
    expect(paid).toHaveLength(0);
  });

  test("goes stale when the invoice nears expiry after prepare", () => {
    const soon = Date.now() + 120_000;
    const action = prepareZapAction(account, prepared({ expiresAt: soon }), {
      maxFeeSats: 50,
      now: () => Date.now(),
    });
    expect(action.staleReason(soon - 61_000)).toBeUndefined();
    expect(action.staleReason(soon - 60_000)).toBe("zap invoice expired");
  });

  test("display mirrors the zap: amount, fee ceiling, payee and comment", () => {
    const action = prepareZapAction(account, prepared({ comment: "gm" }), {
      maxFeeSats: 50,
      now: () => Date.now(),
    });
    expect(action.display).toMatchObject({
      family: "spark",
      kind: "lightning",
      network: "regtest",
      amountSats: 700,
      maxFeeSats: 50,
      description: "gm",
    });
    expect(action.display.receiver).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(action.checks).toStrictEqual([]);
    const tight = prepareZapAction(account, prepared(), { maxFeeSats: 700, now: () => Date.now() });
    expect(tight.checks).toStrictEqual(["fee-exceeds-amount"]);
  });

  test("pays through the controller with the full zap note", async () => {
    paid.length = 0;
    const action = prepareZapAction(
      account,
      prepared({ eventId: "ff".repeat(32), comment: "gm" }),
      { maxFeeSats: 50, now: () => Date.now() },
    );
    const out = await action.execute(fakeSpark, verify);
    expect(out).toMatchObject({ kind: "lightning", payment: { state: "succeeded" } });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      invoice: ZAP_INVOICE,
      maxFeeSats: 50,
      note: {
        kind: "zap",
        recipientPubkey: "ee".repeat(32),
        eventId: "ff".repeat(32),
        comment: "gm",
        lightning: "alice@svc.test",
      },
    });
  });
});
