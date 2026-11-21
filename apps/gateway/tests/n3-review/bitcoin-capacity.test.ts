/**
 * One Bitcoin balance refresh is ~320 Esplora calls: 4 BITCOIN_TEMPLATES, each scanning a
 * 20-scripthash window of /txs plus /utxo on both the receive and the change chain (20 txs and 20
 * utxo per chain, 2 chains, 4 templates). Engine: assets/controller.ts maps all four
 * BITCOIN_TEMPLATES; chains/bitcoin-scan.ts scans 20 script-hash windows per chain. Against the
 * production blockstream account (10 units per 2 s) plus this IP's share (67 units per call of a
 * 1000-unit window), one refresh can never complete inside a minute: the budget refuses at call 11
 * (503) and the share window refuses at call 16 (429). Unlike `countBefore`, the real binding's
 * share counter resets each 60 s period — `windowedCountBefore` models that, so the next minute
 * admits the same ~15 calls again.
 */
import { describe, expect, it } from "vite-plus/test";

import { localBudget } from "../../src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";
import { fakeFetch, headers } from "../helpers.ts";
import { counts, productionApp, tallyAt, windowedCountBefore } from "./setup.ts";

const IP = "198.51.100.61";
const CAIP2 = "bip122:000000000019d6689c085ae165831e93";

const upstream = fakeFetch({
  "https://enterprise.blockstream.info": () =>
    new Response("1", { headers: { "content-type": "text/plain" } }),
});

const clock = { t: Date.now() };
const app = productionApp({
  fetch: upstream.fetch,
  share: windowedCountBefore(1000, 60_000, () => clock.t),
  budget: localBudget(PRODUCTION_ACCOUNTS, () => clock.t),
  now: () => clock.t,
});

const esploraGet = async (index: number) =>
  app.request(
    `/v1/esplora/${CAIP2}/scripthash/${index.toString(16).padStart(64, "0")}/${
      index % 2 === 0 ? "txs" : "utxo"
    }`,
    { headers: headers({ "cf-connecting-ip": IP }) },
  );

const callRange = async (from: number, to: number): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = from; i < to; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
    const res = await esploraGet(i);
    // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
    await res.text();
    statuses.push(res.status);
  }
  return statuses;
};

describe("esplora capacity vs one balance refresh", () => {
  it("the ~320 calls a refresh needs mostly fail inside one window", async () => {
    const statuses = await callRange(0, 320);
    const tally = counts(statuses);
    console.log(
      `window 1: statuses=${JSON.stringify(tally)} upstream=${String(upstream.calls.length)}`,
    );
    expect(tallyAt(tally, 200)).toBeLessThan(20);
  });

  it("a minute later the binding admits the same ~15 again — a refresh needs ~32 min", async () => {
    clock.t += 60_000;
    const statuses = await callRange(320, 360);
    const tally = counts(statuses);
    const succeeded = tallyAt(tally, 200);
    const admitted = statuses.length - tallyAt(tally, 429);
    console.log(
      `window 2 (+60s): statuses=${JSON.stringify(tally)} share-admitted=${String(admitted)} ` +
        `succeeded=${String(succeeded)} refresh-minutes=${String(Math.ceil(320 / succeeded))}`,
    );
    expect(admitted).toBe(15);
    expect(succeeded).toBe(10);
  });
});
