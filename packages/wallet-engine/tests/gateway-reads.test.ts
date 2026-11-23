import { afterEach, describe, expect, it } from "vite-plus/test";

import { gatewayFetch, gatewayScope, gatewaySession } from "../src/gateway/client.ts";
import {
  CLIENT_ID_HEADER,
  accepts,
  approvalsPath,
  bridgeQuote,
  clientId,
  esploraBasePath,
  esploraPathAllowed,
  evmRpcRequest,
  health,
  historyPath,
  networkById,
  networksPath,
  nftCollectionPath,
  nftFloorPath,
  nftItemPath,
  nftItemsPath,
  phishingListPath,
  pricesPath,
  rpcPath,
  solanaRpcRequest,
  swapQuote,
  swapQuoteSolana,
  tokenListPath,
} from "../src/gateway/contract/index.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { Independent } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { idleNetworkDeps } from "./send-helpers.ts";

const GATEWAY = "https://gw.test";
const HOST = "https://host.test";
const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const SEPOLIA = "eip155:11155111";
const BASE_SEPOLIA = "eip155:84532";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";

const HOST_RPC = {
  [SEPOLIA]: [`${HOST}/evm`],
  [BASE_SEPOLIA]: [`${HOST}/base`],
  [DEVNET]: [`${HOST}/sol`],
  [SIGNET]: [`${HOST}/btc`],
};

type Call = { readonly url: string; readonly method: string; readonly headers: Headers };

type Behavior = {
  /** Body of `GET /v1/networks`, or a Response to return instead. */
  networks?: () => Response | Promise<Response>;
  /** Answer for gateway rpc and esplora requests; defaults to a canned success. */
  upstream?: (url: string) => Response;
};

const violations: string[] = [];

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) {
    throw new Error(`gateway contract violations:\n${found.join("\n")}`);
  }
});

const rpcResult = (result: unknown): Response => Response.json({ jsonrpc: "2.0", id: 1, result });

/** Fake gateway + host: every request reaching the gateway is checked against the contract. */
function world(behavior: Behavior = {}) {
  const gatewayCalls: Call[] = [];
  const hostCalls: Call[] = [];

  const checkGateway = (url: URL, call: Call, body: string): void => {
    const id = call.headers.get(CLIENT_ID_HEADER);
    if (id === null || !accepts(clientId, id)) {
      violations.push(`${url.pathname}: missing or malformed ${CLIENT_ID_HEADER}`);
    }
    if (url.pathname === networksPath) {
      if (call.method !== "GET") {
        violations.push(`${networksPath}: ${call.method}`);
      }
      return;
    }
    const rpcMatch = /^\/v1\/rpc\/([^/]+)$/.exec(url.pathname);
    if (rpcMatch !== null) {
      const network = networkById(rpcMatch[1] ?? "");
      const schema = network?.family === "solana" ? solanaRpcRequest : evmRpcRequest;
      if (call.method !== "POST" || network === undefined || network.family === "bitcoin") {
        violations.push(`${url.pathname}: bad rpc request`);
      } else if (!accepts(schema, JSON.parse(body))) {
        violations.push(`${url.pathname}: body violates the ${network.family} allow-list: ${body}`);
      }
      return;
    }
    const esploraMatch = /^\/v1\/esplora\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (esploraMatch !== null) {
      if (!esploraPathAllowed(call.method, esploraMatch[2] ?? "")) {
        violations.push(`${url.pathname}: esplora path not allowed`);
      }
      return;
    }
    violations.push(`${url.pathname}: not a gateway route`);
  };

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const call: Call = {
      url: url.href,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.origin === GATEWAY) {
      gatewayCalls.push(call);
      checkGateway(url, call, body);
      if (url.pathname === networksPath) {
        return behavior.networks?.() ?? Response.json({ networks: [SEPOLIA, DEVNET, SIGNET] });
      }
      return behavior.upstream?.(url.pathname) ?? defaultAnswer(url, body);
    }
    hostCalls.push(call);
    if (call.headers.has(CLIENT_ID_HEADER)) {
      violations.push(`${url.href}: client id leaked to a non-gateway origin`);
    }
    return defaultAnswer(url, body, "host");
  };

  return { fetch: fetchImpl, gatewayCalls, hostCalls };
}

