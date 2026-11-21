/**
 * A share-limit refusal is provider-local: the client ran out of its share of that one account, so
 * the walk moves to the next provider instead of ending the request. Only when every provider is
 * share-refused does the client get its refusal back — 429 when any refusal was a spent share, 413
 * when every one was an oversized charge — and a broadcast may fail over too, because a refused
 * charge means nothing was sent.
 */
import { describe, expect, it } from "vite-plus/test";

import { PROVIDERS_HEADER, gatewayError } from "@qntx/wallet-engine/gateway/contract";

import type { Account } from "../src/config/accounts.ts";
import type { GatewayNetwork, Limiters, ProviderBudget, RateLimiter } from "../src/types.ts";
import {
  SEPOLIA,
  SIGNET,
  TEST_ACCOUNTS,
  TRON_BLOCK,
  allowAll,
  call,
  expectContract,
  fakeFetch,
  gateway,
  headers,
  post,
  productionGateway,
  rpcOk,
} from "./helpers.ts";

const HASH = "ab".repeat(32);
const TXID = "cd".repeat(32);
const IP = "198.51.100.41";
const at = { "cf-connecting-ip": IP };
const TRON_MAINNET = "tron:728126428";

/** A share limiter that refuses the keys `refused` matches and admits the rest. */
const refusing = (refused: (key: string) => boolean): RateLimiter => ({
  limit: async ({ key }) => {
    await Promise.resolve();
    return { success: !refused(key) };
  },
});

const shareOnly = (share: RateLimiter): Limiters => ({
  ip: allowAll,
  rpc: allowAll,
  default: allowAll,
  share,
});

