import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { parseWith, tokenListResponse } from "@qntx/wallet-engine/gateway/contract";
import type { TokenListResponse } from "@qntx/wallet-engine/gateway/contract";

import { buildTokenLists } from "../src/tokens/build.ts";
import { tokenListSources } from "../src/tokens/sources.ts";
import type { RawToken, TokenListUpstream } from "../src/tokens/sources.ts";
import {
  DEVNET,
  fakeFetch,
  gateway,
  headers,
  memoryRiskStore,
  ORIGIN,
  recordingLimiter,
  SEPOLIA,
  SIGNET,
} from "./helpers.ts";

const fixture = (name: string): { readonly source: string; readonly tokens: unknown[] } =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url).pathname, "utf8")) as {
    readonly source: string;
    readonly tokens: unknown[];
  };

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const FIXTURE_URLS: Readonly<Record<string, () => Response>> = {
  "https://fixture.test/uniswap": () => Response.json(fixture("tokens-uniswap")),
  "https://fixture.test/coingecko": () => Response.json(fixture("tokens-coingecko-hyperevm")),
  "https://fixture.test/jupiter": () => Response.json(fixture("tokens-jupiter").tokens),
};

/** The three real upstreams, repointed at fixture URLs so the recorded documents drive them. */
const fixtureSources = (): ReadonlyArray<TokenListUpstream> =>
  tokenListSources({ coingecko: "cg-key", jupiter: "jup-key" }).map((source) => ({
    ...source,
    url: `https://fixture.test/${source.id}`,
  }));

/** A synthetic upstream whose parse ignores the fetched body and returns `raw`. */
const source = (
  id: "uniswap" | "coingecko" | "jupiter",
  networks: ReadonlyArray<string>,
  raw: ReadonlyMap<string, ReadonlyArray<RawToken>>,
  url = `https://fixture.test/${id}`,
): TokenListUpstream => ({ id, url, networks, parse: () => raw });

const evmToken = (address: string, extra: Partial<RawToken> = {}): RawToken => ({
  address,
  symbol: "TOK",
  name: "Token",
  decimals: 18,
  ...extra,
});

const build = async (
  sources: ReadonlyArray<TokenListUpstream>,
  options: {
    readonly store?: ReturnType<typeof memoryRiskStore> & {
      readonly data: Map<string, string>;
    };
    readonly now?: number;
    readonly fetch?: typeof globalThis.fetch;
  } = {},
): Promise<{
  readonly store: ReturnType<typeof memoryRiskStore>;
  readonly lines: string[];
}> => {
  const store = options.store ?? memoryRiskStore();
  const lines: string[] = [];
  await buildTokenLists({
    fetch: options.fetch ?? fakeFetch(FIXTURE_URLS).fetch,
    store,
    now: () => options.now ?? 1000,
    log: (line) => lines.push(line),
    sources,
  });
  return { store, lines };
};

/** The parsed entries of `network`, empty when absent — keeps `??` out of test bodies. */
const entriesOf = (
  parsed: ReadonlyMap<string, ReadonlyArray<RawToken>>,
  network: string,
): ReadonlyArray<RawToken> => parsed.get(network) ?? [];

/** `true` when a log line contains every fragment — keeps `&&` out of test bodies. */
const hasLine = (lines: ReadonlyArray<string>, ...parts: ReadonlyArray<string>): boolean =>
  lines.some((line) => parts.every((part) => line.includes(part)));

/** The stored body of `network`'s list, empty when absent. */
const storedBody = (store: { readonly data: Map<string, string> }, network: string): string =>
  store.data.get(`tokens:${network}`) ?? "";

const stored = (
  store: { readonly data: Map<string, string> },
  network: string,
): TokenListResponse | undefined => {
  const body = store.data.get(`tokens:${network}`);
  return body === undefined ? undefined : parseWith(tokenListResponse, JSON.parse(body));
};

