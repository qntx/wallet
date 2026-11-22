import { readFileSync } from "node:fs";

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";

/**
 * Every market read replays its recorded live response through an injected fetch that asserts the
 * exact URL the fixture was recorded with — so URL/query construction and normalization are both
 * checked against real wire data. Error mapping and hostile-response fuzzing go through the same
 * seam.
 */
import type { Wallet } from "@qntx/wallet";

import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import { createPolymarketHttp } from "../src/apps/polymarket/http.ts";
import { createPolymarketMarkets } from "../src/apps/polymarket/markets.ts";
import { createPolymarketProvider } from "../src/apps/polymarket/provider.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { credentialsStore } from "./apps-helpers.ts";
import { manualTimers } from "./support/timers.ts";

type Fixture = {
  readonly request: { readonly method: string; readonly url: string };
  readonly fetchedAt: number;
  readonly response: unknown;
};

const fixture = (name: string): Fixture =>
  JSON.parse(
    readFileSync(new URL(`fixtures/polymarket/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;

type Picks = Record<
  "primary" | "negrisk" | "closed",
  { slug: string; conditionId: string; assetId: string }
> & { v2: { slug: string; conditionId: string; assetId: string } | null };

const PICKS = JSON.parse(
  readFileSync(new URL("fixtures/polymarket/_picks.json", import.meta.url), "utf8"),
) as Picks;

const FIXTURES = [
  "time",
  "events",
  "markets",
  "search",
  "event",
  "market-primary",
  "market-negrisk",
  "market-closed",
  "clob-market-primary",
  "clob-market-negrisk",
  "book-primary",
  "book-negrisk",
  "price-primary",
  "midpoint-primary",
  "history-primary",
  "fee-rate-primary",
  "resolution-closed",
].map(fixture);

/** Query params compare order-insensitively — `URLSearchParams.set` orders by first insert. */
const canonical = (url: string): string => {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  return `${parsed.origin}${parsed.pathname}?${JSON.stringify(params)}`;
};

/** A fixture value that must exist — throws a plain Error, failing the test. */
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("required fixture value is missing");
  }
  return value;
};

/** A fetch that serves the fixture whose URL matches — anything else fails the test. */
const fixtureFetch =
  (fixtures: ReadonlyArray<Fixture>): typeof globalThis.fetch =>
  async (input) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const found = fixtures.find((f) => canonical(f.request.url) === canonical(url));
    if (found === undefined) {
      throw new Error(`unrecorded request: ${url}`);
    }
    return Response.json(found.response, { status: 200 });
  };

/* Market reads never resolve the wallet or the trade surface — the provider defers them to the
   first account/place call. */
const NO_WALLET = {} as Wallet;
const NO_REQUESTS = {} as Parameters<typeof createPolymarketProvider>[0]["requests"];
/* Reads never reach the credential store — an always-open empty one is enough. */
const NO_CREDENTIALS = credentialsStore(() => createMemoryEngineStore());

const provider = () =>
  createPolymarketProvider({
    fetch: fixtureFetch(FIXTURES),
    setTimer: () => () => undefined,
    now: () => 1_800_000_000_000,
    wallet: NO_WALLET,
    credentials: NO_CREDENTIALS,
    requests: NO_REQUESTS,
    random: () => new Uint8Array(8),
    availability: () => "available",
    socket: () => ({
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }),
    logger: { warn: () => undefined },
  }).markets;

describe("polymarket market reads", () => {
  const markets = provider();

  it("lists events and markets with normalized fields", async () => {
    const events = await markets.events({
      closed: false,
      limit: 1,
      order: "volume",
      ascending: false,
    });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(required(event).markets.length).toBeGreaterThan(0);
    for (const market of required(event).markets) {
      expect(market.assetIds).toHaveLength(market.outcomes.length);
      expect(market.version).toBe("v1");
    }

    const list = await markets.markets({ closed: false, limit: 3 });
    expect(list.length).toBeGreaterThan(0);
    for (const market of list) {
      expect(market.conditionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(market.assetIds).toHaveLength(market.outcomes.length);
      expect(market.negRisk).toBeTypeOf("boolean");
    }
  });

  it("reads a market and event by slug", async () => {
    const primary = await markets.market(PICKS.primary.slug);
    expect(primary.slug).toBe(PICKS.primary.slug);
    expect(primary.conditionId).toBe(PICKS.primary.conditionId);
    expect(primary.assetIds[0]).toBe(PICKS.primary.assetId);
    expect(primary.version).toBe("v1");
    expect(primary.negRisk).toBe(false);
    expect(Number(primary.tickSize)).toBeGreaterThan(0);
    expect(Number(primary.minOrderSize)).toBeGreaterThan(0);

    const neg = await markets.market(PICKS.negrisk.slug);
    expect(neg.negRisk).toBe(true);

    const closed = await markets.market(PICKS.closed.slug);
    expect(closed.closed).toBe(true);

    const event = await markets.event(required(fixture("event").request.url.split("/").pop()));
    expect(event.markets.length).toBeGreaterThan(0);
  });

  it("searches events only", async () => {
    const found = await markets.search(required(PICKS.primary.slug.split("-")[0]));
    for (const event of found) {
      expect(event.id).toBeTypeOf("string");
    }
  });

  it("reads books sorted bids-desc, asks-asc", async () => {
    const books = await Promise.all(
      (["primary", "negrisk"] as const).map(async (role) => ({
        role,
        book: await markets.book(PICKS[role].assetId),
      })),
    );
    for (const { role, book } of books) {
      expect(book.assetId).toBe(PICKS[role].assetId);
      expect(book.conditionId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(book.version).toBe("v1");
      for (let i = 1; i < book.bids.length; i += 1) {
        expect(Number(required(book.bids[i]).price)).toBeLessThanOrEqual(
          Number(required(book.bids[i - 1]).price),
        );
      }
      for (let i = 1; i < book.asks.length; i += 1) {
        expect(Number(required(book.asks[i]).price)).toBeGreaterThanOrEqual(
          Number(required(book.asks[i - 1]).price),
        );
      }
    }
    /* The CLOB returns bids ascending / asks descending — normalization must reorder them. */
    const raw = fixture("book-primary").response as { bids: Array<{ price: string }> };
    expect(Number(raw.bids[0]?.price)).toBeLessThan(Number(raw.bids[1]?.price));
  });

  it("reads price, midpoint, fee rate and history", async () => {
    const price = await markets.price(PICKS.primary.assetId, "BUY");
    expect(Number(price)).toBeGreaterThan(0);
    const mid = await markets.midpoint(PICKS.primary.assetId);
    expect(Number(mid)).toBeGreaterThan(0);
    const fee = await markets.feeRate(PICKS.primary.assetId);
    expect(fee).toBeTypeOf("number");
    const history = await markets.history(PICKS.primary.assetId, { interval: "1w", fidelity: 60 });
    expect(history.length).toBeGreaterThan(0);
    for (const point of history) {
      expect(point.t).toBeTypeOf("number");
      expect(Number(point.p)).toBeGreaterThanOrEqual(0);
    }
  });

  it("reads clob market details with live abbreviated keys", async () => {
    const details = await markets.clobMarket(PICKS.primary.conditionId);
    expect(details.conditionId).toBe(PICKS.primary.conditionId);
    expect(details.tokens.map((t) => t.assetId)).toContain(PICKS.primary.assetId);
    expect(details.version).toBe("v1");
    expect(details.tickSize).toBe("0.001");
    expect(details.minOrderSize).toBe("5");
  });

  it("reads a resolved market's resolution row", async () => {
    const rows = await markets.resolution(PICKS.closed.conditionId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe("resolved");
    expect(rows[0]?.resolved).toBe(true);
    expect(rows[0]?.payouts).toHaveLength(2);
  });

  it("reads server time with a skew estimate", async () => {
    const { serverSeconds, skewMs } = await markets.time();
    expect(serverSeconds).toBe(fixture("time").response);
    expect(skewMs).toBe(Number(fixture("time").response) * 1000 - 1_800_000_000_000);
  });

  it("rejects an out-of-range limit before any request", async () => {
    await expect(markets.events({ limit: 101 })).rejects.toMatchObject({
      name: "PolymarketError",
      category: "invalid-input",
    });
    await expect(markets.events({ limit: 0 })).rejects.toMatchObject({ category: "invalid-input" });
  });
});

describe("polymarket http error mapping", () => {
  const respond = (init: typeof globalThis.fetch): ReturnType<typeof createPolymarketMarkets> =>
    createPolymarketMarkets(
      createPolymarketHttp({
        fetch: init,
        setTimer: () => () => undefined,
        now: () => 1_800_000_000_000,
      }),
    );

  /** A fetch that always answers `response` — async-with-await to satisfy lint. */
  const answer = (response: Response): typeof globalThis.fetch => {
    return async () => {
      await Promise.resolve();
      return response;
    };
  };

  it("maps a non-2xx with an error string to unavailable carrying it", async () => {
    const markets = respond(answer(Response.json({ error: "malformed request" }, { status: 400 })));
    await expect(markets.midpoint("1")).rejects.toMatchObject({
      name: "PolymarketError",
      category: "unavailable",
      message: expect.stringContaining("malformed request"),
    });
  });

  it("maps a non-2xx without a JSON error to unavailable", async () => {
    const markets = respond(answer(new Response("oops", { status: 503 })));
    await expect(markets.midpoint("1")).rejects.toMatchObject({ category: "unavailable" });
  });

  it("unavailable carries the status and the parsed object error body", async () => {
    const markets = respond(
      answer(Response.json({ error: "not found", extra: 7 }, { status: 404 })),
    );
    let caught: unknown;
    try {
      await markets.midpoint("1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      category: "unavailable",
      status: 404,
      body: { error: "not found", extra: 7 },
    });
  });

  it("other categories carry no status or body", async () => {
    const markets = respond(answer(new Response("<html>", { status: 200 })));
    let caught: unknown;
    try {
      await markets.midpoint("1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ category: "malformed" });
    /* The fields exist on the class — `unavailable` is the only category that sets them. */
    expect(caught).toMatchObject({ status: undefined, body: undefined });
  });

  it("maps a non-JSON body to malformed", async () => {
    const markets = respond(answer(new Response("<html>", { status: 200 })));
    await expect(markets.midpoint("1")).rejects.toMatchObject({ category: "malformed" });
  });

  it("maps a schema-failing body to malformed", async () => {
    const markets = respond(answer(Response.json({ mid: { nope: 1 } })));
    await expect(markets.midpoint("1")).rejects.toMatchObject({ category: "malformed" });
  });

  it("maps a fetch that throws to network", async () => {
    const markets = respond(async () => {
      await Promise.resolve();
      throw new TypeError("socket hang up");
    });
    await expect(markets.midpoint("1")).rejects.toMatchObject({ category: "network" });
  });

  it("maps a deadline miss to timeout via the injected timer", async () => {
    const timers = manualTimers();
    const http = createPolymarketHttp({
      /* Never answers on its own; rejects when the request signal aborts, like real fetch.
         The executor must run synchronously — an await first would miss a same-tick abort. */
      fetch: async (_input, init) => {
        const hanging = new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
        await Promise.resolve();
        return hanging;
      },
      setTimer: timers.setTimer,
      now: () => 1_800_000_000_000,
      timeoutMs: 5000,
    });
    const pending = http.request({ host: "https://x", method: "GET", path: "/t" }, z.any());
    expect(timers.armed(5000)).toBe(1);
    await timers.fire(5000);
    await expect(pending).rejects.toMatchObject({ category: "timeout" });
  });
});

describe("polymarket hostile responses", () => {
  const markets = (response: unknown): ReturnType<typeof createPolymarketMarkets> =>
    createPolymarketMarkets(
      createPolymarketHttp({
        fetch: async () => {
          await Promise.resolve();
          return typeof response === "string" ? new Response(response) : Response.json(response);
        },
        setTimer: () => () => undefined,
        now: () => 1_800_000_000_000,
      }),
    );

  /** Every path into a recorded response — the seeds for drop/replace mutations. */
  const paths = (value: unknown, prefix: string[] = []): string[][] => {
    if (typeof value !== "object" || value === null) {
      return [prefix];
    }
    const entries = Array.isArray(value)
      ? value.map((item, i) => [String(i), item] as const)
      : Object.entries(value);
    return entries.flatMap(([key, item]) => paths(item, [...prefix, key]));
  };
  const setPath = (root: Record<string, unknown>, path: string[], value: unknown): void => {
    let at = root;
    for (const key of path.slice(0, -1)) {
      const next = at[key];
      if (typeof next !== "object" || next === null) {
        return;
      }
      at = next as Record<string, unknown>;
    }
    const last = path.at(-1);
    if (last !== undefined) {
      at[last] = value;
    }
  };

  /** "normalized" | "typed" | "untyped" | "partial" — what a mangled answer produced. */
  const marketOutcome = async (body: unknown): Promise<string> => {
    try {
      const market = await markets(body).market("x");
      /* A surviving parse must still be normalized: ids match outcomes. */
      return market.assetIds.length === market.outcomes.length ? "normalized" : "partial";
    } catch (error) {
      return error instanceof PolymarketError ? "typed" : "untyped";
    }
  };

  it("a mangled recorded market never produces an untyped throw", async () => {
    const recorded = fixture("market-primary").response;
    const allPaths = paths(recorded).filter((p) => p.length > 0);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...allPaths), fc.jsonValue(), async (path, junk) => {
        const mangled = structuredClone(recorded) as Record<string, unknown>;
        setPath(mangled, path, junk);
        const outcome = await marketOutcome(mangled);
        expect(outcome).not.toBe("untyped");
        expect(outcome).not.toBe("partial");
      }),
    );
  });

  it("a v2 market reads assetIds from positionIds, not clobTokenIds", async () => {
    const recorded = structuredClone(fixture("market-primary").response) as Record<string, unknown>;
    recorded["version"] = "v2";
    recorded["positionIds"] = ["111", "222"];
    recorded["clobTokenIds"] = '["999", "888"]';
    const market = await markets(recorded).market("x");
    expect(market.version).toBe("v2");
    expect(market.assetIds).toStrictEqual(["111", "222"]);
  });

  it("a mismatched asset/outcome count is malformed", async () => {
    const recorded = structuredClone(fixture("market-primary").response) as {
      clobTokenIds: string;
    };
    recorded.clobTokenIds = '["1","2","3"]';
    await expect(markets(recorded).market("x")).rejects.toMatchObject({
      category: "malformed",
    });
  });

  it("an oversized hostile array is rejected, not held", async () => {
    const recorded = structuredClone(fixture("markets").response) as unknown[];
    const inflated = Array.from({ length: 300 }, () => recorded[0]);
    await expect(markets(inflated).markets()).rejects.toMatchObject({ category: "malformed" });
  });

  it("junk JSON is malformed", async () => {
    await expect(markets("{{{{").midpoint("1")).rejects.toMatchObject({ category: "malformed" });
  });
});
