/**
 * Per-IP share metering on the production accounts: a TronGrid getnowblock request costs the
 * account's 5 % share 360 of 1000 units, so count-before semantics admit exactly three requests per
 * minute, the fourth is the request's own 429 (Retry-After 60) — and because a refused share charge
 * aborts the request rather than failing over, Tatum is never tried. A Jupiter quote costs 417
 * units: three requests, then 429.
 */
import { describe, expect, it } from "vite-plus/test";

import { swapQuoteSolana } from "@qntx/wallet-engine/gateway/contract";

import { countBefore, fakeFetch, headers, post } from "../helpers.ts";
import { TRON_BLOCK, dash, orZero, productionApp } from "./setup.ts";

const IP = "198.51.100.51";
const at = { "cf-connecting-ip": IP };

const TAKER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
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

const upstream = fakeFetch({
  "https://api.trongrid.io": () => Response.json(TRON_BLOCK),
  "https://tron-mainnet.gateway.tatum.io": () => Response.json(TRON_BLOCK),
  "https://api.jup.ag": () => Response.json(JUPITER_BUILD),
});

const share = countBefore(1000);
const app = productionApp({ fetch: upstream.fetch, share });

const tronBlock = async () =>
  app.request("/v1/tron/tron:728126428/wallet/getnowblock", {
    ...post("{}"),
    headers: headers({ "content-type": "application/json", ...at }),
  });

const jupiter = async () =>
  app.request(
    `${swapQuoteSolana.path}?network=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` +
      "&inputMint=So11111111111111111111111111111111111111112" +
      "&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" +
      `&amount=100000000&taker=${TAKER}&slippageBps=50`,
    { headers: headers(at) },
  );

describe("one IP's share of TRON providers", () => {
  it("three getnowblock calls succeed, the fourth is 429 retry-after 60, Tatum never tried", async () => {
    const seq: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential share accumulation
      const res = await tronBlock();
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      seq.push(res.status);
      retryAfter = res.headers.get("retry-after");
    }
    const trongrid = upstream.callsTo("https://api.trongrid.io").length;
    const tatum = upstream.callsTo("https://tron-mainnet.gateway.tatum.io").length;
    console.log(
      `tron statuses=${seq.join(",")} retry-after=${dash(retryAfter)} ` +
        `trongrid-calls=${String(trongrid)} tatum-calls=${String(tatum)}`,
    );
    expect(seq).toStrictEqual([200, 200, 200, 429]);
    expect(retryAfter).toBe("60");
    expect(tatum).toBe(0);
  });

  it("three Jupiter quotes succeed, the fourth is 429", async () => {
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential share accumulation
      const res = await jupiter();
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be consumed
      await res.text();
      seq.push(res.status);
    }
    const jupKeys = share.counts.get("jupiter:198.51.100.0/24");
    console.log(
      `jupiter statuses=${seq.join(",")} jupiter-share-count=${String(orZero(jupKeys))} ` +
        `jupiter-calls=${String(upstream.callsTo("https://api.jup.ag").length)}`,
    );
    expect(seq).toStrictEqual([200, 200, 200, 429]);
  });
});
