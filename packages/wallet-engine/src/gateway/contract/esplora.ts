import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

const HEX64 = "[0-9a-f]{64}";

type EsploraRoute = { readonly method: "GET" | "POST"; readonly pattern: RegExp };

/** The Esplora surface the engine uses; every other path is rejected. */
export const ESPLORA_ROUTES: ReadonlyArray<EsploraRoute> = [
  { method: "GET", pattern: /^\/block-height\/\d{1,10}$/ },
  { method: "GET", pattern: /^\/fee-estimates$/ },
  { method: "GET", pattern: new RegExp(`^/scripthash/${HEX64}/txs$`) },
  { method: "GET", pattern: new RegExp(`^/scripthash/${HEX64}/utxo$`) },
  { method: "GET", pattern: new RegExp(`^/tx/${HEX64}/hex$`) },
  { method: "GET", pattern: new RegExp(`^/tx/${HEX64}/status$`) },
  { method: "POST", pattern: /^\/tx$/ },
];

/** `path` is the Esplora path after `/v1/esplora/:caip2`, with a leading slash and no query. */
export const esploraPathAllowed = (method: string, path: string): boolean =>
  ESPLORA_ROUTES.some((route) => route.method === method && route.pattern.test(path));

export const esploraGet = endpoint("GET", "/v1/esplora/:caip2/*", z.undefined(), z.unknown());
export const esploraPost = endpoint("POST", "/v1/esplora/:caip2/tx", z.string(), z.string());
