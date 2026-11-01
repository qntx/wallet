import { describe, expect, it } from "vite-plus/test";

import { dustFor, esplora, feeTiers, isFrozen, validateEndpoint } from "../src/chains/bitcoin.ts";
import type { Esplora, EsploraFetch } from "../src/chains/bitcoin.ts";

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
  const resp = (status: number, body: string, ra?: string) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n === "retry-after" ? ra : undefined) },
    json: async () => Promise.resolve(JSON.parse(body) as unknown),
    text: async () => Promise.resolve(body),
  });
  const failThen = (fails: number, okBody: string) => {
    let calls = 0;
    const status = () => (calls <= fails ? 429 : 200);
    const body = () => (calls <= fails ? "" : okBody);
    return {
      calls: () => calls,
      fetcher: async () => {
        calls += 1;
        return Promise.resolve(resp(status(), body()));
      },
    };
  };
  const raFetcher = () => {
    let calls = 0;
    const build = () => (calls === 1 ? resp(429, "", "5") : resp(200, "ok"));
    return async () => {
      calls += 1;
      return Promise.resolve(build());
    };
  };
  const byHost = async (url: string) => {
    const healthy = url.includes("b.test");
    const status = healthy ? 200 : 429;
    const body = healthy ? '"healthy"' : "";
    return Promise.resolve(resp(status, body));
  };
  const trackPeak = () => {
    let inFlight = 0;
    let max = 0;
    return {
      max: () => max,
      fetcher: async () => {
        inFlight += 1;
        if (inFlight > max) {
          max = inFlight;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        inFlight -= 1;
        return resp(200, "[]");
      },
    };
  };

  it("retries a 429 with exponential backoff and then succeeds", async () => {
    const { fetcher, calls } = failThen(2, '{"ok":true}');
    const es = esplora(["https://a.test"], fetcher, sleep);
    const out = await es.get("/blocks/tip/height");
    expect(out).toStrictEqual({ ok: true });
    expect(calls()).toBe(3);
  });

  it("honours the Retry-After header", async () => {
    const delays: number[] = [];
    const record = async (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const es = esplora(["https://a.test"], raFetcher(), record);
    await es.get("/x");
    expect(delays).toStrictEqual([5000]);
  });

  it("fails over to the next endpoint after exhausting retries on 429", async () => {
    const es = esplora(["https://a.test", "https://b.test"], byHost, sleep);
    const out = await es.get("/y");
    expect(out).toBe("healthy");
  });

  /** Answers each URL's first request with 429 and every later one with a body. */
  const throttledOnce = (): EsploraFetch => {
    const seen = new Set<string>();
    return async (url) => {
      await Promise.resolve();
      if (seen.has(url)) {
        return resp(200, '"served"');
      }
      seen.add(url);
      return resp(429, "");
    };
  };

  it("releases its slot before backing off a 429, so a throttled burst cannot deadlock", async () => {
    // Every request is throttled once, then served: with eight concurrent gets all four slots
    // are throttled at once — retrying inside the slot would wait on itself forever.
    const es = esplora(["https://a.test"], throttledOnce(), sleep);
    const paths = Array.from({ length: 8 }, (_, i) => `/p/${i}`);
    await expect(Promise.all(paths.map(async (p) => es.get(p)))).resolves.toStrictEqual(
      paths.map(() => "served"),
    );
  });

  it("caps in-flight requests at four", async () => {
    const { fetcher, max } = trackPeak();
    const es = esplora(["https://a.test"], fetcher, sleep);
    await Promise.all([
      es.get("/a"),
      es.get("/b"),
      es.get("/c"),
      es.get("/d"),
      es.get("/e"),
      es.get("/f"),
    ]);
    expect(max()).toBeLessThanOrEqual(4);
  });
});
