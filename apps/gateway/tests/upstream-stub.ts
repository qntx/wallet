/**
 * The shared upstream stub for the smoke checks: answers every provider call correctly for the
 * network its configured URL serves, so `runSmoke` passes identically against the in-process
 * gateway (tests/smoke-plan.test.ts) and the real workerd isolate (tests/workerd/entry.ts). Kept
 * free of test-framework imports — entry.ts is bundled into the worker.
 */
import { networkById } from "@qntx/wallet-engine/gateway/contract";

import { PRODUCTION_NETWORKS } from "../src/config/networks.ts";
import { COINGECKO_API } from "../src/providers/prices-coingecko.ts";
import { DEFILLAMA_API } from "../src/providers/prices-defillama.ts";

export type UpstreamStubCall = {
  readonly url: string;
  readonly body: string;
};

const rpcOk = (result: unknown): Response => Response.json({ jsonrpc: "2.0", id: 1, result });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Upstream URL → network id, looked up in the production provider table itself. */
const NETWORK_BY_PREFIX: ReadonlyArray<readonly [string, string]> = PRODUCTION_NETWORKS.flatMap(
  (network) => network.providers.map((provider) => [provider.url, network.id] as const),
);

/** CoinGecko's `/simple` wire shape: every requested id priced in the requested currency. */
const coingeckoPrices = (call: UpstreamStubCall): Response => {
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

const defillamaKeys = (call: UpstreamStubCall): string[] =>
  call.url.split("/").pop()?.split("?")[0]?.split(",") ?? [];

/** DefiLlama's `/prices/current` wire shape: every requested key gets a fresh quote. */
const defillamaPrices = (call: UpstreamStubCall): Response =>
  Response.json({
    coins: Object.fromEntries(
      defillamaKeys(call).map((key) => [
        key,
        { price: 3000, timestamp: Math.floor(Date.now() / 1000), confidence: 1 },
      ]),
    ),
  });

/** DefiLlama's `/percentage` wire shape: a 24 h change per requested key. */
const defillamaChange = (call: UpstreamStubCall): Response =>
  Response.json({
    coins: Object.fromEntries(defillamaKeys(call).map((key) => [key, 1.5])),
  });

/** Answers every upstream call correctly for the network its provider URL serves. */
export const upstreamAnswer = (call: UpstreamStubCall): Response => {
  if (call.url.startsWith(COINGECKO_API)) {
    return coingeckoPrices(call);
  }
  if (call.url.startsWith(`${DEFILLAMA_API}/percentage/`)) {
    return defillamaChange(call);
  }
  if (call.url.startsWith(DEFILLAMA_API)) {
    return defillamaPrices(call);
  }
  // RPC posts hit the provider URL itself; TRON and Esplora append a path — one provider URL
  // must not shadow another that shares its prefix (lb.drpc.live/arbitrum vs …/arbitrum-nova).
  const found = NETWORK_BY_PREFIX.find(
    ([prefix]) => call.url === prefix || call.url.startsWith(`${prefix}/`),
  );
  if (found === undefined) {
    throw new Error(`no upstream stub for ${call.url}`);
  }
  const [, id] = found;
  const info = networkById(id);
  if (info === undefined) {
    throw new Error(`configured network ${id} is not in the registry`);
  }
  if (info.family === "tron") {
    return Response.json({ chainParameter: [{ key: "getTransactionFee", value: 1 }] });
  }
  if (info.family === "bitcoin") {
    return new Response(info.genesisHash ?? "");
  }
  const parsed: unknown = call.body === "" ? {} : JSON.parse(call.body);
  const method =
    isObj(parsed) && typeof parsed["method"] === "string" ? parsed["method"] : undefined;
  if (method === "eth_chainId") {
    return rpcOk(`0x${BigInt(id.split(":")[1] ?? "0").toString(16)}`);
  }
  if (method === "getGenesisHash") {
    return rpcOk(info.genesisHash ?? "");
  }
  return rpcOk({});
};
