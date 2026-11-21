/**
 * One Bitcoin balance refresh is ~320 Esplora calls (4 templates × (20 receive txs + 20 change txs
 *
 * - 20 receive utxo + 20 change utxo); engine: assets/controller.ts maps all four BITCOIN_TEMPLATES,
 *   chains/bitcoin-scan.ts scans 20 script-hash windows per chain). Against the production
 *   blockstream account ({10 units / 2 s}) plus this IP's share ({67 units per call of a 1000-unit
 *   window}), one refresh can never complete: the DO budget refuses at call 11 (503) and the share
 *   window refuses at call 16 (429). Refilling the budget does not help — the share counter is
 *   spent for the window, so the next minute admits zero more calls.
 */
import { describe, expect, it } from "vite-plus/test";

import { localBudget } from "../../src/budget/local.ts";
import { PRODUCTION_ACCOUNTS } from "../../src/config/accounts.ts";
import { fakeFetch, headers } from "../helpers.ts";
import { counts, productionApp, tallyAt } from "./setup.ts";

const IP = "198.51.100.61";
const CAIP2 = "bip122:000000000019d6689c085ae165831e93";

const upstream = fakeFetch({
  "https://enterprise.blockstream.info": () =>
    new Response("1", { headers: { "content-type": "text/plain" } }),
});

const clock = { t: Date.now() };
const app = productionApp({
  fetch: upstream.fetch,
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

describe("esplora capacity vs one balance refresh", () => {
  it("the ~320 calls a refresh needs mostly fail inside one window", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 320; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const res = await esploraGet(i);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
    }
    const tally = counts(statuses);
    console.log(
      `window 1: statuses=${JSON.stringify(tally)} upstream=${String(upstream.calls.length)}`,
    );
    expect(tallyAt(tally, 200)).toBeLessThan(20);
  });

  it("a budget window later the share is still spent — zero more calls succeed", async () => {
    clock.t += 60_000;
    const statuses: number[] = [];
    for (let i = 320; i < 360; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design
      const res = await esploraGet(i);
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      statuses.push(res.status);
    }
    const tally = counts(statuses);
    console.log(`window 2 (+60s): statuses=${JSON.stringify(tally)}`);
    expect(tallyAt(tally, 200)).toBe(0);
  });
});
