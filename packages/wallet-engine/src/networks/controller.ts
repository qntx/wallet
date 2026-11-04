import { createPublicClient, fallback, http } from "viem";
import type { PublicClient } from "viem";

/**
 * EVM network controller: the built-in registry plus host-provided and user-added RPC endpoints.
 * Each network gets a lazily-created viem PublicClient on a `fallback` transport — endpoints are
 * tried in order (custom → host), each with the injected fetch, so a dead endpoint fails over
 * without code here. Custom RPC URLs are validated against the registry chain id with `eth_chainId`
 * and persisted in the EngineStore.
 */
import { esplora } from "../chains/bitcoin.ts";
import type { Esplora } from "../chains/bitcoin.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import {
  parseWith,
  esploraBasePath,
  networksPath,
  rpcPath,
  servedNetworksResponse,
} from "../gateway/contract/index.ts";
import type { EngineStore } from "../store/port.ts";
import { networkById } from "./registry.ts";
import type { NetworkInfo } from "./registry.ts";

const esploraSleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Bound on the unlock-time `/v1/networks` read so a dead gateway cannot stall unlocking. */
const GATEWAY_PROBE_TIMEOUT_MS = 5000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export type SolanaRpc = {
  readonly call: (method: string, params: unknown[]) => Promise<unknown>;
};

/**
 * A host-endpoint-only client for cross-checking pre-signing reads. `not-needed`: the gateway is
 * not this network's first endpoint, so the primary reads already come from the host.
 * `unavailable`: a cross-check is needed but the network has no host endpoint.
 */