describe("tokenListSources", () => {
  it("omits coingecko without a key and leaves jupiter unauthenticated", () => {
    const sources = tokenListSources({});
    expect(sources.map((s) => s.id)).toStrictEqual(["uniswap", "jupiter"]);
    expect(sources.find((s) => s.id === "jupiter")?.headers).toBeUndefined();
  });

  it("sends the pro key to coingecko and the api key to jupiter", () => {
    const sources = tokenListSources({ coingecko: "cg", jupiter: "jup" });
    expect(sources.map((s) => s.id)).toStrictEqual(["uniswap", "coingecko", "jupiter"]);
    expect(sources.find((s) => s.id === "coingecko")?.headers).toStrictEqual({
      "x-cg-pro-api-key": "cg",
    });
    expect(sources.find((s) => s.id === "jupiter")?.headers).toStrictEqual({ "x-api-key": "jup" });
  });

  it("keeps the sources' networks disjoint", () => {
    const seen = new Set<string>();
    for (const s of tokenListSources({ coingecko: "cg" })) {
      for (const network of s.networks) {
        expect(seen.has(network)).toBe(false);
        seen.add(network);
      }
    }
  });
});

describe("source parsers", () => {
  const sources = fixtureSources();
  const byId = (id: string): TokenListUpstream => {
    const found = sources.find((s) => s.id === id);
    if (found === undefined) {
      throw new Error("missing source");
    }
    return found;
  };

  it("maps uniswap chainIds to caip2", () => {
    const parsed = byId("uniswap").parse(fixture("tokens-uniswap"));
    expect([...parsed.keys()].toSorted()).toStrictEqual([
      "eip155:1",
      "eip155:42161",
      "eip155:43114",
      "eip155:56",
      "eip155:8453",
    ]);
    expect(entriesOf(parsed, "eip155:1").map((t) => t.symbol)).toStrictEqual(["0G", "USDC"]);
  });

  it("drops Celo's native-alias CELO but keeps its real tokens", () => {
    const parsed = byId("uniswap").parse({
      tokens: [
        {
          chainId: 42220,
          address: "0x471EcE3750Da237f93B8E339c536989b8978a438",
          symbol: "CELO",
          name: "Celo native asset",
          decimals: 18,
        },
        {
          chainId: 42220,
          address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
        },
      ],
    });
    expect(entriesOf(parsed, "eip155:42220").map((t) => t.symbol)).toStrictEqual(["USDC"]);
  });

  it("maps the coingecko hyperevm document to eip155:999", () => {
    const parsed = byId("coingecko").parse(fixture("tokens-coingecko-hyperevm"));
    expect([...parsed.keys()]).toStrictEqual(["eip155:999"]);
    expect(parsed.get("eip155:999")?.length).toBe(4);
  });

  it("drops jupiter entries tagged deprecated, duplicate or flagged isSus", () => {
    const parsed = byId("jupiter").parse(fixture("tokens-jupiter").tokens);
    const symbols = entriesOf(parsed, SOLANA_MAINNET).map((t) => t.symbol);
    expect(symbols).toStrictEqual(["SOL", "USDC"]);
  });

  it("throws on a wrong document shape", () => {
    expect(() => byId("uniswap").parse({ nope: [] })).toThrow(TypeError);
    expect(() => byId("jupiter").parse({})).toThrow(TypeError);
    expect(() => byId("jupiter").parse([{ name: "x" }])).toThrow(TypeError);
  });
});