function defaultAnswer(url: URL, body: string, via: "gateway" | "host" = "gateway"): Response {
  if (url.pathname.includes("/esplora/") || url.pathname.startsWith("/btc")) {
    return new Response(via === "gateway" ? "from-gateway" : "from-host");
  }
  const method = body === "" ? "" : (JSON.parse(body) as { method: string }).method;
  if (method === "eth_chainId") {
    return rpcResult("0xaa36a7");
  }
  if (method === "eth_getBalance") {
    return rpcResult("0x2a");
  }
  return rpcResult(via === "gateway" ? "from-gateway" : "from-host");
}

const available = <T>(independent: Independent<T>): T => {
  if (independent.kind !== "available") {
    throw new Error(`expected an available independent client, got ${independent.kind}`);
  }
  return independent.client;
};

const openStore = async () => Promise.resolve(createMemoryEngineStore());

function controller(
  w: { fetch: typeof globalThis.fetch },
  options: { rpc?: Record<string, string[]>; gatewayUrl?: string } = {},
) {
  const warnings: string[] = [];
  const n = new NetworkController({
    ...idleNetworkDeps,
    fetch: w.fetch,
    rpc: options.rpc ?? HOST_RPC,
    openStore,
    logger: { warn: (message) => warnings.push(message) },
    gateway: gatewaySession(options.gatewayUrl ?? GATEWAY, random),
  });
  return { n, warnings };
}