describe("share-limit failover", () => {
  it("fails a TRON read over when the first provider's share is refused", async () => {
    const up = fakeFetch({
      "https://api.trongrid.io": () => Response.json(TRON_BLOCK),
      "https://tron-mainnet.gateway.tatum.io": () => Response.json(TRON_BLOCK),
    });
    const app = productionGateway({
      fetch: up.fetch,
      share: refusing((key) => key.startsWith("trongrid:")),
    });
    const res = await app.request(`/v1/tron/${TRON_MAINNET}/wallet/getnowblock`, {
      ...post({}),
      headers: headers({ "content-type": "application/json", ...at }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toContain("tatum");
    expect(up.callsTo("https://api.trongrid.io")).toHaveLength(0);
    expect(up.callsTo("https://tron-mainnet.gateway.tatum.io")).toHaveLength(1);
  });

  it("answers 429 when the only provider is share-refused", async () => {
    const networks: ReadonlyArray<GatewayNetwork> = [
      { id: SEPOLIA, providers: [{ id: "a", url: "https://a.test/evm" }] },
    ];
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0x1") });
    const app = gateway({
      fetch: up.fetch,
      networks,
      limiters: shareOnly(refusing(() => true)),
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(429);
    await expectContract(res, gatewayError);
    await expect(res.json()).resolves.toStrictEqual({ error: "rate-limited" });
    expect(res.headers.get("retry-after")).toBe("60");
    expect(up.calls).toHaveLength(0);
  });

  it("answers 429 when every provider is share-refused and calls no upstream", async () => {
    const up = fakeFetch({
      "https://api.trongrid.io": () => Response.json(TRON_BLOCK),
      "https://tron-mainnet.gateway.tatum.io": () => Response.json(TRON_BLOCK),
    });
    const app = productionGateway({ fetch: up.fetch, share: refusing(() => true) });
    const res = await app.request(`/v1/tron/${TRON_MAINNET}/wallet/getnowblock`, {
      ...post({}),
      headers: headers({ "content-type": "application/json", ...at }),
    });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toStrictEqual({ error: "rate-limited" });
    expect(res.headers.get("retry-after")).toBe("60");
    expect(up.calls).toHaveLength(0);
  });

  it("answers 413 when every provider's charge exceeds the share window", async () => {
    // A one-unit account window admits 0.05 units/minute per prefix, so a single call's charge
    // already exceeds SHARE_LIMIT — a too-costly share refusal on every provider.
    const tiny = (): Account => ({
      costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
      budget: [{ units: 1, seconds: 60 }],
      clientShare: 0.05,
    });
    const up = fakeFetch({ "https://a.test/evm": () => rpcOk("0x1") });
    const app = gateway({
      fetch: up.fetch,
      accounts: { ...TEST_ACCOUNTS, a: tiny(), b: tiny() },
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(413);
    await expectContract(res, gatewayError);
    await expect(res.json()).resolves.toStrictEqual({ error: "too-costly" });
    expect(up.calls).toHaveLength(0);
  });

  it("answers 503 when a share refusal is followed by a spent budget", async () => {
    const up = fakeFetch({ "https://b.test/evm": () => rpcOk("0x1") });
    const budget: ProviderBudget = {
      take: async (account) => {
        await Promise.resolve();
        // oxlint-disable-next-line vitest/no-conditional-in-test -- refuses only account b
        return account === "b" ? { ok: false, retryAfterSeconds: 7 } : { ok: true };
      },
    };
    const app = gateway({
      fetch: up.fetch,
      limiters: shareOnly(refusing((key) => key.startsWith("a:"))),
      budget,
    });
    const res = await app.request(`/v1/rpc/${SEPOLIA}`, post(call("eth_chainId")));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toStrictEqual({ error: "unavailable" });
    expect(res.headers.get("retry-after")).toBe("7");
    expect(up.calls).toHaveLength(0);
  });

  it("fails an EVM broadcast over past a share refusal", async () => {
    const up = fakeFetch({
      "https://a.test/evm": () => rpcOk("0x0"),
      "https://b.test/evm": () => rpcOk(`0x${HASH}`),
    });
    const app = gateway({
      fetch: up.fetch,
      limiters: shareOnly(refusing((key) => key.startsWith("a:"))),
    });
    const res = await app.request(
      `/v1/rpc/${SEPOLIA}`,
      post(call("eth_sendRawTransaction", [`0x02${"ab".repeat(64)}`])),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    expect(up.callsTo("https://a.test")).toHaveLength(0);
    expect(up.callsTo("https://b.test")).toHaveLength(1);
  });

  it("fails an Esplora broadcast over past a share refusal", async () => {
    const up = fakeFetch({
      "https://a.test/btc": () => new Response("unreachable", { status: 500 }),
      "https://b.test/btc": () =>
        new Response(HASH, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    const app = gateway({
      fetch: up.fetch,
      limiters: shareOnly(refusing((key) => key.startsWith("a:"))),
    });
    const res = await app.request(`/v1/esplora/${SIGNET}/tx`, {
      method: "POST",
      headers: headers({ "content-type": "text/plain" }),
      body: "0200000001",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("b");
    await expect(res.text()).resolves.toBe(HASH);
    expect(up.callsTo("https://a.test")).toHaveLength(0);
    expect(up.callsTo("https://b.test")).toHaveLength(1);
  });

  it("fails a TRON broadcast over past a share refusal", async () => {
    const up = fakeFetch({
      "https://api.trongrid.io": () => Response.json(TRON_BLOCK),
      "https://tron-mainnet.gateway.tatum.io": () => Response.json({ result: true, txid: TXID }),
    });
    const app = productionGateway({
      fetch: up.fetch,
      share: refusing((key) => key.startsWith("trongrid:")),
    });
    const res = await app.request(`/v1/tron/${TRON_MAINNET}/wallet/broadcasthex`, {
      ...post({ transaction: "00".repeat(32) }),
      headers: headers({ "content-type": "application/json", ...at }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toContain("tatum");
    expect(up.callsTo("https://api.trongrid.io")).toHaveLength(0);
    expect(up.callsTo("https://tron-mainnet.gateway.tatum.io")).toHaveLength(1);
  });
});
