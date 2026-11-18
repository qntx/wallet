/**
 * R3 audit PoCs. Every test asserts the CURRENT (vulnerable) behaviour so it passes today and
 * documents the bug; the comment above each `it` states the correct behaviour.
 */
import { describe, expect, it } from "vite-plus/test";

import { prices } from "@qntx/wallet-engine/gateway/contract";

import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";
import type { GatewayNetwork, RateLimiter } from "../src/types.ts";
import {
  allowAll,
  fakeFetch,
  gateway,
  memoryPriceCache,
  post,
  recordingLimiter,
} from "./helpers.ts";
import type { UpstreamCall } from "./helpers.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ETH = "eip155:1";
const HISTORY = `/v1/history/${ETH}`;
const ALCHEMY = "https://eth.alchemy.test";

const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  { id: ETH, providers: [{ id: "alchemy", url: `${ALCHEMY}/v2` }] },
];

const ATTACKER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VICTIM = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const postAs = (clientId: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { "x-client-id": clientId, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("R3-G1: a client-chosen cursor opens the shared history breaker", () => {
  /** 2^64: Alchemy answers HTTP 400 for a `toBlock` at or above it (evidence/alchemy-cursor-probe.txt). */
  const BAD_CURSOR = "18446744073709551616";
  const UINT64 = 1n << 64n;

  const upstream = (call: UpstreamCall): Response => {
    const [first] = (JSON.parse(call.body) as { params: Array<{ toBlock?: string }> }).params;
    const toBlock = first?.toBlock ?? "";
    if (toBlock.startsWith("0x") && BigInt(toBlock) >= UINT64) {
      return new Response(
        `{"error":"Invalid block parameter: expected hex (0x...) or decimal integer, got: ${toBlock}"}`,
        { status: 400 },
      );
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: { transfers: [] } });
  };

  // Correct: bound the cursor to a range the upstream accepts (or treat its own rejection as a
  // request error, not a provider failure) so one client cannot trip the shared breaker for all.
  it("R3-G1 PoC: five poisoned cursors from client A 503 the history of client B", async () => {
    const ff = fakeFetch({ [ALCHEMY]: upstream });
    const app = gateway({ fetch: ff.fetch, networks: NETWORKS });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request(
        HISTORY,
        postAs(ATTACKER, { address: OWNER, cursor: BAD_CURSOR }),
      );
      statuses.push(res.status);
    }
    const upstreamCalls = ff.callsTo(ALCHEMY).length;
    const victim = await app.request(HISTORY, postAs(VICTIM, { address: OWNER }));
    const victimBody: unknown = await victim.json();
    console.log(
      `R3-G1 attacker statuses: ${statuses.join(",")} | victim: ${String(victim.status)} ` +
        `${JSON.stringify(victimBody)} | upstream calls after victim: ${String(ff.callsTo(ALCHEMY).length)}`,
    );
    expect(victim.status).toBe(503);
    expect(victimBody).toStrictEqual({ error: "unavailable" });
    // The victim's request never reached Alchemy: the shared breaker was already open.
    expect(ff.callsTo(ALCHEMY)).toHaveLength(upstreamCalls);
  });

  it("R3-G1 PoC control: four poisoned cursors leave the breaker closed for the victim", async () => {
    const ff = fakeFetch({ [ALCHEMY]: upstream });
    const app = gateway({ fetch: ff.fetch, networks: NETWORKS });
    for (let i = 0; i < 4; i += 1) {
      await app.request(HISTORY, postAs(ATTACKER, { address: OWNER, cursor: BAD_CURSOR }));
    }
    const victim = await app.request(HISTORY, postAs(VICTIM, { address: OWNER }));
    console.log(`R3-G1 control victim status after 4 attacker requests: ${String(victim.status)}`);
    expect(victim.status).toBe(200);
  });
});

