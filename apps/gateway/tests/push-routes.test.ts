// oxlint-disable vitest/no-conditional-in-test -- narrowing fixture and vector payloads
// is inherent to asserting on them.
/**
 * The push routes through `createGateway`: capability advertisement, family/bearer/schema guards,
 * the push limiter charge, and the derived subscription id matching the vector oracle.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  accepts,
  pushCapabilities,
  pushSubscribe,
  pushWatch,
} from "@qntx/wallet-engine/gateway/contract";

import type { PushBackend, PushResult, PushService } from "../src/push/backend.ts";
import { base64urlBytes } from "../src/push/encoding.ts";
import { subscriptionIdOf } from "../src/push/seal.ts";
import { denyAll, gateway, headers, post } from "./helpers.ts";

const SECRET_B64URL = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const bearer = (secret = SECRET_B64URL): Record<string, string> => ({
  authorization: `Bearer ${secret}`,
});

const SUBSCRIPTION_BODY = {
  platform: "apns",
  token: "abababababababababababababababababababababababababababababababab",
  key: SECRET_B64URL,
  networks: ["eip155:1"],
  addresses: ["0x1111111111111111111111111111111111111111"],
};

const SUBSCRIPTION_RESPONSE = {
  id: "8ee86d90f223f4765aff16c21e04ecaf",
  networks: ["eip155:1"],
  expiresAt: 1_800_000_000_000,
};

type Recorded = {
  subscribe: unknown[];
  unsubscribe: string[];
  watch: unknown[];
};

const backendOf = (
  subscribed?: PushResult<typeof SUBSCRIPTION_RESPONSE>,
): { readonly backend: PushBackend; readonly calls: Recorded } => {
  const answer = subscribed ?? { ok: true, value: SUBSCRIPTION_RESPONSE };
  const calls: Recorded = { subscribe: [], unsubscribe: [], watch: [] };
  return {
    calls,
    backend: {
      subscribe: async (request) => {
        calls.subscribe.push(request);
        await Promise.resolve();
        return answer;
      },
      unsubscribe: async (id) => {
        calls.unsubscribe.push(id);
        await Promise.resolve();
        return { ok: true, value: undefined };
      },
      watch: async (request) => {
        calls.watch.push(request);
        await Promise.resolve();
        return { ok: true, value: undefined };
      },
    },
  };
};

const serviceOf = (backend: PushBackend, overrides: Partial<PushService> = {}): PushService => ({
  platforms: ["apns"],
  families: ["evm"],
  backend: () => backend,
  limiter: { limit: async () => Promise.resolve({ success: true }) },
  ...overrides,
});

const appWith = (push?: PushService) =>
  gateway({
    fetch: async () => Promise.resolve(new Response(null)),
    ...(push === undefined ? {} : { push }),
  });

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: headers({ "content-type": "application/json", ...bearer() }),
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("GET /v1/push", () => {
  it("advertises empty capabilities when push is not configured", async () => {
    const app = appWith();
    const res = await app.fetch(new Request("https://gw.test/v1/push", { headers: headers() }));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(accepts(pushCapabilities.response, body)).toBe(true);
    expect(body).toStrictEqual({ platforms: [], families: [] });
  });

  it("advertises the configured platforms and families", async () => {
    const app = appWith(serviceOf(backendOf().backend));
    const res = await app.fetch(new Request("https://gw.test/v1/push", { headers: headers() }));
    await expect(res.json()).resolves.toStrictEqual({ platforms: ["apns"], families: ["evm"] });
  });
});

describe("PUT /v1/push/:family/subscription", () => {
  it("subscribes, deriving the id from the bearer secret", async () => {
    const { backend, calls } = backendOf();
    const app = appWith(serviceOf(backend));
    const res = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", put(SUBSCRIPTION_BODY)),
    );
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(accepts(pushSubscribe.response, body)).toBe(true);
    const request = calls.subscribe[0] as { id?: string };
    const secret = base64urlBytes(SECRET_B64URL) ?? new Uint8Array();
    expect(request.id).toBe(await subscriptionIdOf(secret));
  });

  it("answers 404 unsupported for unknown and unserved families", async () => {
    const { backend } = backendOf();
    const app = appWith(serviceOf(backend, { families: ["solana"] }));
    const unknown = await app.fetch(
      new Request("https://gw.test/v1/push/doge/subscription", put(SUBSCRIPTION_BODY)),
    );
    expect(unknown.status).toBe(404);
    const unserved = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", put(SUBSCRIPTION_BODY)),
    );
    expect(unserved.status).toBe(404);
    await expect(unserved.json()).resolves.toStrictEqual({ error: "unsupported" });
  });

  it("answers 404 when push is not configured at all", async () => {
    const app = appWith();
    const res = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", put(SUBSCRIPTION_BODY)),
    );
    expect(res.status).toBe(404);
  });

  it("answers 400 invalid-request for a missing or malformed bearer", async () => {
    const { backend } = backendOf();
    const app = appWith(serviceOf(backend));
    for (const authorization of [undefined, "Bearer", "Basic abc", "Bearer !!", "Bearer aGk"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential requests against one app
      const res = await app.fetch(
        new Request("https://gw.test/v1/push/evm/subscription", {
          method: "PUT",
          headers: headers({
            "content-type": "application/json",
            ...(authorization === undefined ? {} : { authorization }),
          }),
          body: JSON.stringify(SUBSCRIPTION_BODY),
        }),
      );
      expect(res.status).toBe(400);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential requests against one app
      await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
    }
  });

  it("answers 400 for a schema-invalid body", async () => {
    const { backend } = backendOf();
    const app = appWith(serviceOf(backend));
    const res = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", put({ platform: "carrier-pigeon" })),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toStrictEqual({ error: "invalid-request" });
  });

  it("charges the push limiter and answers 429 with Retry-After", async () => {
    const { backend } = backendOf();
    const app = appWith(serviceOf(backend, { limiter: denyAll }));
    const res = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", put(SUBSCRIPTION_BODY)),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    await expect(res.json()).resolves.toStrictEqual({ error: "rate-limited" });
  });

  it("forwards a backend failure", async () => {
    const { backend } = backendOf({ ok: false, status: 503, code: "unavailable" });
    const app = appWith(serviceOf(backend));
    const res = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", put(SUBSCRIPTION_BODY)),
    );
    expect(res.status).toBe(503);
  });
});

describe("DELETE /v1/push/:family/subscription", () => {
  it("answers 204 with no body", async () => {
    const { backend, calls } = backendOf();
    const app = appWith(serviceOf(backend));
    const res = await app.fetch(
      new Request("https://gw.test/v1/push/evm/subscription", {
        method: "DELETE",
        headers: headers({ ...bearer() }),
      }),
    );
    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe("");
    expect(calls.unsubscribe).toHaveLength(1);
  });
});

describe("POST /v1/push/:family/transactions", () => {
  it("registers the watch", async () => {
    const { backend, calls } = backendOf();
    const app = appWith(serviceOf(backend));
    const res = await app.fetch(
      new Request(
        "https://gw.test/v1/push/evm/transactions",
        post({ network: "eip155:1", hash: "0xhash" }),
      ),
    );
    // the bearer is required — this request has none
    expect(res.status).toBe(400);
    const authed = await app.fetch(
      new Request("https://gw.test/v1/push/evm/transactions", {
        method: "POST",
        headers: headers({ "content-type": "application/json", ...bearer() }),
        body: JSON.stringify({ network: "eip155:1", hash: "0xhash" }),
      }),
    );
    expect(authed.status).toBe(200);
    const body: unknown = await authed.json();
    expect(accepts(pushWatch.response, body)).toBe(true);
    expect(body).toStrictEqual({});
    expect(calls.watch).toHaveLength(1);
  });
});