describe("engine reads through the gateway", () => {
  it("serves a gateway-served EVM network from the gateway first, with the client id", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    expect(n.endpoints(SEPOLIA)).toStrictEqual([`${GATEWAY}${rpcPath(SEPOLIA)}`, `${HOST}/evm`]);

    await expect(n.client(SEPOLIA).getChainId()).resolves.toBe(11155111);
    await expect(
      n.client(SEPOLIA).getBalance({ address: `0x${"11".repeat(20)}` }),
    ).resolves.toBeTypeOf("bigint");

    const rpcCalls = w.gatewayCalls.filter((c) => c.url.includes("/v1/rpc/"));
    expect(rpcCalls.length).toBeGreaterThan(0);
    expect(rpcCalls.every((c) => c.url === `${GATEWAY}${rpcPath(SEPOLIA)}`)).toBe(true);
    expect(w.hostCalls).toHaveLength(0);
  });

  it("falls back to the host endpoint when the gateway answers 503", async () => {
    const w = world({ upstream: () => new Response("", { status: 503 }) });
    const { n } = controller(w);
    await n.init();
    await expect(n.client(SEPOLIA).getChainId()).resolves.toBe(11155111);
    expect(w.gatewayCalls.some((c) => c.url.includes("/v1/rpc/"))).toBe(true);
    expect(w.hostCalls.map((c) => c.url)).toStrictEqual([`${HOST}/evm`]);
  });

  it("never touches the gateway for a network it does not serve", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    expect(n.endpoints(BASE_SEPOLIA)).toStrictEqual([`${HOST}/base`]);
    await expect(n.client(BASE_SEPOLIA).getChainId()).resolves.toBe(11155111);
    expect(w.gatewayCalls.map((c) => new URL(c.url).pathname)).toStrictEqual([networksPath]);
    expect(w.hostCalls).toHaveLength(1);
  });

  it("bypasses the gateway entirely once a custom endpoint is added", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    await n.addRpc(SEPOLIA, "https://custom.test/rpc");
    expect(n.endpoints(SEPOLIA)).toStrictEqual(["https://custom.test/rpc", `${HOST}/evm`]);
    const before = w.gatewayCalls.length;
    await expect(n.client(SEPOLIA).getChainId()).resolves.toBe(11155111);
    expect(w.gatewayCalls).toHaveLength(before);
    expect(w.hostCalls.map((c) => c.url)).toStrictEqual([
      "https://custom.test/rpc",
      "https://custom.test/rpc",
    ]);
    expect(w.hostCalls.every((c) => !c.headers.has(CLIENT_ID_HEADER))).toBe(true);
  });

  it.each([
    ["a 503", () => new Response("", { status: 503 })],
    ["a malformed body", () => Response.json({ networks: ["not a caip2"] })],
    ["a non-JSON body", () => new Response("<html>")],
    ["a network error", async () => Promise.reject(new TypeError("offline"))],
  ])(
    "does not use the gateway when /v1/networks gives %s, and logs it",
    async (_name, networks) => {
      const w = world({ networks });
      const { n, warnings } = controller(w);
      await n.init();
      expect(n.endpoints(SEPOLIA)).toStrictEqual([`${HOST}/evm`]);
      expect(n.enabled("evm")).toStrictEqual([SEPOLIA, BASE_SEPOLIA]);
      await n.client(SEPOLIA).getChainId();
      expect(w.gatewayCalls.map((c) => new URL(c.url).pathname)).toStrictEqual([networksPath]);
      expect(warnings).toStrictEqual([
        `gateway unavailable, not used for this session: ${GATEWAY}${networksPath}`,
      ]);
    },
  );

  it("sends a distinct client id per gateway scope, stable within the session", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    expect(n.endpoints(DEVNET)).toStrictEqual([`${GATEWAY}${rpcPath(DEVNET)}`, `${HOST}/sol`]);
    expect(n.endpoints(SIGNET)).toStrictEqual([
      `${GATEWAY}${esploraBasePath(SIGNET)}`,
      `${HOST}/btc`,
    ]);

    // Two calls per scope: each scope keeps one id for the whole session.
    await expect(n.client(SEPOLIA).getChainId()).resolves.toBe(11155111);
    await expect(
      n.client(SEPOLIA).getBalance({ address: `0x${"11".repeat(20)}` }),
    ).resolves.toBeTypeOf("bigint");
    await expect(n.solanaRpc(DEVNET).call("getSlot", [])).resolves.toBe("from-gateway");
    await expect(n.solanaRpc(DEVNET).call("getEpochInfo", [])).resolves.toBe("from-gateway");
    await expect(n.esplora(SIGNET).get("/block-height/0")).resolves.toBeDefined();
    await expect(n.esplora(SIGNET).get("/block-height/1")).resolves.toBeDefined();

    const idsOf = (calls: Call[], match: RegExp): string[] =>
      [
        ...new Set(
          calls
            .filter((c) => match.test(new URL(c.url).pathname))
            .map((c) => c.headers.get(CLIENT_ID_HEADER)),
        ),
      ].filter((id): id is string => id !== null);
    const scopes = {
      service: idsOf(w.gatewayCalls, /^\/v1\/networks$/),
      evm: idsOf(w.gatewayCalls, /^\/v1\/rpc\/eip155/),
      solana: idsOf(w.gatewayCalls, /^\/v1\/rpc\/solana/),
      bitcoin: idsOf(w.gatewayCalls, /^\/v1\/esplora\//),
    };
    for (const [scope, ids] of Object.entries(scopes)) {
      expect(ids, `${scope} must carry exactly one stable client id`).toHaveLength(1);
    }
    expect(new Set(Object.values(scopes).flat()).size).toBe(4);
    expect(w.hostCalls).toHaveLength(0);

    // A second session draws fresh ids for every scope.
    const w2 = world();
    const again = controller(w2);
    await again.n.init();
    await again.n.client(SEPOLIA).getChainId();
    const evm2 = idsOf(w2.gatewayCalls, /^\/v1\/rpc\/eip155/);
    expect(evm2).toHaveLength(1);
    expect(evm2[0]).not.toBe(scopes.evm[0]);
  });

  it("does not send the client id to host endpoints", async () => {
    const w = world({ upstream: () => new Response("", { status: 503 }) });
    const { n } = controller(w);
    await n.init();
    await n.solanaRpc(DEVNET).call("getSlot", []);
    await n.esplora(SIGNET).get("/block-height/0");
    expect(w.hostCalls).toHaveLength(2);
    expect(w.hostCalls.every((c) => !c.headers.has(CLIENT_ID_HEADER))).toBe(true);
  });

  it("re-reads /v1/networks on every unlock and forgets it on lock", async () => {
    let served = [SEPOLIA];
    const w = world({ networks: () => Response.json({ networks: served }) });
    const { n } = controller(w);
    await n.init();
    expect(n.endpoints(SEPOLIA)[0]).toBe(`${GATEWAY}${rpcPath(SEPOLIA)}`);

    n.lock();
    expect(n.endpoints(SEPOLIA)).toStrictEqual([`${HOST}/evm`]);

    served = [DEVNET];
    await n.init();
    expect(n.endpoints(SEPOLIA)).toStrictEqual([`${HOST}/evm`]);
    expect(n.endpoints(DEVNET)[0]).toBe(`${GATEWAY}${rpcPath(DEVNET)}`);
    expect(w.gatewayCalls.filter((c) => new URL(c.url).pathname === networksPath)).toHaveLength(2);
  });

  it("counts gateway-served networks as enabled, even without host endpoints", async () => {
    const w = world();
    const { n } = controller(w, { rpc: {} });
    await n.init();
    expect(n.enabled("evm")).toStrictEqual([SEPOLIA]);
    expect(n.enabled("solana")).toStrictEqual([DEVNET]);
    expect(n.enabled("bitcoin")).toStrictEqual([SIGNET]);
    n.lock();
    expect(n.enabled("evm")).toStrictEqual([]);
  });

  it("tolerates a trailing slash on the gateway url", async () => {
    const w = world();
    const { n } = controller(w, { gatewayUrl: `${GATEWAY}/` });
    await n.init();
    expect(n.endpoints(SEPOLIA)[0]).toBe(`${GATEWAY}${rpcPath(SEPOLIA)}`);
  });

  it("behaves exactly as before when no gateway is configured", async () => {
    const w = world();
    const n = new NetworkController({
      ...idleNetworkDeps,
      fetch: w.fetch,
      rpc: HOST_RPC,
      openStore,
      logger: { warn: () => undefined },
    });
    await n.init();
    expect(n.endpoints(SEPOLIA)).toStrictEqual([`${HOST}/evm`]);
    expect(w.gatewayCalls).toHaveLength(0);
  });
});

