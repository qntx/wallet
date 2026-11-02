import { expect } from "vite-plus/test";

import { accepts } from "@qntx/wallet-engine/gateway/contract";

import { createGateway } from "../src/app.ts";
import type { GatewayNetwork, Limiters, RateLimiter } from "../src/types.ts";

export const INSTALL_ID = "0123456789abcdef0123456789abcdef";
export const SEPOLIA = "eip155:11155111";
export const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";
export const MAINNET_BITCOIN = "bip122:000000000019d6689c085ae165831e93";
export const ORIGIN = "http://localhost:5173";

export const NETWORKS: ReadonlyArray<GatewayNetwork> = [
  [SEPOLIA, "evm"],
  [DEVNET, "sol"],
  [SIGNET, "btc"],
].map(([id = "", slug = ""]) => ({
  id,
  providers: [
    { id: "a", url: `https://a.test/${slug}` },
    { id: "b", url: `https://b.test/${slug}` },
  ],
}));

export type UpstreamCall = { readonly url: string; readonly method: string; readonly body: string };
export type Upstream = (call: UpstreamCall, signal: AbortSignal) => Response | Promise<Response>;

/** Fake `fetch`: routes by URL prefix to scripted handlers and records every call. */
export function fakeFetch(handlers: Record<string, Upstream>): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: UpstreamCall[];
  readonly callsTo: (prefix: string) => UpstreamCall[];
} {
  const calls: UpstreamCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const key = Object.keys(handlers).find((prefix) => url.startsWith(prefix));
    if (key === undefined) {
      throw new TypeError(`no fake upstream for ${url}`);
    }
    const handler = handlers[key];
    if (handler === undefined) {
      throw new TypeError("unreachable");
    }
    return handler(call, init?.signal ?? new AbortController().signal);
  };
  return { fetch, calls, callsTo: (prefix) => calls.filter((c) => c.url.startsWith(prefix)) };
}

export const rpcOk = (result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, result });

export const rpcFailure = (code: number, message: string): Response =>
  Response.json({ jsonrpc: "2.0", id: 1, error: { code, message } });

const decide = async (success: boolean): Promise<{ success: boolean }> => {
  await Promise.resolve();
  return { success };
};

export const allowAll: RateLimiter = { limit: async () => decide(true) };
export const denyAll: RateLimiter = { limit: async () => decide(false) };

export function recordingLimiter(): RateLimiter & { readonly keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return decide(true);
    },
  };
}

export function gateway(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly limiters?: Limiters;
  readonly log?: (line: string) => void;
}): ReturnType<typeof createGateway> {
  return createGateway({
    fetch: options.fetch,
    networks: NETWORKS,
    limiters: options.limiters ?? { rpc: allowAll, default: allowAll },
    corsOrigins: [ORIGIN],
    log: options.log ?? (() => undefined),
  });
}

export const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  "x-install-id": INSTALL_ID,
  ...extra,
});

export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: headers({ "content-type": "application/json" }),
  body: typeof body === "string" ? body : JSON.stringify(body),
});

export const call = (
  method: string,
  params: unknown[] = [],
  id = 1,
): { jsonrpc: "2.0"; id: number; method: string; params: unknown[] } => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

export async function expectContract(
  res: Response,
  schema: Parameters<typeof accepts>[0],
): Promise<unknown> {
  const body: unknown = await res.clone().json();
  expect(accepts(schema, body), JSON.stringify(body)).toBe(true);
  return body;
}
