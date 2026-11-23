/**
 * Per-IP-prefix share metering on the production account table: each account row bounds one prefix
 * to a fraction of its minute-scale window — slower day/month windows cap the shared budget only —
 * so everyday calls (eur prices, TRON reads, Jupiter quotes) keep working at the advertised
 * per-prefix rate.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDERS_HEADER,
  nativeAssetId,
  priceAssetFamily,
  pricesPath,
  pricesResponse,
  swapQuoteSolana,
} from "@qntx/wallet-engine/gateway/contract";
import type { PriceFamily } from "@qntx/wallet-engine/gateway/contract";

import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import type { UpstreamCall } from "./helpers.ts";
import {
  TRON_BLOCK,
  expectContract,
  fakeFetch,
  headers,
  post,
  productionGateway,
} from "./helpers.ts";

const IP = "198.51.100.41";
const at = { "cf-connecting-ip": IP };
const TRON_MAINNET = "tron:728126428";

const asset = (network: string): string => {
  const id = nativeAssetId(network);
  if (id === undefined) {
    throw new Error(`${network} has no native asset`);
  }
  return id;
};
const ASSETS = [asset("bip122:000000000019d6689c085ae165831e93"), asset("eip155:1")];

const TAKER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const JUPITER_REQUEST =
  `${swapQuoteSolana.path}?network=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` +
  "&inputMint=So11111111111111111111111111111111111111112" +
  "&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" +
  `&amount=100000000&taker=${TAKER}&slippageBps=50`;
const JUPITER_BUILD = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  inAmount: "100000000",
  outAmount: "8944396",
  otherAmountThreshold: "8899675",
  slippageBps: 50,
  swapInstruction: {
    programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }],
    data: "CQ==",
  },
  transactionVersion: 0,
};

/** CoinGecko's `/simple` wire shape: every requested id priced in the requested currency. */
const coingeckoPrices = (call: UpstreamCall): Response => {
  const url = new URL(call.url);
  const currency = url.searchParams.get("vs_currencies") ?? "usd";
  const ids = (url.searchParams.get("ids") ?? url.searchParams.get("contract_addresses") ?? "")
    .split(",")
    .filter((id) => id !== "");
  const now = Math.floor(Date.now() / 1000);
  return Response.json(
    Object.fromEntries(
      ids.map((id) => [
        id,
        { [currency]: 3000, [`${currency}_24h_change`]: 1.5, last_updated_at: now },
      ]),
    ),
  );
};

const defillamaKeys = (call: UpstreamCall): string[] =>
  call.url.split("/").pop()?.split("?")[0]?.split(",") ?? [];

/** DefiLlama's `/prices/current` wire shape: every requested key gets a fresh quote. */
const defillamaPrices = (call: UpstreamCall): Response =>
  Response.json({
    coins: Object.fromEntries(
      defillamaKeys(call).map((key) => [
        key,
        { price: 3000, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
      ]),
    ),
  });

const upstream = fakeFetch({
  [`${COINGECKO_API}/`]: coingeckoPrices,
  [`${DEFILLAMA_API}/prices/current/`]: defillamaPrices,
  [`${DEFILLAMA_API}/percentage/`]: (call) =>
    Response.json({
      coins: Object.fromEntries(defillamaKeys(call).map((key) => [key, 1.5])),
    }),
  "https://api.trongrid.io": () => Response.json(TRON_BLOCK),
  "https://tron-mainnet.gateway.tatum.io": () => Response.json(TRON_BLOCK),
  "https://api.jup.ag": () => Response.json(JUPITER_BUILD),
});

/** One request per family scope — the route never takes a cross-family asset set. */
const requestPrices = async (currency: string): Promise<ReadonlyArray<Response>> => {
  const byFamily = new Map<PriceFamily, string[]>();
  for (const a of ASSETS) {
    const family = priceAssetFamily(a);
    if (family === undefined) {
      throw new Error(`${a} has no price family`);
    }
    byFamily.set(family, [...(byFamily.get(family) ?? []), a]);
  }
  const gateway = productionGateway({ fetch: upstream.fetch });
  return Promise.all(
    [...byFamily].map(async ([family, assets]) =>
      gateway.request(pricesPath(family), {
        ...post({ currency, assets }),
        headers: headers({ "content-type": "application/json", ...at }),
      }),
    ),
  );
};

describe("one client prefix's share of the production accounts", () => {
  it("eur prices answer 200 through coingecko", async () => {
    for (const res of await requestPrices("eur")) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- contract check in order
      await expectContract(res, pricesResponse);
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toContain("coingecko");
    }
    expect(upstream.callsTo(COINGECKO_API).length).toBeGreaterThan(0);
  });

  it("usd prices answer 200 through coingecko", async () => {
    for (const res of await requestPrices("usd")) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- contract check in order
      await expectContract(res, pricesResponse);
      expect(res.status).toBe(200);
      expect(res.headers.get(PROVIDERS_HEADER)).toContain("coingecko");
    }
    expect(upstream.callsTo(DEFILLAMA_API)).toHaveLength(0);
  });

  it("fourteen sequential getnowblock calls from one /24 all succeed", async () => {
    const app = productionGateway({ fetch: upstream.fetch });
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential share accumulation
      const res = await app.request(`/v1/tron/${TRON_MAINNET}/wallet/getnowblock`, {
        ...post({}),
        headers: headers({ "content-type": "application/json", ...at }),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toStrictEqual(Array.from({ length: 14 }, () => 200));
    expect(upstream.callsTo("https://tron-mainnet.gateway.tatum.io")).toHaveLength(0);
  });

  it("ten sequential Jupiter quotes from one /24 all succeed", async () => {
    const app = productionGateway({ fetch: upstream.fetch });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential share accumulation
      const res = await app.request(JUPITER_REQUEST, { headers: headers(at) });
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
    }
    expect(statuses).toStrictEqual(Array.from({ length: 10 }, () => 200));
  });
});