describe("independent clients", () => {
  it("are not needed when the gateway is not the first endpoint", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    expect(n.independentClient(BASE_SEPOLIA)).toStrictEqual({ kind: "not-needed" });
    n.lock();
    expect(n.independentSolanaRpc(DEVNET)).toStrictEqual({ kind: "not-needed" });
    await n.init();
    expect(controller(w).n.independentEsplora(SIGNET)).toStrictEqual({ kind: "not-needed" });
  });

  it("a custom endpoint never disables the cross-check", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    await n.addRpc(SEPOLIA, "https://custom.test/rpc");
    // Host endpoints configured: they corroborate the custom endpoint's reads.
    const independent = n.independentClient(SEPOLIA);
    expect(independent).toMatchObject({ kind: "available", source: "host" });
    await available(independent).getChainId();
    expect(w.hostCalls.at(-1)?.url).toBe(`${HOST}/evm`);
    // A custom endpoint on a network without host endpoints corroborates on the gateway.
    const { n: hostless } = controller(w, { rpc: {} });
    await hostless.init();
    await hostless.addRpc(SEPOLIA, "https://custom.test/rpc");
    const viaGateway = hostless.independentClient(SEPOLIA);
    expect(viaGateway).toMatchObject({ kind: "available", source: "gateway" });
  });

  it("are unavailable when a gateway-served network has no host endpoint", async () => {
    const w = world();
    const { n } = controller(w, { rpc: {} });
    await n.init();
    expect(n.independentClient(SEPOLIA)).toStrictEqual({ kind: "unavailable" });
    expect(n.independentSolanaRpc(DEVNET)).toStrictEqual({ kind: "unavailable" });
    expect(n.independentEsplora(SIGNET)).toStrictEqual({ kind: "unavailable" });
  });

  it("read only from host endpoints and never send the client id", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    const evm = n.independentClient(SEPOLIA);
    const sol = n.independentSolanaRpc(DEVNET);
    const btc = n.independentEsplora(SIGNET);
    await available(evm).getChainId();
    await available(sol).call("getSlot", []);
    await available(btc).get("/block-height/0");
    const afterInit = w.gatewayCalls.filter((c) => new URL(c.url).pathname !== networksPath);
    expect(afterInit).toHaveLength(0);
    expect(w.hostCalls.map((c) => c.url)).toStrictEqual([
      `${HOST}/evm`,
      `${HOST}/sol`,
      `${HOST}/btc/block-height/0`,
    ]);
    expect(w.hostCalls.every((c) => !c.headers.has(CLIENT_ID_HEADER))).toBe(true);
  });

  it("are not needed after lock, when the gateway list is forgotten", async () => {
    const w = world();
    const { n } = controller(w);
    await n.init();
    n.lock();
    expect(n.independentClient(SEPOLIA)).toStrictEqual({ kind: "not-needed" });
  });
});

