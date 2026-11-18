/* oxlint-disable no-await-in-loop, unicorn/no-process-exit, unicorn/no-await-expression-member, typescript/no-unsafe-type-assertion --
   a script: sequential checks, process exit is the result channel, upstream bodies are parsed loosely */
/**
 * Post-deploy smoke: health, the served network list, one real call per family per network. `bun
 * scripts/smoke.ts <baseUrl> <staging|production>` — exits non-zero listing every failure.
 */
import {
  accepts,
  health,
  nativeAssetId,
  prices,
  pricesResponse,
} from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import { healthy, smokePlan } from "./smoke-plan.ts";

declare const process: { readonly argv: ReadonlyArray<string>; exit: (code: number) => never };

const [baseUrl, env] = process.argv.slice(2);
if (baseUrl === undefined || (env !== "staging" && env !== "production")) {
  console.error("usage: bun scripts/smoke.ts <baseUrl> <staging|production>");
  process.exit(2);
}
const clientId = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const plan = smokePlan(env === "production" ? PRODUCTION_NETWORKS : STAGING_NETWORKS);
const failures: string[] = [];
const check = async (name: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
    console.log(`pass ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    console.log(`FAIL ${name}`);
  }
};

const get = async (path: string): Promise<Response> =>
  fetch(`${baseUrl}${path}`, { headers: { "x-client-id": clientId } });
const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "x-client-id": clientId, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

await check("health", async () => {
  const body: unknown = await (await get(health.path)).json();
  if (!healthy(body)) {
    throw new Error("unexpected health body");
  }
});
await check("networks", async () => {
  const body = (await (await get("/v1/networks")).json()) as { networks?: string[] };
  const expected = plan.map(({ caip2 }) => caip2);
  const got = body.networks ?? [];
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`served ${got.join(",")} != configured ${expected.join(",")}`);
  }
});
/* Prices are mainnet-only and independent of the served networks: both environments price the
   same assets. Each currency proves a different provider path — USD reaches the keyless fallback
   even without a CoinGecko key, EUR needs CoinGecko itself. */
const priceAssets = ["bip122:000000000019d6689c085ae165831e93", "eip155:1"].map((network) => {
  const id = nativeAssetId(network);
  if (id === undefined) {
    throw new Error(`${network} has no price asset`);
  }
  return id;
});
for (const currency of env === "production" ? ["usd", "eur"] : ["usd"]) {
  await check(`prices ${currency}`, async () => {
    const r = await post(prices.path, { currency, assets: priceAssets });
    const body: unknown = await r.json();
    if (!accepts(pricesResponse, body)) {
      throw new Error(`status ${r.status}: ${JSON.stringify(body).slice(0, 120)}`);
    }
    const { missing } = body as { missing: string[] };
    if (missing.length > 0) {
      throw new Error(
        `unpriced ${missing.join(",")} via ${String(r.headers.get("x-gateway-providers"))}`,
      );
    }
  });
}
for (const { caip2, family } of plan) {
  if (family === "evm") {
    await check(`${caip2} eth_chainId`, async () => {
      const r = await post(`/v1/rpc/${caip2}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      });
      const body = (await r.json()) as { result?: string; error?: { message: string } };
      if (body.result === undefined) {
        throw new Error(`rpc error: ${body.error?.message ?? String(r.status)}`);
      }
      if (BigInt(body.result) !== BigInt(caip2.split(":")[1] ?? "")) {
        throw new Error(`chain id ${body.result} != ${caip2}`);
      }
    });
    await check(`${caip2} eth_simulateV1`, async () => {
      const r = await post(`/v1/rpc/${caip2}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_simulateV1",
        params: [{ blockStateCalls: [{ calls: [] }] }, "latest"],
      });
      const body = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (body.result === undefined) {
        throw new Error(`rpc error: ${body.error?.message ?? String(r.status)}`);
      }
    });
  } else if (family === "solana") {
    await check(`${caip2} getGenesisHash`, async () => {
      const r = await post(`/v1/rpc/${caip2}`, {
        jsonrpc: "2.0",
        id: 1,
        method: "getGenesisHash",
        params: [],
      });
      const body = (await r.json()) as { result?: string; error?: { message: string } };
      if (body.result === undefined || !body.result.startsWith(caip2.split(":")[1] ?? "")) {
        throw new Error(`genesis ${body.result ?? body.error?.message ?? r.status}`);
      }
    });
  } else {
    await check(`${caip2} block-height/0`, async () => {
      const r = await get(`/v1/esplora/${caip2}/block-height/0`);
      const text = await r.text();
      if (r.status !== 200 || !text.trim().startsWith(caip2.split(":")[1] ?? "")) {
        throw new Error(`height ${r.status} ${text.slice(0, 80)}`);
      }
    });
  }
}
if (failures.length > 0) {
  console.error(`smoke: ${failures.length} failure(s)\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("smoke: all checks passed");
