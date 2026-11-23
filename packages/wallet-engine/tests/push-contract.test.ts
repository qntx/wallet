/**
 * The /v1/push contract: subscription management under a bearer secret, the sealed wire message's
 * shape, and the canonical plaintext the opener accepts — key order, whitespace and unknown keys
 * are all malformed.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  PUSH_ADDRESSES_MAX,
  PUSH_BLOB_MAX,
  PUSH_EVENT_KINDS,
  PUSH_NETWORKS_MAX,
  PUSH_PLAINTEXT_MAX,
  parsePushMessage,
  parsePushPlaintext,
  pushCapabilities,
  pushPath,
  pushSecret,
  pushSubscribe,
  pushSubscriptionRequest,
  pushSubscriptionResponse,
  pushTransactionRequest,
  pushUnsubscribe,
  pushWatch,
  serializePushPlaintext,
} from "../src/gateway/contract/index.ts";
import type { PushPlaintext, PushTransfer } from "../src/gateway/contract/index.ts";

const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

const KEY = "A".repeat(43);
const HASH = `0x${"ab".repeat(32)}`;
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";

const SUBSCRIPTION = {
  platform: "apns",
  token: "d".repeat(64),
  key: KEY,
  networks: ["eip155:1"],
  addresses: [ADDRESS],
};

const CANONICAL = serializePushPlaintext({
  v: 1,
  k: "received",
  n: "eip155:1",
  h: HASH,
  a: ADDRESS,
  t: 1767225600000,
  x: { q: "1500000", d: 6, s: "USDC", c: `0x${"c5".repeat(20)}` },
});

const reserialize = (text: string): string | undefined => {
  const parsed = parsePushPlaintext(text);
  return parsed === undefined ? undefined : serializePushPlaintext(parsed);
};

/** Whatever the parser accepts serializes back to the exact input — rejected, or canonical. */
const reserializeOk = (text: string): boolean => {
  const again = reserialize(text);
  return again === undefined || again === text;
};

const arbTransfer: fc.Arbitrary<PushTransfer> = fc
  .record({
    q: fc.stringMatching(/^(0|[1-9][0-9]{0,10})$/),
    d: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
    s: fc.option(fc.stringMatching(/^[!-~](?:[ -~]{0,6}[!-~])?$/), { nil: undefined }),
    c: fc.option(fc.stringMatching(/^[0-9A-Za-z]{1,32}$/), { nil: undefined }),
  })
  .map(({ d, s, c, ...rest }) => ({
    ...rest,
    ...(d === undefined ? {} : { d }),
    ...(s === undefined ? {} : { s }),
    ...(c === undefined ? {} : { c }),
  }));

const arbPlaintext: fc.Arbitrary<PushPlaintext> = fc
  .record({
    v: fc.constant(1),
    k: fc.constantFrom(...PUSH_EVENT_KINDS),
    n: fc.constantFrom("eip155:1", "bip122:00000008819873e925422c1ff0f99f7c"),
    h: fc.stringMatching(/^[0-9A-Za-z]{1,64}$/),
    a: fc.stringMatching(/^[0-9A-Za-z]{1,64}$/),
    t: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    x: fc.option(arbTransfer, { nil: undefined }),
  })
  .map(({ x, ...rest }) => (x === undefined ? rest : { ...rest, x }));

describe("push endpoints", () => {
  it("declare their verbs and paths", () => {
    expect(pushCapabilities).toMatchObject({ method: "GET", path: "/v1/push" });
    expect(pushSubscribe).toMatchObject({
      method: "PUT",
      path: "/v1/push/:family/subscription",
    });
    expect(pushUnsubscribe).toMatchObject({
      method: "DELETE",
      path: "/v1/push/:family/subscription",
    });
    expect(pushWatch).toMatchObject({ method: "POST", path: "/v1/push/:family/transactions" });
    expect(pushPath(pushSubscribe.path, "bitcoin")).toBe("/v1/push/bitcoin/subscription");
    expect(pushPath(pushWatch.path, "evm")).toBe("/v1/push/evm/transactions");
  });
});

