/**
 * Share-limiter math against the production account table: CoinGecko's slowest window (15,000
 * credits/day ≈ 10.4/min) puts one request's 5 % share delta (1,921 of a 1,000-unit window) above
 * the whole window, so every CoinGecko call is 413 too-costly before a fetch is ever attempted —
 * the eur price path can never be served and the smoke check's eur predicate can never hold.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  accepts,
  nativeAssetId,
  prices,
  pricesResponse,
} from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";
import { SHARE_LIMIT } from "../../src/middleware/rate-limit.ts";
import { COINGECKO_API } from "../../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../../src/providers/prices-defillama.ts";
import { fakeFetch, headers, post } from "../helpers.ts";
import { dash, pricesMissing, productionApp, smokePricesPredicate } from "./setup.ts";

const IP = "198.51.100.41";
const at = { "cf-connecting-ip": IP };

const asset = (network: string): string => {
  const id = nativeAssetId(network);
  if (id === undefined) {
    throw new Error(`${network} has no native asset`);
  }
  return id;
};
const ASSETS = [asset("bip122:000000000019d6689c085ae165831e93"), asset("eip155:1")];

const upstream = fakeFetch({
  // The stub quotes every requested key so a `usd` request passes on its merits.
  [`${DEFILLAMA_API}/prices/current/`]: (call) => {
    const keys = call.url.split("/").pop()?.split("?")[0]?.split(",") ?? [];
    return Response.json({
      coins: Object.fromEntries(
        keys.map((key) => [
          key,
          { price: 3000, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
        ]),
      ),
    });
  },
  [`${DEFILLAMA_API}/percentage/`]: (call) => {
    const keys = call.url.split("/").pop()?.split("?")[0]?.split(",") ?? [];
    return Response.json({ coins: Object.fromEntries(keys.map((key) => [key, 1.5])) });
  },
  [`${COINGECKO_API}/`]: () => Response.json({}),
});

const app = productionApp({ fetch: upstream.fetch });

const request = async (currency: string): Promise<Response> => {
  const init = post({ currency, assets: ASSETS });
  return app.request(prices.path, {
    ...init,
    headers: headers({ "content-type": "application/json", ...at }),
  });
};

describe("share delta vs a slow daily window", () => {
  it("eur prices: 413 too-costly and CoinGecko is never fetched", async () => {
    const res = await request("eur");
    const body = await res.text();
    const cgCalls = upstream.callsTo(COINGECKO_API).length;
    console.log(`eur → ${res.status} body=${body} coingecko-fetches=${String(cgCalls)}`);
    expect(res.status).toBe(413);
    expect(body).toBe('{"error":"too-costly"}');
    expect(cgCalls).toBe(0);
  });

  it("usd prices: 200 served by defillama only, CoinGecko still never fetched", async () => {
    const res = await request("usd");
    const body = await res.text();
    const cgCalls = upstream.callsTo(COINGECKO_API).length;
    console.log(
      `usd → ${res.status} providers=${dash(res.headers.get(PROVIDERS_HEADER))} ` +
        `coingecko-fetches=${String(cgCalls)} body=${body.slice(0, 140)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(PROVIDERS_HEADER)).toBe("defillama");
    expect(cgCalls).toBe(0);
  });

  it("the smoke eur predicate (accepts(pricesResponse) && missing empty) is unreachable", async () => {
    const res = await request("eur");
    const body: unknown = await res.json();
    const valid = accepts(pricesResponse, body);
    const missing = pricesMissing(body).length;
    const predicate = smokePricesPredicate(body, valid);
    console.log(
      `eur predicate: accepts=${String(valid)} missing=${String(missing)} → ${String(predicate)}`,
    );
    expect(predicate).toBe(false);
  });

  it("share delta table: coingecko's 1-unit delta exceeds the whole share window", () => {
    // Restated from rate-limit.ts: SHARE_OF_ACCOUNT = 0.05 (private), delta =
    // ceil(units * SHARE_LIMIT / (SHARE_OF_ACCOUNT * perMinute)) for a request-priced call.
    const SHARE_OF_ACCOUNT = 0.05;
    const rows = Object.entries(PRODUCTION_ACCOUNTS).map(([id, account]) => {
      const perMinute = Math.min(
        ...account.budget.map((window) => (window.units * 60) / window.seconds),
      );
      const delta = Math.max(1, Math.ceil(SHARE_LIMIT / (SHARE_OF_ACCOUNT * perMinute)));
      return { id, perMinute: perMinute.toFixed(2), delta, fits: delta <= SHARE_LIMIT };
    });
    for (const row of rows) {
      console.log(
        `share-delta ${row.id}: per-minute=${row.perMinute} delta=${String(row.delta)} fits=${String(row.fits)}`,
      );
    }
    const coingecko = rows.find((row) => row.id === "coingecko");
    expect(coingecko?.delta).toBeGreaterThan(SHARE_LIMIT);
  });
});