describe("gatewayScope", () => {
  const scope = (path: string) => gatewayScope(new URL(`${GATEWAY}${path}`));

  it.each<[string, string]>([
    [rpcPath(SEPOLIA), "evm"],
    [rpcPath(DEVNET), "solana"],
    [rpcPath(SIGNET), "bitcoin"],
    ["/v1/rpc/nope:0", "service"],
    [historyPath(SEPOLIA), "evm"],
    ["/v1/history/nope:0", "service"],
    [approvalsPath(SEPOLIA), "evm"],
    ["/v1/approvals/nope:0", "service"],
    [tokenListPath(SEPOLIA), "evm"],
    [tokenListPath(DEVNET), "solana"],
    [tokenListPath(SIGNET), "bitcoin"],
    ["/v1/tokens/nope:0", "service"],
    [pricesPath("evm"), "evm"],
    [pricesPath("solana"), "solana"],
    [pricesPath("bitcoin"), "bitcoin"],
    [pricesPath("tron"), "tron"],
    ["/v1/prices/nope", "service"],
    [nftItemsPath(SEPOLIA), "evm"],
    [nftItemsPath(DEVNET), "solana"],
    [nftItemPath(SEPOLIA), "evm"],
    [nftCollectionPath(DEVNET), "solana"],
    [nftFloorPath(SEPOLIA), "evm"],
    ["/v1/nfts/items/nope:0", "service"],
    [`${esploraBasePath(SIGNET)}/block-height/0`, "bitcoin"],
    [`${esploraBasePath(SIGNET)}/tx`, "bitcoin"],
    [swapQuoteSolana.path, "solana"],
    [swapQuote.path, "evm"],
    [bridgeQuote.path, "evm"],
    [networksPath, "service"],
    [phishingListPath, "service"],
    [health.path, "service"],
    ["/v1/unknown", "service"],
  ])("maps %s to %s", (path, expected) => {
    expect(scope(path)).toBe(expected);
  });

  it("scopes ids per family under a gateway mounted on a base path", async () => {
    const gateway = gatewaySession(`${GATEWAY}/base/`, random);
    const seen = new Map<string, string | null>();
    const wrapped = gatewayFetch(async (input, init) => {
      const path = new URL(String(input)).pathname;
      seen.set(path, new Headers(init?.headers).get(CLIENT_ID_HEADER));
      return Promise.resolve(new Response("{}"));
    }, gateway);
    const paths = [
      `/base${rpcPath(SEPOLIA)}`,
      `/base${rpcPath(DEVNET)}`,
      `/base${esploraBasePath(SIGNET)}/block-height/0`,
      `/base${pricesPath("tron")}`,
      `/base${networksPath}`,
    ];
    await Promise.all(paths.map(async (path) => wrapped(`${GATEWAY}${path}`)));
    const ids = [...seen.values()];
    expect(new Set(ids).size).toBe(5);
    expect(seen.get(`/base${rpcPath(SEPOLIA)}`)).toBe(gateway.clientIds.evm);
    expect(seen.get(`/base${rpcPath(DEVNET)}`)).toBe(gateway.clientIds.solana);
    expect(seen.get(`/base${esploraBasePath(SIGNET)}/block-height/0`)).toBe(
      gateway.clientIds.bitcoin,
    );
    expect(seen.get(`/base${pricesPath("tron")}`)).toBe(gateway.clientIds.tron);
    expect(seen.get(`/base${networksPath}`)).toBe(gateway.clientIds.service);
  });
});
