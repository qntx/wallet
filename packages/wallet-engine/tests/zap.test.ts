import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";

import { zap } from "../src/payments/zap.ts";
import type { ZapOptions, ZapParams } from "../src/payments/zap.ts";
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

const approved: unknown[] = [];
const signed: unknown[] = [];

const fakeSpark = {
  payInvoice: async (_ref: unknown, params: unknown) => {
    approved.push(params);
    return Promise.resolve({ state: "succeeded" });
  },
} as unknown as SparkController;

const fakeNostr = () => ({
  getPublicKey: async () => Promise.resolve("bb".repeat(32)),
  signEvent: async (e: unknown) => {
    signed.push(e);
    return Promise.resolve({ ...(e as object), id: "cc".repeat(32), sig: "dd".repeat(64) });
  },
});

const params = (over = {}): ZapParams => ({
  account: { walletId: "w", groupIndex: 0, network: "regtest" },
  nostrKey: { kind: "derived", walletId: "w", groupIndex: 0 },
  recipient: { pubkey: "ee".repeat(32), lightning: "alice@svc.test" },
  amountSats: 10_000,
  relays: ["wss://r.test"],
  maxFeeSats: 50,
  verify: { kind: "password", password: "p" },
  ...over,
});

const DUMMY_INVOICE = { pr: "lntb1dummy" };

const fetchWith = (payBody: object, invoiceBody: object = DUMMY_INVOICE) =>
  (async (input: unknown) => {
    const u = String(input);
    return Promise.resolve(Response.json(u.includes("/cb") ? invoiceBody : payBody));
  }) as typeof fetch;

const options = (payBody: object, invoiceBody?: object): ZapOptions => ({
  fetch: fetchWith(payBody, invoiceBody),
  nostr: () => fakeNostr() as never,
  spark: fakeSpark,
});

