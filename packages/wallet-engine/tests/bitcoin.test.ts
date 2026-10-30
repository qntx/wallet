import { describe, expect, it } from "vite-plus/test";

import { dustFor, esplora, feeTiers, isFrozen, validateEndpoint } from "../src/chains/bitcoin.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";

const es = (handlers: Record<string, unknown>): Esplora => ({
  get: async (path) => {
    const v = handlers[path];
    return v === undefined ? Promise.reject(new Error(`unmocked ${path}`)) : Promise.resolve(v);
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

describe("bitcoin adapter", () => {
  it("fee tiers pick 1/3/6/144 with a 1 sat/vB floor", async () => {
    const quotes = await feeTiers(
      es({ "/fee-estimates": { "1": 12.4, "3": 5, "6": 2, "144": 0.4 } }),
    );
    expect(quotes.map((q) => [q.tier, q.satPerByte])).toStrictEqual([
      ["fast", 13],
      ["normal", 5],
      ["slow", 2],
      ["economy", 1],
    ]);
  });

  it("dust floors per output type and the 546/330-sat freeze", () => {
    expect(dustFor("p2wpkh")).toBe(294);
    expect(dustFor("p2tr")).toBe(330);
    expect(dustFor("p2pkh")).toBe(546);
    expect(isFrozen(546)).toBe(true);
    expect(isFrozen(330)).toBe(true);
    expect(isFrozen(1000)).toBe(false);
  });

  it("rejects an endpoint whose genesis hash mismatches the registry", async () => {
    await expect(validateEndpoint(es({ "/block-height/0": "deadbeef" }), "0000aa")).rejects.toThrow(
      "genesis",
    );
    await expect(
      validateEndpoint(es({ "/block-height/0": "0000aa" }), "0000aa"),
    ).resolves.toBeUndefined();
  });
});

describe("esplora 429 handling", () => {
  const sleep = async () => Promise.resolve();
  const resp = (
    status: number,
    body: string,
    ra?: string,
  ): {
    ok: boolean;
    status: number;
    headers: { get: (n: string) => string | null };
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  } => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n === "retry-after" ? (ra ?? null) : null) },
    json: async () => Promise.resolve(JSON.parse(body) as unknown),
    text: async () => Promise.resolve(body),
  });

  it("retries a 429 with exponential backoff and then succeeds", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return Promise.resolve(resp(calls <= 2 ? 429 : 200, calls <= 2 ? "" : '{"ok":true}'));
    };
    const es = esplora(["https://a.test"], fetcher, sleep);
    const out = await es.get("/blocks/tip/height");
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("honours the Retry-After header", async () => {
    const delays: number[] = [];
    const record = async (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return Promise.resolve(
        resp(calls === 1 ? 429 : 200, calls === 1 ? "" : "ok", calls === 1 ? "5" : undefined),
      );
    };
    const es = esplora(["https://a.test"], fetcher, record);
    await es.get("/x");
    expect(delays).toEqual([5000]);
  });

  it("fails over to the next endpoint after exhausting retries on 429", async () => {
    const first = async () => Promise.resolve(resp(429, ""));
    const second = async () => Promise.resolve(resp(200, '"healthy"'));
    const es = esplora(
      ["https://a.test", "https://b.test"],
      async (url: string) => (url.includes("b.test") ? second() : first()),
      sleep,
    );
    const out = await es.get("/y");
    expect(out).toBe("healthy");
  });

  it("caps in-flight requests at four", async () => {
    let inFlight = 0;
    let max = 0;
    const fetcher = async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return resp(200, "[]");
    };
    const es = esplora(["https://a.test"], fetcher, sleep);
    await Promise.all([
      es.get("/a"),
      es.get("/b"),
      es.get("/c"),
      es.get("/d"),
      es.get("/e"),
      es.get("/f"),
    ]);
    expect(max).toBeLessThanOrEqual(4);
  });
});
