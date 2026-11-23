// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture payloads is inherent to asserting on them
/**
 * The Alchemy watcher: `verifyAlchemySignature` against the raw body, `alchemyObservations` on the
 * documented Address Activity payload (tests/fixtures/alchemy-webhooks/address-activity.json, from
 * https://www.alchemy.com/docs/data/webhooks/webhook-types/address-activity-webhook), the env
 * config contract, `alchemySync`'s request shape, and `/hooks/alchemy` end to end through
 * `createGateway`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";

import {
  OBSERVATIONS_MAX,
  alchemyConfig,
  alchemyObservations,
  alchemyPayloadSchema,
  alchemySync,
  verifyAlchemySignature,
} from "../src/push/watch-alchemy.ts";
import type { AlchemyPayload } from "../src/push/watch-alchemy.ts";
import fixture from "./fixtures/alchemy-webhooks/address-activity.json" with { type: "json" };
import { fakeFetch, gateway } from "./helpers.ts";

const SIGNING_KEY = "test-signing-key";
const WEBHOOK_ID = "wh_k63lg72rxda78gce";
const EVM = "eip155:1";

const sign = async (body: string, key = SIGNING_KEY): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const payload = z.parse(alchemyPayloadSchema, fixture);
const body = JSON.stringify(fixture);

describe("verifyAlchemySignature", () => {
  it("accepts a correct signature and rejects every deviation", async () => {
    const good = await sign(body);
    await expect(verifyAlchemySignature(body, good, SIGNING_KEY)).resolves.toBe(true);
    await expect(verifyAlchemySignature(body, good, "other-key")).resolves.toBe(false);
    await expect(verifyAlchemySignature(`${body} `, good, SIGNING_KEY)).resolves.toBe(false);
    await expect(verifyAlchemySignature(body, undefined, SIGNING_KEY)).resolves.toBe(false);
    await expect(verifyAlchemySignature(body, "not-hex", SIGNING_KEY)).resolves.toBe(false);
    await expect(verifyAlchemySignature(body, "abc", SIGNING_KEY)).resolves.toBe(false); // odd length
    await expect(verifyAlchemySignature(body, "00".repeat(16), SIGNING_KEY)).resolves.toBe(false);
  });
});

describe("alchemyObservations", () => {
  it("maps the documented payload to in/out observations with token display", () => {
    const { items, dropped } = alchemyObservations(payload, EVM);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(4);
    const [first] = items;
    expect(first).toStrictEqual({
      network: EVM,
      hash: "0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72",
      address: "0xbe3f4b43db5eb49d1f48f53443b9abce45da3b79",
      direction: "in",
      tid: "log:0x6e",
      removed: false,
      transfer: {
        q: "293092129",
        d: 6,
        s: "USDC",
        c: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      },
    });
    expect(items[1]?.direction).toBe("out");
    expect(items[1]?.address).toBe("0x503828976d22510aad0201ac7ec88293211d23da");
    expect(items[1]?.tid).toBe("log:0x6e");
    expect(items[2]?.tid).toBe("log:0x74");
  });

  it("emits both directions for a self-transfer and native display for external", () => {
    const self: AlchemyPayload = {
      webhookId: "w",
      id: "e",
      createdAt: "t",
      type: "ADDRESS_ACTIVITY",
      event: {
        network: "ETH_MAINNET",
        activity: [
          {
            hash: `0x${"a".repeat(64)}`,
            fromAddress: `0x${"1".repeat(40)}`,
            toAddress: `0x${"1".repeat(40)}`,
            asset: "ETH",
            category: "external",
            rawContract: { rawValue: "0xde0b6b3a7640000" },
          },
        ],
      },
    };
    const { items } = alchemyObservations(self, EVM);
    expect(items.map((i) => i.direction)).toStrictEqual(["in", "out"]);
    expect(items[0]?.transfer).toStrictEqual({ q: "1000000000000000000", d: 18, s: "ETH" });
  });

  it("keeps no display for erc721, skips malformed activities and marks removed logs", () => {
    const mixed: AlchemyPayload = {
      webhookId: "w",
      id: "e",
      createdAt: "t",
      type: "ADDRESS_ACTIVITY",
      event: {
        network: "ETH_MAINNET",
        activity: [
          {
            hash: `0x${"b".repeat(64)}`,
            fromAddress: `0x${"1".repeat(40)}`,
            toAddress: `0x${"2".repeat(40)}`,
            category: "erc721",
            erc721TokenId: "0x9",
            log: { logIndex: "0x3", removed: true },
          },
          { hash: "not-a-hash", toAddress: `0x${"2".repeat(40)}` },
          { hash: `0x${"c".repeat(64)}`, toAddress: "garbage" },
          {
            hash: `0x${"d".repeat(64)}`,
            toAddress: `0x${"2".repeat(40)}`,
            category: "internal",
            typeTraceAddress: "call_0_1",
            rawContract: { rawValue: "0x1" },
          },
        ],
      },
    };
    const { items } = alchemyObservations(mixed, EVM);
    expect(items).toHaveLength(3);
    expect(items[0]?.removed).toBe(true);
    expect(items[0]?.transfer).toBeUndefined(); // erc721 carries no amount display
    expect(items[2]?.tid).toBe("trace:call_0_1");
    expect(items[2]?.transfer).toStrictEqual({ q: "1", d: 18 });
  });

  it("drops observations past the cap and reports the count", () => {
    const activity = Array.from({ length: OBSERVATIONS_MAX + 10 }, (_, index) => ({
      hash: `0x${String(index).padStart(64, "0")}`,
      toAddress: `0x${"1".repeat(40)}`,
      category: "external",
      rawContract: { rawValue: "0x1" },
    }));
    const many: AlchemyPayload = {
      webhookId: "w",
      id: "e",
      createdAt: "t",
      type: "ADDRESS_ACTIVITY",
      event: { network: "ETH_MAINNET", activity },
    };
    const { items, dropped } = alchemyObservations(many, EVM);
    expect(items).toHaveLength(OBSERVATIONS_MAX);
    expect(dropped).toBe(10);
  });
});

describe("alchemyConfig", () => {
  const env = (token?: string, webhooks?: string) => ({
    ALCHEMY_NOTIFY_TOKEN: token,
    ALCHEMY_WEBHOOKS: webhooks,
  });
  const served = new Set([EVM]);

  it("is undefined only when both vars are absent, throws otherwise malformed", () => {
    expect(alchemyConfig(env(), served)).toBeUndefined();
    expect(() => alchemyConfig(env("t"), served)).toThrow(/all-or-nothing/);
    expect(() => alchemyConfig(env(undefined, "{}"), served)).toThrow(/all-or-nothing/);
    expect(() => alchemyConfig(env("t", "not json"), served)).toThrow(/not JSON/);
    expect(() => alchemyConfig(env("t", `{"${EVM}": {}}`), served)).toThrow(/malformed/);
    expect(() =>
      alchemyConfig(env("t", `{"eip155:999": {"id":"w","signingKey":"k"}}`), served),
    ).toThrow(/not a served EVM network/);
  });

  it("indexes hooks by webhook id and webhooks by caip2", () => {
    const config = alchemyConfig(
      env("tok", `{"${EVM}": {"id":"${WEBHOOK_ID}","signingKey":"${SIGNING_KEY}"}}`),
      served,
    );
    expect(config?.hooks.get(WEBHOOK_ID)).toStrictEqual({
      network: EVM,
      id: WEBHOOK_ID,
      signingKey: SIGNING_KEY,
    });
    expect(config?.webhooks.get(EVM)).toStrictEqual({ id: WEBHOOK_ID });
    expect(config?.networks).toStrictEqual(new Set([EVM]));
  });
});

describe("alchemySync", () => {
  const config = alchemyConfig(
    {
      ALCHEMY_NOTIFY_TOKEN: "tok",
      ALCHEMY_WEBHOOKS: `{"${EVM}": {"id":"${WEBHOOK_ID}","signingKey":"${SIGNING_KEY}"}}`,
    },
    new Set([EVM]),
  );

  it("PATCHes the dashboard endpoint with the token header and both lists", async () => {
    const { fetch, callsTo } = fakeFetch({
      "https://dashboard.alchemy.com/": () => new Response("{}"),
    });
    if (config === undefined) {
      throw new Error("config");
    }
    await alchemySync(config, fetch)(EVM, [`0x${"1".repeat(40)}`], [`0x${"2".repeat(40)}`]);
    const [call] = callsTo("https://dashboard.alchemy.com/api/update-webhook-addresses");
    expect(call?.method).toBe("PATCH");
    const headers = new Headers(call?.headers);
    expect(headers.get("x-alchemy-token")).toBe("tok");
    expect(JSON.parse(call?.body ?? "{}")).toStrictEqual({
      webhook_id: WEBHOOK_ID,
      addresses_to_add: [`0x${"1".repeat(40)}`],
      addresses_to_remove: [`0x${"2".repeat(40)}`],
    });
  });

  it("throws on a non-2xx so the core defers the batch", async () => {
    const { fetch } = fakeFetch({
      "https://dashboard.alchemy.com/": () => new Response(null, { status: 500 }),
    });
    if (config === undefined) {
      throw new Error("config");
    }
    await expect(alchemySync(config, fetch)(EVM, [], [])).rejects.toThrow(/status-500/);
  });
});

describe("POST /hooks/alchemy", () => {
  const hooks = new Map([[WEBHOOK_ID, { network: EVM, id: WEBHOOK_ID, signingKey: SIGNING_KEY }]]);
  const ingestCalls: unknown[][] = [];
  const app = gateway({
    fetch: async () => Promise.resolve(new Response(null)),
    push: {
      platforms: ["apns"],
      families: ["evm"],
      backend: () => ({
        subscribe: async () => {
          await Promise.resolve();
          return { ok: false, status: 404, code: "unsupported" as const };
        },
        unsubscribe: async () => {
          await Promise.resolve();
          return { ok: true, value: undefined };
        },
        watch: async () => {
          await Promise.resolve();
          return { ok: true, value: undefined };
        },
        ingest: async (items) => {
          await Promise.resolve();
          ingestCalls.push([...items]);
          return { ok: true, value: undefined };
        },
      }),
      alchemy: hooks,
      limiter: { limit: async () => Promise.resolve({ success: true }) },
    },
  });
  const post = async (raw: string, signature?: string) =>
    app.request("/hooks/alchemy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-alchemy-signature": signature }),
      },
      body: raw,
    });

  it("verifies the signature, folds the payload and ingests it", async () => {
    const res = await post(body, await sign(body));
    expect(res.status).toBe(200);
    expect(ingestCalls.at(-1)).toHaveLength(4);
  });

  it("rejects a tampered body, a wrong key and a missing header", async () => {
    const count = ingestCalls.length;
    const tampered = await post(`${body} `, await sign(body));
    const wrongKey = await post(body, await sign(body, "wrong"));
    const missing = await post(body);
    expect(tampered.status).toBe(400);
    expect(wrongKey.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(ingestCalls).toHaveLength(count);
  });

  it("rejects an unknown webhook, bad JSON and a wrong type", async () => {
    const badJson = await post("not json", "00".repeat(32));
    const unknownHook = JSON.stringify({ ...fixture, webhookId: "wh_unknown" });
    const unknownRes = await post(unknownHook, await sign(unknownHook));
    const wrongType = JSON.stringify({ ...fixture, type: "GRAPHQL" });
    const wrongTypeRes = await post(wrongType, await sign(wrongType));
    expect(badJson.status).toBe(400);
    expect(unknownRes.status).toBe(400);
    expect(wrongTypeRes.status).toBe(400);
  });
});