describe("buildTokenLists", () => {
  it("publishes every network of the fixture sources as a contract-valid document", async () => {
    const { store, lines } = await build(fixtureSources());
    const doc = stored(store, "eip155:1");
    expect(doc?.network).toBe("eip155:1");
    expect(doc?.version).toBe(1000);
    expect(doc?.sources).toStrictEqual(["uniswap"]);
    expect(doc?.tokens.map((t) => t.address)).toStrictEqual([
      "0x4b948d64de1f71fcd12fb586f4c776421a35b3ee",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    ]);
    const solana = stored(store, SOLANA_MAINNET);
    expect(solana?.tokens.length).toBe(2);
    expect(stored(store, "eip155:999")?.tokens.length).toBe(4);
    // uniswap's 15 networks (most empty in the excerpt) + coingecko + jupiter.
    expect(lines.filter((l) => l.includes('"event":"token-list-build"'))).toHaveLength(17);
  });

  it("normalizes case and whitespace and drops entries failing the schema", async () => {
    const raw = new Map([
      [
        SEPOLIA,
        [
          evmToken("0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", {
            symbol: " USDC ",
            name: "USD Coin",
            decimals: 6,
          }),
          evmToken("0x1111111111111111111111111111111111111111", { symbol: "EVIL" }),
          evmToken("0x2222222222222222222222222222222222222222", { decimals: 300 }),
          evmToken("0x3333333333333333333333333333333333333333", { decimals: -1 }),
          evmToken("not-an-address"),
          evmToken("0x4444444444444444444444444444444444444444", { symbol: "" }),
          evmToken("0x5555555555555555555555555555555555555555", { name: "   " }),
          evmToken("0x6666666666666666666666666666666666666666", { decimals: "18" }),
          evmToken("0x7777777777777777777777777777777777777777", { symbol: "X".repeat(21) }),
          evmToken("0x8888888888888888888888888888888888888888", { name: "n".repeat(65) }),
        ],
      ],
    ]);
    const { store } = await build([source("uniswap", [SEPOLIA], raw)]);
    expect(stored(store, SEPOLIA)?.tokens).toStrictEqual([
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ]);
  });

  it("keeps one of duplicate addresses agreeing on decimals, drops them on conflict", async () => {
    const address = "0x9999999999999999999999999999999999999999";
    const agreeing = await build([
      source("uniswap", [SEPOLIA], new Map([[SEPOLIA, [evmToken(address), evmToken(address)]]])),
    ]);
    expect(stored(agreeing.store, SEPOLIA)?.tokens.length).toBe(1);

    const conflicting = await build([
      source(
        "uniswap",
        [SEPOLIA],
        new Map([
          [SEPOLIA, [evmToken(address, { decimals: 6 }), evmToken(address, { decimals: 8 })]],
        ]),
      ),
    ]);
    expect(stored(conflicting.store, SEPOLIA)?.tokens).toStrictEqual([]);
  });

  it("skips a network whose cleaned list exceeds the family cap", async () => {
    const raw = new Map([
      [
        SEPOLIA,
        Array.from({ length: 1501 }, (_, i) => evmToken(`0x${i.toString(16).padStart(40, "0")}`)),
      ],
    ]);
    const { store, lines } = await build([source("uniswap", [SEPOLIA], raw)]);
    expect(store.data.has(`tokens:${SEPOLIA}`)).toBe(false);
    expect(lines.some((l) => l.includes('"too-large"'))).toBe(true);
  });

  it("keeps the stored list when a source shrinks by more than half", async () => {
    const big = Array.from({ length: 100 }, (_, i) =>
      evmToken(`0x${i.toString(16).padStart(40, "0")}`),
    );
    const first = await build([source("uniswap", [SEPOLIA], new Map([[SEPOLIA, big]]))], {
      now: 500,
    });
    const before = storedBody(first.store, SEPOLIA);
    expect(before).not.toBe("");
    const { lines } = await build(
      [source("uniswap", [SEPOLIA], new Map([[SEPOLIA, big.slice(0, 40)]]))],
      { store: first.store, now: 900 },
    );
    expect(first.store.data.get(`tokens:${SEPOLIA}`)).toBe(before);
    expect(lines.some((l) => l.includes('"shrank"'))).toBe(true);
  });

  it("bumps the version monotonically even when the clock goes back", async () => {
    const store = memoryRiskStore();
    await build(
      [
        source(
          "uniswap",
          [SEPOLIA],
          new Map([[SEPOLIA, [evmToken("0x0000000000000000000000000000000000000001")]]]),
        ),
      ],
      { store, now: 5000 },
    );
    await build(
      [
        source(
          "uniswap",
          [SEPOLIA],
          new Map([[SEPOLIA, [evmToken("0x0000000000000000000000000000000000000002")]]]),
        ),
      ],
      { store, now: 4000 },
    );
    const doc = stored(store, SEPOLIA);
    expect(doc?.version).toBe(5001);
    expect(doc?.tokens[0]?.address).toBe("0x0000000000000000000000000000000000000002");
  });

  it("does not rewrite an unchanged list", async () => {
    const inner = memoryRiskStore();
    const puts: string[] = [];
    const store = {
      data: inner.data,
      get: inner.get,
      put: async (key: string, value: string) => {
        puts.push(key);
        await inner.put(key, value);
      },
    };
    const raw = new Map([[SEPOLIA, [evmToken("0x0000000000000000000000000000000000000001")]]]);
    const options = { store };
    await build([source("uniswap", [SEPOLIA], raw)], { ...options, now: 100 });
    await build([source("uniswap", [SEPOLIA], raw)], { ...options, now: 200 });
    expect(puts).toStrictEqual([`tokens:${SEPOLIA}`]);
    expect(stored(store, SEPOLIA)?.version).toBe(100);
  });

  it("isolates a failing source: its networks stay untouched, others still publish", async () => {
    const failing = source("coingecko", ["eip155:999"], new Map(), "https://fixture.test/down");
    const good = source(
      "uniswap",
      [SEPOLIA],
      new Map([[SEPOLIA, [evmToken("0x0000000000000000000000000000000000000001")]]]),
    );
    const { store, lines } = await build([failing, good], {
      fetch: fakeFetch({
        ...FIXTURE_URLS,
        "https://fixture.test/down": () => new Response("oops", { status: 500 }),
      }).fetch,
    });
    expect(store.data.has("tokens:eip155:999")).toBe(false);
    expect(stored(store, SEPOLIA)?.tokens.length).toBe(1);
    expect(hasLine(lines, '"source-failed"', '"coingecko"')).toBe(true);
  });
});

