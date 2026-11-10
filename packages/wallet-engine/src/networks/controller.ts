import { createPublicClient, fallback, http } from "viem";
import type { CcipRequestParameters, Hex, PublicClient } from "viem";

/**
 * EVM network controller: the built-in registry plus host-provided and user-added RPC endpoints.
 * Each network gets a lazily-created viem PublicClient on a `fallback` transport — endpoints are
 * tried in order (custom → host), each with the injected fetch, so a dead endpoint fails over
 * without code here. Custom RPC URLs are validated against the registry chain (EVM chain id,
 * Bitcoin/Solana genesis hash) when added and again at every unlock, and persisted in the
 * EngineStore.
 */
import { esplora } from "../chains/bitcoin.ts";
import type { Esplora, EsploraDeps } from "../chains/bitcoin.ts";
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
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import { timeoutSignal } from "../timer.ts";
import type { SetTimer } from "../timer.ts";
import { networkById } from "./registry.ts";
import type { NetworkInfo } from "./registry.ts";

/** Bound on each unlock-time endpoint probe so a dead gateway or RPC cannot stall unlocking. */
const PROBE_TIMEOUT_MS = 5000;

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
  readonly setTimer: SetTimer;
  readonly random: (length: number) => Uint8Array;
};

/**
 * One client builder for both call paths. `ccipRead` is `false` everywhere except ENS resolution:
 * viem's default CCIP-Read hits the ambient global fetch, so an `OffchainLookup` revert during an
 * ordinary `eth_call`/simulation could otherwise make the engine fetch an arbitrary URL.
 */
const makeClient = (
  info: NetworkInfo,
  urls: ReadonlyArray<string>,
  fetchFn: typeof globalThis.fetch,
  ccipRead: false | { readonly request: (parameters: CcipRequestParameters) => Promise<Hex> },
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
    ccipRead,
  });

/**
 * EIP-3668 client lookup over the injected fetch, mirroring viem's `ccipRequest` semantics: a
 * `{data}` template is a GET, anything else a POST of `{ data, sender }`; the JSON `data` field or
 * a plain-text body must be `0x` hex; a non-2xx or malformed body falls to the next URL.
 */
const isHexResponse = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);