describe("R3-G2: the history drain is charged after the upstream work ran", () => {
  const transfer = (uniqueId: string): Record<string, unknown> => ({
    blockNum: "0x1934913",
    uniqueId,
    hash: `0x${"cd".repeat(32)}`,
    from: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
    to: OWNER.toLowerCase(),
    value: 0,
    erc721TokenId: null,
    erc1155Metadata: null,
    tokenId: null,
    asset: "ETH",
    category: "external",
    rawContract: { value: "0x1", address: null, decimal: "0x12" },
    metadata: { blockTimestamp: "2026-11-18T07:54:23.000Z" },
  });

  // Correct: charge the drain's two extra calls before running it (or fold the worst case into the
  // upfront charge) — a request the limiter refuses must not have already spent upstream calls.
  it("R3-G2 PoC: a refused drain charge still ran all four upstream calls", async () => {
    // Lets every 1-unit charge through and refuses the 2-unit drain charge.
    const small: RateLimiter = {
      limit: async ({ delta = 1 }) => ({ success: delta <= 1 }),
    };
    let calls = 0;
    const upstream = (): Response => {
      calls += 1;
      // Page round: every transfer sits at one block and the page is keyed → kept is empty → drain.
      const result =
        calls <= 2
          ? { transfers: [transfer("0xpage:external")], pageKey: "k" }
          : { transfers: [transfer(`0xdrain${String(calls)}:external`)] };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    };
    const ff = fakeFetch({ [ALCHEMY]: upstream });
    const app = gateway({
      fetch: ff.fetch,
      networks: NETWORKS,
      limiters: { ip: small, rpc: small, default: small },
    });
    const res = await app.request(HISTORY, post({ address: OWNER }));
    console.log(
      `R3-G2 status: ${String(res.status)} | upstream alchemy_getAssetTransfers calls: ${String(calls)}`,
    );
    expect(res.status).toBe(429);
    // 2 page calls + 2 drain calls ran before the charge that would have refused them.
    expect(calls).toBe(4);
  });
});

describe("R3-G3: a 4-unit price batch fans out to 11 upstream calls", () => {
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const EVM_PLATFORMS = [
    "eip155:1",
    "eip155:8453",
    "eip155:42161",
    "eip155:10",
    "eip155:137",
    "eip155:56",
    "eip155:999",
    "eip155:43114",
  ];
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  /** 100 distinct asset ids spread over the 9 token platforms; `seed` freshens them. */
  const assets = (seed: number): string[] =>
    Array.from({ length: 100 }, (_v, i) => {
      if (i % 9 === 8) {
        const n = seed * 100 + i;
        return `${SOL}/token:${B58[n % 58]}${B58[Math.floor(n / 58) % 58]}${"1".repeat(30)}`;
      }
      const network = EVM_PLATFORMS[i % 9];
      return `${network}/erc20:0x${(seed * 100000 + i).toString(16).padStart(40, "0")}`;
    });

  // Correct: rate-limit cost should track the upstream calls a request fans out to (a call per
  // token platform plus the fallback), not only the count of assets in the body.
  it("R3-G3 PoC: 4 units buy 11 upstream calls, twice more on cache misses", async () => {
    const limiter = recordingLimiter();
    const ff = fakeFetch({
      [COINGECKO_API]: () => Response.json({}),
      [DEFILLAMA_API]: () => Response.json({ coins: {} }),
    });
    const app = gateway({
      fetch: ff.fetch,
      limiters: { ip: allowAll, rpc: allowAll, default: limiter },
      prices: { cache: memoryPriceCache(), coingecko: { apiKey: "cg-key" } },
    });
    const units = (): number => limiter.deltas.reduce((a, b) => a + b, 0);
    const rows: string[] = [];

    const r1 = await app.request(prices.path, post({ currency: "usd", assets: assets(0) }));
    expect(r1.status).toBe(200);
    const u1 = units();
    const c1 = ff.calls.length;
    rows.push(`req1 usd 100 unknown assets: units=${String(u1)} upstream=${String(c1)}`);
    expect(u1).toBe(4);
    // CoinGecko: 9 token_price calls (one per platform); DefiLlama: current + percentage.
    expect(c1).toBe(11);
    expect(ff.callsTo(DEFILLAMA_API)).toHaveLength(2);

    const r2 = await app.request(prices.path, post({ currency: "usd", assets: assets(1) }));
    expect(r2.status).toBe(200);
    const c2 = ff.calls.length - c1;
    rows.push(
      `req2 usd 100 fresh assets:  units=+${String(units() - u1)} upstream=+${String(c2)}`,
    );
    // The request-1 negative cache covers only its own asset ids: the fan-out repeats in full.
    expect(c2).toBe(11);

    const r3 = await app.request(prices.path, post({ currency: "eur", assets: assets(0) }));
    expect(r3.status).toBe(200);
    const c3 = ff.calls.length - c1 - c2;
    rows.push(`req3 eur same assets:      units=+${String(units() - u1 - 4)} upstream=+${String(c3)}`);
    // The cache is keyed per currency: eur misses every usd entry. DefiLlama serves usd only.
    expect(c3).toBe(9);
    expect(ff.callsTo(DEFILLAMA_API)).toHaveLength(4);
    console.log(`R3-G3\n${rows.join("\n")}`);
  });
});