describe("GET /v1/tokens/:caip2", () => {
  const DOC = JSON.stringify({
    network: SEPOLIA,
    version: 42,
    sources: ["uniswap"],
    tokens: [
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ],
  });

  const seeded = (): {
    readonly store: ReturnType<typeof memoryRiskStore>;
    readonly app: ReturnType<typeof gateway>;
  } => {
    const store = memoryRiskStore();
    return { store, app: gateway({ fetch: fakeFetch({}).fetch, tokens: store }) };
  };

  it("serves the stored document verbatim with a strong etag", async () => {
    const { store, app } = seeded();
    await store.put(`tokens:${SEPOLIA}`, DOC);
    const res = await app.request(`/v1/tokens/${SEPOLIA}`, { headers: headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    await expect(res.text()).resolves.toBe(DOC);
  });

  it("answers 304 for a matching if-none-match and keeps the etag stable", async () => {
    const { store, app } = seeded();
    await store.put(`tokens:${SEPOLIA}`, DOC);
    const first = await app.request(`/v1/tokens/${SEPOLIA}`, { headers: headers() });
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const again = await app.request(`/v1/tokens/${SEPOLIA}`, { headers: headers() });
    expect(again.headers.get("etag")).toBe(etag);
    const res = await app.request(`/v1/tokens/${SEPOLIA}`, {
      headers: headers({ "if-none-match": String(etag) }),
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    await expect(res.text()).resolves.toBe("");
  });

  it("404s for a served network with no list and for an unserved family", async () => {
    const { app } = seeded();
    const missing = await app.request(`/v1/tokens/${SEPOLIA}`, { headers: headers() });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: "not-found" });
    const unserved = await app.request(`/v1/tokens/${SIGNET}`, { headers: headers() });
    expect(unserved.status).toBe(404);
    await expect(unserved.json()).resolves.toMatchObject({ error: "unknown-network" });
  });

  it("allows if-none-match in the CORS preflight", async () => {
    const { app } = seeded();
    const res = await app.request(`/v1/tokens/${SEPOLIA}`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-client-id, if-none-match",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "if-none-match",
    );
  });

  it("charges one unit to each limiter", async () => {
    const ip = recordingLimiter();
    const dflt = recordingLimiter();
    const rpc = recordingLimiter();
    const store = memoryRiskStore();
    await store.put(`tokens:${SEPOLIA}`, DOC);
    const app = gateway({
      fetch: fakeFetch({}).fetch,
      tokens: store,
      limiters: { ip, rpc, default: dflt },
    });
    const res = await app.request(`/v1/tokens/${SEPOLIA}`, { headers: headers() });
    expect(res.status).toBe(200);
    expect(ip.deltas).toStrictEqual([1]);
    expect(dflt.deltas).toStrictEqual([1]);
    expect(rpc.deltas).toStrictEqual([]);
  });

  it("rejects a request without a client id like every other route", async () => {
    const { app } = seeded();
    const res = await app.request(`/v1/tokens/${DEVNET}`);
    expect(res.status).toBe(400);
  });
});