describe("pushCapabilities", () => {
  it("accepts any subset of platforms and families", () => {
    for (const body of [
      { platforms: [], families: [] },
      { platforms: ["apns"], families: ["evm", "bitcoin"] },
      { platforms: ["apns", "fcm"], families: ["evm", "solana", "bitcoin", "tron"] },
    ]) {
      expect(pushCapabilities.response.safeParse(body).success).toBe(true);
    }
  });

  it.each([
    [{}, "missing fields"],
    [{ platforms: ["wns"], families: [] }, "unknown platform"],
    [{ platforms: ["apns", "apns", "apns"], families: [] }, "over the platform bound"],
    [{ platforms: [], families: ["spark"] }, "unknown family"],
    [{ platforms: [], families: [], extra: 1 }, "unknown key"],
  ])("rejects %j (%s)", (body, _why) => {
    expect(pushCapabilities.response.safeParse(body).success).toBe(false);
  });
});

describe("pushSecret", () => {
  it("is 43 base64url characters encoding exactly 32 bytes", () => {
    expect(pushSecret.safeParse(KEY).success).toBe(true);
    expect(pushSecret.safeParse(`${"Ab9_-".repeat(8)}Ab8`).success).toBe(true);
    // The last character carries four bits; a value with nonzero low bits decodes past 32 bytes.
    expect(pushSecret.safeParse(`${"A".repeat(42)}B`).success).toBe(false);
    expect(pushSecret.safeParse(`${"A".repeat(42)}=`).success).toBe(false);
    expect(pushSecret.safeParse("A".repeat(44)).success).toBe(false);
    expect(pushSecret.safeParse("A".repeat(42)).success).toBe(false);
    expect(pushSecret.safeParse(`${"A".repeat(42)}+`).success).toBe(false);
  });
});

describe("pushSubscriptionRequest", () => {
  it("accepts the documented shape on either platform", () => {
    expect(pushSubscriptionRequest.safeParse(SUBSCRIPTION).success).toBe(true);
    expect(
      pushSubscriptionRequest.safeParse({
        ...SUBSCRIPTION,
        platform: "fcm",
        addresses: Array.from({ length: PUSH_ADDRESSES_MAX }, () => ADDRESS),
        networks: Array.from({ length: PUSH_NETWORKS_MAX }, () => "eip155:1"),
      }).success,
    ).toBe(true);
  });

  it.each([
    [{}, "empty"],
    [{ ...SUBSCRIPTION, platform: "wns" }, "unknown platform"],
    [{ ...SUBSCRIPTION, token: "has space" }, "space in token"],
    [{ ...SUBSCRIPTION, token: "" }, "empty token"],
    [{ ...SUBSCRIPTION, token: "t".repeat(4097) }, "oversized token"],
    [{ ...SUBSCRIPTION, token: "tokén" }, "non-ASCII token"],
    [{ ...SUBSCRIPTION, key: `${"A".repeat(42)}B` }, "key with a bad final character"],
    [{ ...SUBSCRIPTION, key: "A".repeat(44) }, "key too long"],
    [{ ...SUBSCRIPTION, key: `${"A".repeat(43)}=` }, "padded key"],
    [{ ...SUBSCRIPTION, networks: [] }, "no networks"],
    [
      {
        ...SUBSCRIPTION,
        networks: Array.from({ length: PUSH_NETWORKS_MAX + 1 }, () => "eip155:1"),
      },
      "too many networks",
    ],
    [{ ...SUBSCRIPTION, networks: ["BAD NETWORK"] }, "network id not CAIP-2"],
    [{ ...SUBSCRIPTION, addresses: [] }, "no addresses"],
    [
      {
        ...SUBSCRIPTION,
        addresses: Array.from({ length: PUSH_ADDRESSES_MAX + 1 }, () => ADDRESS),
      },
      "too many addresses",
    ],
    [{ ...SUBSCRIPTION, addresses: ["not an address!"] }, "address not alphanumeric"],
    [{ ...SUBSCRIPTION, z: 1 }, "unknown key"],
  ])("rejects %j (%s)", (body, _why) => {
    expect(pushSubscriptionRequest.safeParse(body).success).toBe(false);
  });
});

