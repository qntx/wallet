/* oxlint-disable vitest/no-conditional-in-test -- the flatMap each already encodes the matrix */
import { describe, expect, it } from "vite-plus/test";

import { networkById } from "@qntx/wallet-engine/gateway/contract";

import { createGateway } from "../src/app.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import { bearer, blockstreamAuth, header } from "../src/providers/auth.ts";
import { allowAll, call, fakeFetch, headers, memoryRiskStore, post, rpcOk } from "./helpers.ts";

const limiters = { rpc: allowAll, default: allowAll };
const risk = memoryRiskStore();

const NET = {
  id: "eip155:11155111",
  providers: [
    { id: "keyed", url: "https://keyed.test/rpc", auth: "alchemy" as const },
    { id: "plain", url: "https://plain.test/rpc" },
  ],
};
const BTCNET = {
  id: "bip122:00000008819873e925422c1ff0f99f7c",
  providers: [{ id: "bs", url: "https://bs.test/api", auth: "blockstream" as const }],
};

describe("upstream auth", () => {
  it("sends the provider's auth headers on rpc and esplora requests", async () => {
    const { fetch, callsTo } = fakeFetch({
      "https://keyed.test": () => rpcOk("0x1"),
      "https://bs.test": () => new Response("0000genesis"),
    });
    const app = createGateway({
      fetch,
      networks: [NET, BTCNET],
      limiters,
      corsOrigins: [],
      risk,
      auth: { alchemy: bearer("k1"), blockstream: header("X-Auth", "k2") },
    });
    const r = await app.fetch(
      new Request("https://gw.test/v1/rpc/eip155:11155111", post(call("eth_chainId"))),
    );
    expect(r.status).toBe(200);
    const sent = callsTo("https://keyed.test")[0]?.headers as Record<string, string>;
    expect(sent["authorization"]).toBe("Bearer k1");
    const e = await app.fetch(
      new Request(
        "https://gw.test/v1/esplora/bip122:00000008819873e925422c1ff0f99f7c/block-height/0",
        { headers: headers() },
      ),
    );
    expect(e.status).toBe(200);
    const sentBtc = callsTo("https://bs.test")[0]?.headers as Record<string, string>;
    expect(sentBtc["X-Auth"]).toBe("k2");
  });

  it("fails over when a provider's auth throws and never keys an unkeyed provider", async () => {
    const { fetch, callsTo } = fakeFetch({
      "https://keyed.test": () => rpcOk("0x1"),
      "https://plain.test": () => rpcOk("0x2"),
    });
    const app = createGateway({
      fetch,
      networks: [NET],
      limiters,
      corsOrigins: [],
      risk,
      auth: {
        alchemy: async () => {
          await Promise.resolve();
          throw new Error("auth down");
        },
      },
    });
    const r = await app.fetch(
      new Request("https://gw.test/v1/rpc/eip155:11155111", post(call("eth_chainId"))),
    );
    expect(r.status).toBe(200);
    const plain = callsTo("https://plain.test")[0]?.headers as Record<string, string>;
    expect(plain["authorization"]).toBeUndefined();
  });

  it("refuses to build when a provider names an unconfigured auth", () => {
    expect(() =>
      createGateway({
        fetch: async () => {
          await Promise.resolve();
          return new Response();
        },
        networks: [NET],
        limiters,
        corsOrigins: [],
        risk,
        auth: {},
      }),
    ).toThrow('unconfigured auth "alchemy"');
  });
});

describe("blockstreamAuth", () => {
  const ok = (expiresIn = 300): Response =>
    Response.json({ access_token: "tok", expires_in: expiresIn, token_type: "Bearer" });

  it("posts the client-credentials form and caches until 30s before expiry", async () => {
    let t = 0;
    const calls: Array<{ url: string; body: string }> = [];
    const fn = blockstreamAuth({
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        await Promise.resolve();
        return ok();
      },
      clientId: "id",
      clientSecret: "sec",
      now: () => t,
    });
    const a = await fn();
    expect(a).toStrictEqual({ authorization: "Bearer tok" });
    t = 260_000;
    await fn();
    expect(calls).toHaveLength(1);
    t = 271_000;
    await fn();
    expect(calls).toHaveLength(2);
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("client_id")).toBe("id");
    expect(form.get("client_secret")).toBe("sec");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("openid");
    expect(calls[0]?.url).toContain("login.blockstream.com");
  });

  it("shares one in-flight fetch across concurrent callers", async () => {
    const resolvers: Array<(v: Response) => void> = [];
    const gate = new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    });
    let count = 0;
    const fn = blockstreamAuth({
      fetch: async () => {
        count += 1;
        await Promise.resolve();
        return gate;
      },
      clientId: "id",
      clientSecret: "sec",
      now: () => 0,
    });
    const [p1, p2] = [fn(), fn()];
    resolvers[0]?.(ok());
    await Promise.all([p1, p2]);
    expect(count).toBe(1);
  });

  it("does not cache failures — non-2xx, malformed and wrong token_type all retry", async () => {
    let n = 0;
    const bodies = [
      new Response("no", { status: 500 }),
      Response.json({ nope: 1 }),
      Response.json({ access_token: "t", expires_in: 300, token_type: "MAC" }),
      ok(),
    ];
    const fn = blockstreamAuth({
      fetch: async () => {
        await Promise.resolve();
        return bodies[Math.min(n++, bodies.length - 1)] ?? ok();
      },
      clientId: "id",
      clientSecret: "sec",
      now: () => 0,
    });
    await expect(fn()).rejects.toThrow("500");
    await expect(fn()).rejects.toThrow("malformed");
    await expect(fn()).rejects.toThrow("malformed");
    await expect(fn()).resolves.toStrictEqual({ authorization: "Bearer tok" });
    expect(n).toBe(4);
  });
});

describe("network config", () => {
  it.each(PRODUCTION_NETWORKS.flatMap((n) => n.providers.map((p) => ({ n: n.id, p }))))(
    "$n $p.id is a registry mainnet with a keyless url",
    ({ n, p }) => {
      expect(networkById(n)?.testnet).toBe(false);
      expect(p.url).not.toMatch(/key|token|secret/i);
    },
  );

  it.each(STAGING_NETWORKS)("%s is a registry testnet", (n) => {
    expect(networkById(n.id)?.testnet).toBe(true);
  });

  it("production bitcoin rides a single Blockstream Enterprise provider", () => {
    expect(PRODUCTION_NETWORKS.find((n) => n.id.startsWith("bip122"))?.providers).toHaveLength(1);
  });
});