describe("zap", () => {
  test("rejects a service that does not allow nostr, before any approval", async () => {
    await expect(zap(params(), options({ ...PAY_BODY, allowsNostr: false }))).rejects.toMatchObject(
      { category: "rejected" },
    );
    expect(approved).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  test("rejects an amount outside min/max sendable, before any approval", async () => {
    await expect(zap(params({ amountSats: 0 }), options(PAY_BODY))).rejects.toMatchObject({
      category: "rejected",
    });
    expect(approved).toHaveLength(0);
  });

  test("rejects an unpayable/non-payRequest LNURL, before any approval", async () => {
    await expect(
      zap(
        params(),
        options({
          tag: "withdrawRequest",
          callback: "https://x.test",
          k1: "ab".repeat(16),
          defaultDescription: "d",
          minWithdrawable: 1,
          maxWithdrawable: 2,
        }),
      ),
    ).rejects.toThrow("LNURL-pay");
    expect(approved).toHaveLength(0);
  });

  test("fails before approve when the invoice fails service-side validation", async () => {
    // requestInvoice decodes/checks the pr; a malformed invoice must not reach approve.
    await expect(zap(params(), options(PAY_BODY, { pr: "not-an-invoice" }))).rejects.toThrow("zap");
    expect(approved).toHaveLength(0);
  });

  test("signs the 9734 template with exact tags and approves the invoice", async () => {
    signed.length = 0;
    approved.length = 0;
    // The fake service replies a parseable invoice — lntb decodes with h-mismatch
    // or decodes cleanly; either way the approve intent is what the service returned.
    await expect(zap(params(), options(PAY_BODY))).rejects.toThrow("zap failed");
    const tmpl = signed[0] as { kind: number; tags: string[][] };
    expect(tmpl.kind).toBe(9734);
    const tags = new Map(tmpl.tags.map((t) => [t[0], t.slice(1)]));
    expect(tags.get("p")).toStrictEqual(["ee".repeat(32)]);
    expect(tags.get("amount")).toStrictEqual(["10000000"]);
    expect(tags.get("relays")).toStrictEqual(["wss://r.test"]);
    expect(tags.get("lnurl")?.[0]).toMatch(/^lnurl1/);
    // The fake pr fails BOLT-11 validation inside requestInvoice — approve is never reached.
    expect(approved).toHaveLength(0);
  });

  test("event zap: 9734 carries e, k and the author's p tag", async () => {
    signed.length = 0;
    const zapped = {
      id: "ff".repeat(32),
      pubkey: "11".repeat(32),
      kind: 1,
      created_at: 1,
      tags: [],
      content: "hi",
      sig: "22".repeat(64),
    };
    await expect(
      zap(
        params({
          recipient: {
            lightning: "alice@svc.test",
            event: zapped,
          },
        }),
        options(PAY_BODY),
      ),
    ).rejects.toThrow("zap failed");
    const tmpl = signed[0] as { kind: number; tags: string[][] };
    const tags = new Map(tmpl.tags.map((t) => [t[0], t.slice(1)]));
    // `p` is the zapped event's author, not the profile pubkey.
    expect(tags.get("p")).toStrictEqual(["11".repeat(32)]);
    expect(tags.get("e")).toStrictEqual(["ff".repeat(32)]);
    expect(tags.get("k")).toStrictEqual(["1"]);
    expect(tags.get("amount")).toStrictEqual(["10000000"]);
  });

  test("payInvoice carries the zap note — pubkey and event recipients", async () => {
    // requestInvoice demands the invoice's description hash equal sha256(zapRequest): capture
    // the signed 9734 the fake service sees, then feed an invoice carrying its hash.
    const invoiceFor = async (params_: ZapParams): Promise<string> => {
      const captured: string[] = [];
      const capFetch = (async (input: unknown) => {
        const url = new URL(String(input));
        const nostr = url.searchParams.get("nostr");
        // oxlint-disable-next-line vitest/no-conditional-in-test -- capture, not a branch
        if (nostr !== null) {
          captured.push(nostr);
        }
        return Promise.resolve(
          // oxlint-disable-next-line vitest/no-conditional-in-test -- route the fake response
          Response.json(url.pathname.endsWith("/cb") ? {} : PAY_BODY),
        );
      }) as typeof fetch;
      await expect(
        zap(params_, { fetch: capFetch, nostr: () => fakeNostr() as never, spark: fakeSpark }),
      ).rejects.toThrow("zap");
      return encodeTestBolt11({
        network: "regtest",
        amountMsat: 10_000_000n,
        paymentHash: new Uint8Array(32).fill(1),
        paymentSecret: new Uint8Array(32).fill(2),
        secretKey: new Uint8Array(32).fill(3),
        // oxlint-disable-next-line vitest/no-conditional-in-test -- the capture must exist
        descriptionHash: sha256(utf8ToBytes(captured[0] ?? "")),
      });
    };

    approved.length = 0;
    const pubkeyPr = await invoiceFor(params({ comment: "hi" }));
    await zap(params({ comment: "hi" }), options(PAY_BODY, { pr: pubkeyPr }));
    expect(approved[0]).toMatchObject({
      invoice: pubkeyPr,
      note: {
        kind: "zap",
        recipientPubkey: "ee".repeat(32),
        comment: "hi",
        lightning: "alice@svc.test",
      },
    });
    expect((approved[0] as { note?: { eventId?: string } }).note).not.toMatchObject({
      eventId: expect.anything(),
    });

    approved.length = 0;
    const zapped = {
      id: "ff".repeat(32),
      pubkey: "11".repeat(32),
      kind: 1,
      created_at: 1,
      tags: [],
      content: "hi",
      sig: "22".repeat(64),
    };
    const eventParams = params({ recipient: { lightning: "alice@svc.test", event: zapped } });
    const eventPr = await invoiceFor(eventParams);
    await zap(eventParams, options(PAY_BODY, { pr: eventPr }));
    // The note's recipient is the zapped event's author and id, not a profile pubkey.
    expect(approved[0]).toMatchObject({
      note: {
        kind: "zap",
        recipientPubkey: "11".repeat(32),
        eventId: "ff".repeat(32),
        lightning: "alice@svc.test",
      },
    });
    approved.length = 0;
  });

  test("amountSats must be a positive safe integer — before any fetch or approve", async () => {
    let fetches = 0;
    const countFetch = (async () => {
      fetches += 1;
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;
    await expect(
      zap(params({ amountSats: 0 }), {
        fetch: countFetch,
        nostr: () => fakeNostr() as never,
        spark: fakeSpark,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    await expect(
      zap(params({ amountSats: -5 }), {
        fetch: countFetch,
        nostr: () => fakeNostr() as never,
        spark: fakeSpark,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    await expect(
      zap(params({ amountSats: 1.5 }), {
        fetch: countFetch,
        nostr: () => fakeNostr() as never,
        spark: fakeSpark,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    await expect(
      zap(params({ amountSats: Number.MAX_SAFE_INTEGER }), {
        fetch: countFetch,
        nostr: () => fakeNostr() as never,
        spark: fakeSpark,
      }),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(fetches).toBe(0);
    expect(approved).toHaveLength(0);
  });

  test("a wrong-amount invoice fails validation: rejected, zero approvals", async () => {
    // BOLT-11 spec vector for 2500 uBTC — decodes fine, but its amount is not the requested
    // 10_000 sats, so the LNURL layer rejects before the payment path runs.
    const wrongAmount = {
      pr: "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh",
    };
    await expect(zap(params(), options(PAY_BODY, wrongAmount))).rejects.toMatchObject({
      category: "rejected",
    });
    expect(approved).toHaveLength(0);
  });
});