describe("pushSubscriptionResponse", () => {
  it("accepts id, watched networks and expiry", () => {
    expect(
      pushSubscriptionResponse.safeParse({
        id: "ab".repeat(16),
        networks: ["eip155:1"],
        expiresAt: 0,
      }).success,
    ).toBe(true);
    expect(
      pushSubscriptionResponse.safeParse({ id: "ab".repeat(16), networks: [], expiresAt: 1 })
        .success,
    ).toBe(true);
  });

  it.each([
    [{ networks: [], expiresAt: 0 }, "missing id"],
    [{ id: "AB".repeat(16), networks: [], expiresAt: 0 }, "uppercase id"],
    [{ id: "ab".repeat(15), networks: [], expiresAt: 0 }, "short id"],
    [{ id: "ab".repeat(16), networks: [], expiresAt: -1 }, "negative expiry"],
    [{ id: "ab".repeat(16), networks: [], expiresAt: 0, extra: 1 }, "unknown key"],
  ])("rejects %j (%s)", (body, _why) => {
    expect(pushSubscriptionResponse.safeParse(body).success).toBe(false);
  });
});

describe("pushTransactionRequest", () => {
  it("registers a network and hash", () => {
    expect(pushTransactionRequest.safeParse({ network: "eip155:1", hash: HASH }).success).toBe(
      true,
    );
    for (const body of [
      { network: "eip155:1" },
      { network: "eip155:1", hash: "" },
      { network: "bad", hash: HASH },
      { network: "eip155:1", hash: HASH, note: "x" },
    ]) {
      expect(pushTransactionRequest.safeParse(body).success).toBe(false);
    }
    expect(pushWatch.response.safeParse({}).success).toBe(true);
    expect(pushWatch.response.safeParse({ status: "ok" }).success).toBe(false);
  });
});

describe("parsePushMessage", () => {
  const msg = { v: "1", e: "ab".repeat(16), c: "A".repeat(60) };

  it("accepts the wire shape and ignores provider keys", () => {
    expect(parsePushMessage(msg)).toStrictEqual(msg);
    expect(
      parsePushMessage({ ...msg, "gcm.message_id": "sdk", aps: { alert: "x" } }),
    ).toStrictEqual(msg);
  });

  it("bounds c at the smallest blob and at PUSH_BLOB_MAX", () => {
    expect(parsePushMessage({ ...msg, c: "A".repeat(39) })).toBeDefined();
    expect(parsePushMessage({ ...msg, c: "A".repeat(38) })).toBeUndefined();
    expect(parsePushMessage({ ...msg, c: "A".repeat(PUSH_BLOB_MAX) })).toBeDefined();
    expect(parsePushMessage({ ...msg, c: "A".repeat(PUSH_BLOB_MAX + 1) })).toBeUndefined();
  });

  it.each([
    ["not an object", "nope"],
    [null, "null"],
    [["v", "e", "c"], "array"],
    [{ ...msg, v: 1 }, "numeric version"],
    [{ ...msg, v: "2" }, "version 2"],
    [{ ...msg, e: "AB".repeat(16) }, "uppercase event id"],
    [{ ...msg, e: "ab".repeat(15) }, "short event id"],
    [{ ...msg, c: `${"A".repeat(59)}=` }, "padded blob"],
    [{ ...msg, c: `${"A".repeat(59)}+` }, "non-base64url blob"],
  ])("rejects %j (%s)", (value, _why) => {
    expect(parsePushMessage(value)).toBeUndefined();
  });

  it("never throws on arbitrary values", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => parsePushMessage(value)).not.toThrow();
      }),
      { numRuns },
    );
  });
});

describe("serializePushPlaintext", () => {
  it("emits the canonical key order regardless of construction order", () => {
    const doc: PushPlaintext = {
      t: 1767225600000,
      a: ADDRESS,
      h: HASH,
      n: "eip155:1",
      k: "sent",
      v: 1,
      x: { c: `0x${"c5".repeat(20)}`, s: "USDC", q: "1500000", d: 6 },
    };
    expect(serializePushPlaintext(doc)).toBe(CANONICAL.replace('"received"', '"sent"'));
  });

  it("omits absent optionals inside x", () => {
    const doc: PushPlaintext = {
      v: 1,
      k: "sent",
      n: "eip155:1",
      h: HASH,
      a: ADDRESS,
      t: 1,
      x: { q: "42" },
    };
    expect(serializePushPlaintext(doc)).toBe(
      `{"v":1,"k":"sent","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"42"}}`,
    );
  });
});