export const ccipRequest =
  (fetchFn: typeof globalThis.fetch) =>
  async ({ data, sender, urls, requestOptions }: CcipRequestParameters): Promise<Hex> => {
    const attempt = async (template: string): Promise<Hex> => {
      const url = template.replace("{sender}", sender.toLowerCase()).replace("{data}", data);
      const isGet = template.includes("{data}");
      const res = await fetchFn(url, {
        method: isGet ? "GET" : "POST",
        ...(isGet ? {} : { headers: { "content-type": "application/json" } }),
        ...(isGet ? {} : { body: JSON.stringify({ data, sender }) }),
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      if (!res.ok) {
        throw new Error(`ccip gateway ${url} answered ${res.status}`);
      }
      const body: unknown =
        res.headers.get("content-type")?.startsWith("application/json") === true
          ? await res.json()
          : await res.text();
      const result = isObject(body) ? body["data"] : body;
      if (!isHexResponse(result)) {
        throw new Error(`ccip gateway ${url} answered a malformed response`);
      }
      return result;
    };
    let error: unknown = new Error("ccip request failed");
    for (const template of urls) {
      if (requestOptions?.signal?.aborted === true) {
        throw error;
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- gateways are tried in order
        return await attempt(template);
      } catch (error_) {
        error = error_;
      }
    }
    throw error;
  };

/** An ENS-resolution client: identical endpoints, but CCIP-Read via the injected plain fetch. */
const makeEnsClient = (
  info: NetworkInfo,
  urls: ReadonlyArray<string>,
  transportFetch: typeof globalThis.fetch,
  ccipFetch: typeof globalThis.fetch,
): PublicClient => makeClient(info, urls, transportFetch, { request: ccipRequest(ccipFetch) });

const esploraClient = (
  urls: ReadonlyArray<string>,
  fetchFn: typeof globalThis.fetch,
  deps: EsploraDeps,
): Esplora =>
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
    deps,
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
  private readonly ensClients = new Map<string, PublicClient>();
  private readonly gatewayBase: string | undefined;
  private readonly gatewayFetch: typeof globalThis.fetch;
  /** The persisted custom endpoints, verified or not — what `addRpc` writes back. */
  private storedRpc: Record<string, ReadonlyArray<string>> = {};
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
    await Promise.all([this.loadCustomRpc(this.engineStore), this.loadGatewayNetworks()]);
  }

  /**
   * Loads the persisted custom endpoints and re-verifies each against its network before use: an
   * endpoint that no longer serves the chain (or does not answer) is skipped for this session and
   * stays persisted, so a transient failure costs nothing at the next unlock.
   */
  private async loadCustomRpc(store: EngineStore): Promise<void> {
    const raw = await store.collection("networks").get("customRpc");
    const parsed = raw === undefined ? undefined : readJson(raw);
    if (raw !== undefined && !isObject(parsed)) {
      this.options.logger.warn("custom rpc endpoints skipped: malformed");
    }
    const stored: Record<string, ReadonlyArray<string>> = {};
    for (const [network, urls] of Object.entries(isObject(parsed) ? parsed : {})) {
      if (Array.isArray(urls) && urls.every((u) => typeof u === "string")) {
        stored[network] = urls;
      }
    }
    this.storedRpc = stored;
    const verified = await Promise.all(
      Object.entries(stored).map(async ([network, urls]) => {
        const info = networkById(network);
        const results =
          info === undefined
            ? []
            : await Promise.allSettled(urls.map(async (url) => this.probe(info, url)));
        const usable = urls.filter((_, i) => results[i]?.status === "fulfilled");
        for (const url of urls.filter((u) => !usable.includes(u))) {
          this.options.logger.warn(`custom endpoint not used for this session: ${network} ${url}`);
        }
        return [network, usable] as const;
      }),
    );
    this.update((s) => ({
      ...s,
      customRpc: Object.fromEntries(verified.filter(([, urls]) => urls.length > 0)),
    }));
  }

  /** Reads the gateway's served networks; any failure leaves the gateway unused until next unlock. */
  private async loadGatewayNetworks(): Promise<void> {
    if (this.gatewayBase === undefined) {
      return;
    }
    const url = `${this.gatewayBase}${networksPath}`;
    const probe = timeoutSignal(PROBE_TIMEOUT_MS, this.options.setTimer);
    try {
      const res = await this.gatewayFetch(url, {
        signal: probe.signal,
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
    } finally {
      probe.cancel();
    }
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.storedRpc = {};
    this.update((s) => ({ ...s, customRpc: {} }));
    this.gatewayServed = new Set();
    this.clients.clear();
    this.ensClients.clear();
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
    const client = makeClient(info, urls, this.gatewayFetch, false);
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
      makeClient(this.info(network), hosts, this.options.fetch, false),
    );
  }

  /**
   * The client's sibling for ENS resolution: same ordered endpoints, CCIP-Read enabled over the
   * plain injected fetch — gateway URLs come from contracts, not the host, so they never get the
   * install id.
   */
  ensClient(network: string): PublicClient {
    const cached = this.ensClients.get(network);
    if (cached !== undefined) {
      return cached;
    }
    const urls = this.endpoints(network);
    if (urls.length === 0) {
      throw new Error(`no rpc endpoint for ${network}`);
    }
    const client = makeEnsClient(this.info(network), urls, this.gatewayFetch, this.options.fetch);
    this.ensClients.set(network, client);
    return client;
  }

  /** Host-endpoint ENS client for cross-checking resolutions. */
  independentEnsClient(network: string): Independent<PublicClient> {
    return this.independent(network, (hosts) =>
      makeEnsClient(this.info(network), hosts, this.options.fetch, this.options.fetch),
    );
  }

  independentSolanaRpc(network: string): Independent<SolanaRpc> {
    return this.independent(network, (hosts) => solanaCaller(hosts, this.options.fetch));
  }

  independentEsplora(network: string): Independent<Esplora> {
    return this.independent(network, (hosts) =>
      esploraClient(hosts, this.options.fetch, {
        setTimer: this.options.setTimer,
        random: this.options.random,
      }),
    );
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
    return esploraClient(urls, this.gatewayFetch, {
      setTimer: this.options.setTimer,
      random: this.options.random,
    });
  }

  /**
   * Throws unless `url` serves `info`'s chain: the genesis hash for Bitcoin (Esplora) and Solana,
   * `eth_chainId` for EVM. Bounded like the gateway probe, so a dead endpoint cannot stall unlock.
   */
  private async probe(info: NetworkInfo, url: string): Promise<void> {
    const bound = timeoutSignal(PROBE_TIMEOUT_MS, this.options.setTimer);
    try {
      if (info.family === "bitcoin") {
        const res = await this.options.fetch(`${url.replace(/\/$/, "")}/block-height/0`, {
          signal: bound.signal,
        });
        const text = await res.text();
        const genesis = text.trim();
        if (genesis !== info.genesisHash) {
          throw new Error(`${url} reports genesis ${genesis}, expected ${info.genesisHash ?? ""}`);
        }
        return;
      }
      const method = info.family === "solana" ? "getGenesisHash" : "eth_chainId";
      const res = await this.options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: bound.signal,
      });
      const body: unknown = await res.json();
      const result = isObject(body) ? body["result"] : undefined;
      if (info.family === "solana") {
        if (result !== info.genesisHash) {
          throw new Error(
            `${url} reports genesis hash ${String(result)}, expected ${info.genesisHash ?? ""}`,
          );
        }
        return;
      }
      if (typeof result !== "string") {
        throw new TypeError(`eth_chainId returned a malformed response from ${url}`);
      }
      const chainId = Number.parseInt(result, 16);
      if (chainId !== info.chainId) {
        throw new Error(`${url} reports chain id ${chainId}, expected ${info.chainId}`);
      }
    } finally {
      bound.cancel();
    }
  }

  /** Validates a custom endpoint against the network's chain, then persists it first in the list. */
  async addRpc(network: string, url: string): Promise<void> {
    await this.probe(this.info(network), url);
    this.storedRpc = { ...this.storedRpc, [network]: [url, ...(this.storedRpc[network] ?? [])] };
    this.update((s) => ({
      ...s,
      customRpc: { ...s.customRpc, [network]: [url, ...(s.customRpc[network] ?? [])] },
    }));
    this.clients.delete(network);
    this.ensClients.delete(network);
    await this.engineStore
      ?.collection("networks")
      .put("customRpc", new TextEncoder().encode(JSON.stringify(this.storedRpc)));
  }
}
