/* oxlint-disable no-await-in-loop, typescript/no-unsafe-type-assertion --
   smoke checks run sequentially and upstream bodies are parsed loosely */
import {
  accepts,
  health,
  nativeAssetId,
  networkById,
  priceAssetFamily,
  pricesPath,
  pricesResponse,
} from "@qntx/wallet-engine/gateway/contract";
import type { PriceFamily } from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "../src/config/networks.ts";
import type { GatewayNetwork } from "../src/types.ts";

/** One smoke check: the network id and the family deciding which call to send. */
export type SmokeCheck = {
  readonly caip2: string;
  readonly family: "evm" | "solana" | "bitcoin" | "tron";
};

/**
 * The smoke plan for a deployment: every configured network with its registry family. A configured
 * id the registry lacks throws — the same invariant `indexNetworks` enforces, without resolving
 * provider auth (the smoke runs before auth secrets exist in its process).
 */
export function smokePlan(networks: ReadonlyArray<GatewayNetwork>): ReadonlyArray<SmokeCheck> {
  return networks.map(({ id }) => {
    const network = networkById(id);
    if (network === undefined) {
      throw new Error(`configured network ${id} is not in the registry`);
    }
    return { caip2: id, family: network.family };
  });
}

/** The deployment answers healthy only with the contract health body. */
export function healthy(body: unknown): boolean {
  return accepts(health.response, body);
}

export type SmokeOptions = {
  /** Where the checks send their requests — `globalThis.fetch` for the CLI, in-process for tests. */
  readonly fetch: typeof globalThis.fetch;
  readonly baseUrl: string;
  readonly env: "staging" | "production";
};

export type SmokeResult = {
  /** Names of the checks that passed, in run order. */
  readonly passed: string[];
  /** `name: reason` per failed check, in run order. */
  readonly failures: string[];
};

/**
 * Post-deploy smoke: health, the served network list, the price paths, then one real call per
 * family per configured network. Pure I/O — the CLI prints the result, tests assert `failures` is
 * empty, so the same checks run against a live deployment and an in-process gateway.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const clientId = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const plan = smokePlan(options.env === "production" ? PRODUCTION_NETWORKS : STAGING_NETWORKS);
  const passed: string[] = [];
  const failures: string[] = [];
  const check = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      passed.push(name);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    }
  };

  const get = async (path: string): Promise<Response> =>
    options.fetch(`${options.baseUrl}${path}`, { headers: { "x-client-id": clientId } });
  const post = async (path: string, body: unknown): Promise<Response> =>
    options.fetch(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: { "x-client-id": clientId, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  await check("health", async () => {
    const res = await get(health.path);
    const body: unknown = await res.json();
    if (!healthy(body)) {
      throw new Error("unexpected health body");
    }
  });
  await check("networks", async () => {
    const res = await get("/v1/networks");
    const body = (await res.json()) as { networks?: string[] };
    const expected = plan.map(({ caip2 }) => caip2);
    const got = body.networks ?? [];
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(`served ${got.join(",")} != configured ${expected.join(",")}`);
    }
  });
  /* Prices are mainnet-only and independent of the served networks: both environments price the
     same assets. Each currency proves a different provider path — USD reaches the keyless fallback
     even without a CoinGecko key, EUR needs CoinGecko itself. */
  const priceAssets = new Map<PriceFamily, string[]>();
  for (const network of ["bip122:000000000019d6689c085ae165831e93", "eip155:1"]) {
    const id = nativeAssetId(network);
    const family = id === undefined ? undefined : priceAssetFamily(id);
    if (id === undefined || family === undefined) {
      throw new Error(`${network} has no price asset or family`);
    }
    priceAssets.set(family, [...(priceAssets.get(family) ?? []), id]);
  }
  for (const currency of options.env === "production" ? ["usd", "eur"] : ["usd"]) {
    for (const [family, assets] of priceAssets) {
      await check(`prices ${currency}/${family}`, async () => {
        const r = await post(pricesPath(family), { currency, assets });
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
    } else if (family === "tron") {
      await check(`${caip2} getchainparameters`, async () => {
        const r = await post(`/v1/tron/${caip2}/wallet/getchainparameters`, {});
        const body = (await r.json()) as { chainParameter?: ReadonlyArray<unknown> };
        if (
          r.status !== 200 ||
          !Array.isArray(body.chainParameter) ||
          body.chainParameter.length === 0
        ) {
          throw new Error(`status ${r.status}`);
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
  return { passed, failures };
}