describe("parsePushPlaintext", () => {
  it("round-trips every accepted document", () => {
    for (const text of [
      CANONICAL,
      serializePushPlaintext({ v: 1, k: "sent", n: "eip155:1", h: HASH, a: ADDRESS, t: 0 }),
      serializePushPlaintext({
        v: 1,
        k: "reverted",
        n: "bip122:00000008819873e925422c1ff0f99f7c",
        h: "9f".repeat(32),
        a: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        t: Number.MAX_SAFE_INTEGER,
        x: { q: "0", s: "A B" },
      }),
    ]) {
      expect(reserialize(text)).toBe(text);
    }
  });

  it.each([
    ["empty", ""],
    ["not JSON", "not json"],
    ["array", "[]"],
    ["no fields", "{}"],
    ["version 2", `{"v":2,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1}`],
    ["v as string", `{"v":"1","k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1}`],
    ["unknown kind", `{"v":1,"k":"pending","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1}`],
    ["bad network", `{"v":1,"k":"received","n":"EIP155:1","h":"${HASH}","a":"${ADDRESS}","t":1}`],
    ["bad hash", `{"v":1,"k":"received","n":"eip155:1","h":"0x-z","a":"${ADDRESS}","t":1}`],
    ["bad address", `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"!addr","t":1}`],
    ["negative t", `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":-1}`],
    [
      "non-integer t",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1.5}`,
    ],
    ["t as string", `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":"1"}`],
    [
      "x without q",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{}}`,
    ],
    [
      "leading-zero q",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"01"}}`,
    ],
    [
      "negative q",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"-1"}}`,
    ],
    [
      "d out of range",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","d":300}}`,
    ],
    [
      "non-integer d",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","d":1.5}}`,
    ],
    [
      "s leading space",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","s":" lead"}}`,
    ],
    [
      "s trailing space",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","s":"trail "}}`,
    ],
    [
      "s too long",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","s":"${"S".repeat(17)}"}}`,
    ],
    [
      "bad contract",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","c":"!"}}`,
    ],
    [
      "unknown key in x",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":{"q":"1","z":0}}`,
    ],
    [
      "x as array",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"x":[]}`,
    ],
    [
      "trailing space",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1} `,
    ],
    [
      "unknown key",
      `{"v":1,"k":"received","n":"eip155:1","h":"${HASH}","a":"${ADDRESS}","t":1,"w":0}`,
    ],
    ["over the size cap", "A".repeat(PUSH_PLAINTEXT_MAX + 1)],
    [
      "non-ASCII",
      '{"v":1,"k":"received","n":"eip155:1","h":"0xab","a":"0xcd","t":1,"x":{"q":"1","s":"USDCé"}}',
    ],
  ])("rejects %s", (_why, text) => {
    expect(parsePushPlaintext(text)).toBeUndefined();
  });

  it("rejects every truncation of a canonical document", () => {
    for (let i = 0; i < CANONICAL.length; i++) {
      expect(parsePushPlaintext(CANONICAL.slice(0, i))).toBeUndefined();
    }
  });

  it.each([
    [`${CANONICAL.slice(0, -1)},"v":1}`, "duplicate key"],
    [CANONICAL.replace('"v":1,"k":"received"', '"k":"received","v":1'), "reordered keys"],
    [`${CANONICAL.slice(0, -1)},"z":0}`, "extra field"],
    [CANONICAL.replace('"x":{"q":"1500000"', '"x":{"q":"1500000","z":0'), "extra field inside x"],
    [CANONICAL.replace('{"v":1', '{ "v":1'), "interior whitespace"],
  ])("rejects the mutated document (%s)", (text) => {
    expect(parsePushPlaintext(text)).toBeUndefined();
  });

  it("never throws on arbitrary strings, and what it accepts is canonical", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(() => parsePushPlaintext(text)).not.toThrow();
        expect(reserializeOk(text)).toBe(true);
      }),
      { numRuns },
    );
  });

  it("serializes generated documents to themselves", () => {
    fc.assert(
      fc.property(arbPlaintext, (p) => {
        expect(parsePushPlaintext(serializePushPlaintext(p))).toStrictEqual(p);
      }),
      { numRuns },
    );
  });
});
