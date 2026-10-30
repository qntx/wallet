/**
 * EVM network controller: the built-in registry plus host-provided and user-added RPC endpoints.
 * Each network gets a lazily-created viem PublicClient on a `fallback` transport — endpoints are
 * tried in order (custom → host), each with the injected fetch, so a dead endpoint fails over
 * without code here. Custom RPC URLs are validated against the registry chain id with `eth_chainId`
 * and persisted in the EngineStore.
 */
import { createPublicClient, fallback, http } from "viem";
import type { PublicClient } from "viem";

import type { Esplora } from "../chains/bitcoin.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import { networkById } from "./registry.ts";
import type { NetworkInfo } from "./registry.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export type SolanaRpc = {
  readonly call: (method: string, params: unknown[]) => Promise<unknown>;
};

type StoreOrUndefined = EngineStore | undefined;

export type NetworkControllerState = {
  readonly customRpc: Record<string, ReadonlyArray<string>>;
};

type Options = {
  readonly fetch: typeof globalThis.fetch;
  readonly rpc: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly openStore: () => Promise<EngineStore>;
  readonly logger: EngineLogger;
};

export class NetworkController extends Controller<NetworkControllerState> {
  private readonly options: Options;
  private engineStore?: StoreOrUndefined;
  private readonly clients = new Map<string, PublicClient>();

  constructor(options: Options) {
    super({ name: "networks", defaultState: () => ({ customRpc: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    const raw = await this.engineStore.collection("networks").get("customRpc");
    if (raw === undefined) {
      return;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (typeof parsed === "object" && parsed !== null) {
      const map: Record<string, ReadonlyArray<string>> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.every((u) => typeof u === "string")) {
          map[k] = v;
        }
      }
      this.update((s) => ({ ...s, customRpc: map }));
    }
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.clients.clear();
    this.engineStore = undefined;
  }

  endpoints(network: string): ReadonlyArray<string> {
    return [...(this.getState().customRpc[network] ?? []), ...(this.options.rpc[network] ?? [])];
  }

  info(network: string): NetworkInfo {
    const info = networkById(network);
    if (info === undefined) {
      throw new Error(`unknown network ${network}`);
    }
    return info;
  }

  client(network: string): PublicClient {
    const info = this.info(network);
    const cached = this.clients.get(network);
    if (cached !== undefined) {
      return cached;
    }
    const urls = this.endpoints(network);
    if (urls.length === 0) {
      throw new Error(`no rpc endpoint for ${network}`);
    }
    const client = createPublicClient({
      chain: {
        id: info.chainId,
        name: info.name,
        nativeCurrency: { name: info.symbol, symbol: info.symbol, decimals: info.decimals },
        rpcUrls: { default: { http: urls } },
      },
      transport: fallback(urls.map((url) => http(url, { fetchFn: this.options.fetch }))),
      batch: { multicall: true },
    });
    this.clients.set(network, client);
    return client;
  }

  /** Validate a custom endpoint's reported chain id, then persist it first in the list. */
  /** Solana JSON-RPC over the ordered endpoint list — kit's transport is single-endpoint. */
  solanaRpc(network: string): SolanaRpc {
    const urls = this.endpoints(network);
    if (urls.length === 0) {
      throw new Error(`no rpc endpoint for ${network}`);
    }
    return {
      call: async (method, params) => {
        const attempt = async (rest: ReadonlyArray<string>, last: unknown): Promise<unknown> => {
          const [url, ...next] = rest;
          if (url === undefined) {
            throw last instanceof Error
              ? last
              : new Error(typeof last === "string" ? last : method);
          }
          try {
            const res = await this.options.fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            const body: unknown = await res.json();
            if (!isObject(body)) {
              return await attempt(next, new Error(`malformed response from ${url}`));
            }
            if (body["error"] !== undefined) {
              const msg = isObject(body["error"]) ? body["error"]["message"] : undefined;
              return await attempt(next, new Error(typeof msg === "string" ? msg : method));
            }
            return body["result"];
          } catch (error) {
            return attempt(next, error);
          }
        };
        return attempt(urls, undefined);
      },
    };
  }

  /** Ordered-failover Esplora client over the host + validated custom endpoints. */
  esplora(network: string): Esplora {
    const urls = this.endpoints(network);
    if (urls.length === 0) {
      throw new Error(`no esplora endpoint for ${network}`);
    }
    const attempt = async (
      rest: ReadonlyArray<string>,
      path: string,
      init: { method: string; body?: string } | undefined,
      last: unknown,
    ): Promise<unknown> => {
      const [url, ...next] = rest;
      if (url === undefined) {
        throw last instanceof Error ? last : new Error(`all esplora endpoints failed: ${path}`);
      }
      try {
        const res = await this.options.fetch(`${url.replace(/\/$/, "")}${path}`, {
          method: init?.method ?? "GET",
          ...(init?.body === undefined
            ? {}
            : { headers: { "content-type": "text/plain" }, body: init.body }),
        });
        if (!res.ok) {
          return attempt(next, path, init, new Error(`esplora ${url} ${res.status}`));
        }
        const text = await res.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      } catch (error) {
        return await attempt(next, path, init, error);
      }
    };
    return {
      get: async (path: string) => attempt(urls, path, undefined, undefined),
      post: async (path: string, body: string) =>
        attempt(urls, path, { method: "POST", body }, undefined),
    };
  }

  async addRpc(network: string, url: string): Promise<void> {
    const info = this.info(network);
    if (info.family === "bitcoin") {
      const res = await this.options.fetch(`${url.replace(/\/$/, "")}/block-height/0`);
      const genesisText = await res.text();
      const genesis = genesisText.trim();
      if (genesis !== info.genesisHash) {
        throw new Error(`${url} reports genesis ${genesis}, expected ${info.genesisHash ?? ""}`);
      }
    } else if (info.family === "solana") {
      const res = await this.options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
      });
      const body: unknown = await res.json();
      const genesis = isObject(body) ? body["result"] : undefined;
      if (genesis !== info.genesisHash) {
        throw new Error(
          `${url} reports genesis hash ${String(genesis)}, expected ${info.genesisHash ?? ""}`,
        );
      }
      const current = this.getState().customRpc[network] ?? [];
      const customRpc = { ...this.getState().customRpc, [network]: [url, ...current] };
      this.update((s) => ({ ...s, customRpc }));
      const store = this.engineStore;
      if (store !== undefined) {
        await store
          .collection("networks")
          .put("customRpc", new TextEncoder().encode(JSON.stringify(customRpc)));
      }
      return;
    }
    const res = await this.options.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body: unknown = await res.json();
    const result =
      typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
    if (typeof result !== "string") {
      throw new TypeError(`eth_chainId returned a malformed response from ${url}`);
    }
    const chainId = Number.parseInt(result, 16);
    if (chainId !== info.chainId) {
      throw new Error(`${url} reports chain id ${chainId}, expected ${info.chainId}`);
    }
    const current = this.getState().customRpc[network] ?? [];
    const customRpc = { ...this.getState().customRpc, [network]: [url, ...current] };
    this.update((s) => ({ ...s, customRpc }));
    this.clients.delete(network);
    const store = this.engineStore;
    if (store !== undefined) {
      await store
        .collection("networks")
        .put("customRpc", new TextEncoder().encode(JSON.stringify(customRpc)));
    }
  }
}