export type Independent<T> =
  | { readonly kind: "not-needed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly client: T };

type StoreOrUndefined = EngineStore | undefined;

export type NetworkControllerState = {
  readonly customRpc: Record<string, ReadonlyArray<string>>;
};

type Options = {
  readonly fetch: typeof globalThis.fetch;
  readonly rpc: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly openStore: () => Promise<EngineStore>;
  readonly logger: EngineLogger;
  readonly gateway?: GatewayConfig | undefined;
};

const makeClient = (
  info: NetworkInfo,
  urls: ReadonlyArray<string>,
  fetchFn: typeof globalThis.fetch,
): PublicClient =>
  createPublicClient({
    chain: {
      id: info.chainId,
      name: info.name,
      nativeCurrency: { name: info.symbol, symbol: info.symbol, decimals: info.decimals },
      rpcUrls: { default: { http: [...urls] } },
    },
    transport: fallback(urls.map((url) => http(url, { fetchFn }))),
    batch: { multicall: true },
  });

const esploraClient = (urls: ReadonlyArray<string>, fetchFn: typeof globalThis.fetch): Esplora =>
  esplora(
    urls,
    async (url, init) => {
      const r = await fetchFn(url, init);
      return {
        ok: r.ok,
        status: r.status,
        headers: { get: (h: string) => r.headers.get(h) ?? undefined },
        json: async () => r.json(),
        text: async () => r.text(),
      };
    },
    esploraSleep,
  );

const solanaCaller = (
  urls: ReadonlyArray<string>,
  fetchFn: typeof globalThis.fetch,
): SolanaRpc => ({
  call: async (method, params) => {
    const attempt = async (rest: ReadonlyArray<string>, last: unknown): Promise<unknown> => {
      const [url, ...next] = rest;
      if (url === undefined) {
        throw last instanceof Error ? last : new Error(typeof last === "string" ? last : method);
      }
      try {
        const res = await fetchFn(url, {
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
});

export class NetworkController extends Controller<NetworkControllerState> {
  private readonly options: Options;
  private engineStore?: StoreOrUndefined;
  private readonly clients = new Map<string, PublicClient>();
  private readonly gatewayBase: string | undefined;
  private readonly gatewayFetch: typeof globalThis.fetch;
  /** Networks the gateway reported at unlock; empty while locked or when the read failed. */
  private gatewayServed: ReadonlySet<string> = new Set();

  constructor(options: Options) {
    super({ name: "networks", defaultState: () => ({ customRpc: {} }) });
    this.options = options;
    if (options.gateway !== undefined) {
      this.gatewayBase = options.gateway.url.replace(/\/+$/, "");
    }
    this.gatewayFetch = gatewayFetch(options.fetch, options.gateway);
  }

  async init(): Promise<void> {
    this.engineStore = await this.options.openStore();
    await this.loadCustomRpc(this.engineStore);
    await this.loadGatewayNetworks();
  }

  private async loadCustomRpc(store: EngineStore): Promise<void> {
    const raw = await store.collection("networks").get("customRpc");
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

  /** Reads the gateway's served networks; any failure leaves the gateway unused until next unlock. */
  private async loadGatewayNetworks(): Promise<void> {
    if (this.gatewayBase === undefined) {
      return;
    }
    const url = `${this.gatewayBase}${networksPath}`;
    try {
      const res = await this.gatewayFetch(url, {
        signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const body: unknown = await res.json();
      const served = parseWith(servedNetworksResponse, body);
      if (served === undefined) {
        throw new Error("malformed response");
      }
      this.gatewayServed = new Set(served.networks);
    } catch {
      this.gatewayServed = new Set();
      this.options.logger.warn(`gateway unavailable, not used for this session: ${url}`);
    }
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.gatewayServed = new Set();
    this.clients.clear();
    this.engineStore = undefined;
  }

  /**
   * Ordered endpoints: a network with custom endpoints uses custom → host and never the gateway;
   * otherwise a gateway-served network uses gateway → host; else host only.
   */
  endpoints(network: string): ReadonlyArray<string> {
    const custom = this.getState().customRpc[network] ?? [];
    const host = this.options.rpc[network] ?? [];
    if (custom.length > 0) {
      return [...custom, ...host];
    }
    if (this.gatewayBase !== undefined && this.gatewayServed.has(network)) {
      const path =
        networkById(network)?.family === "bitcoin" ? esploraBasePath(network) : rpcPath(network);
      return [`${this.gatewayBase}${path}`, ...host];
    }
    return host;
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
    const client = makeClient(info, urls, this.gatewayFetch);
    this.clients.set(network, client);
    return client;
  }

  /** True when the gateway heads this network's endpoint list (no custom endpoints, gateway-served). */
  private gatewayFirst(network: string): boolean {
    return (
      (this.getState().customRpc[network] ?? []).length === 0 &&
      this.gatewayBase !== undefined &&
      this.gatewayServed.has(network)
    );
  }

  private independent<T>(
    network: string,
    make: (hosts: ReadonlyArray<string>) => T,
  ): Independent<T> {
    if (!this.gatewayFirst(network)) {
      return { kind: "not-needed" };
    }
    const hosts = this.options.rpc[network] ?? [];
    return hosts.length === 0
      ? { kind: "unavailable" }
      : { kind: "available", client: make(hosts) };
  }

  /** Host-endpoint EVM client for cross-checking reads; never sends the install id. */
  independentClient(network: string): Independent<PublicClient> {
    return this.independent(network, (hosts) =>
      makeClient(this.info(network), hosts, this.options.fetch),
    );
  }

  independentSolanaRpc(network: string): Independent<SolanaRpc> {
    return this.independent(network, (hosts) => solanaCaller(hosts, this.options.fetch));
  }

  independentEsplora(network: string): Independent<Esplora> {
    return this.independent(network, (hosts) => esploraClient(hosts, this.options.fetch));
  }

  /** Networks with at least one configured endpoint or served by the gateway, by family. */
  enabled(family: "evm" | "solana" | "bitcoin"): ReadonlyArray<string> {
    const ids = new Set([
      ...Object.keys(this.options.rpc),
      ...Object.keys(this.getState().customRpc),
      ...this.gatewayServed,
    ]);
    return [...ids].filter((id) => {
      const info = networkById(id);
      return info !== undefined && info.family === family;
    });
  }

  /** Solana JSON-RPC over the ordered endpoint list — kit's transport is single-endpoint. */
  solanaRpc(network: string): SolanaRpc {
    const urls = this.endpoints(network);
    if (urls.length === 0) {
      throw new Error(`no rpc endpoint for ${network}`);
    }
    return solanaCaller(urls, this.gatewayFetch);
  }

  /** Bounded-concurrency + 429-aware ordered-failover Esplora client. */
  esplora(network: string): Esplora {
    const urls = this.endpoints(network);
    if (urls.length === 0) {
      throw new Error(`no esplora endpoint for ${network}`);
    }
    return esploraClient(urls, this.gatewayFetch);
  }

  /** Validate a custom endpoint's reported chain id, then persist it first in the list. */
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
