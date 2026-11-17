import {
  CLIENT_ID_HEADER,
  bridgeQuote,
  esploraGet,
  networkById,
  rpc,
  swapQuote,
  swapQuoteSolana,
} from "./contract/index.ts";

/** A gateway traffic class with its own client id: one per chain family plus the service routes. */
export type GatewayScope = "evm" | "solana" | "bitcoin" | "service";

export type GatewayConfig = {
  readonly url: string;
  readonly clientIds: Readonly<Record<GatewayScope, string>>;
};

/** The route prefix of a path template — the part before the first `:` parameter. */
const routePrefix = (template: string): string => template.split("/:")[0] ?? template;
const RPC_PREFIX = `${routePrefix(rpc.path)}/`;
const ESPLORA_PREFIX = `${routePrefix(esploraGet.path)}/`;

/** The scope a gateway URL belongs to — which client id its requests carry. */
export function gatewayScope(url: URL): GatewayScope {
  const { pathname } = url;
  if (pathname.startsWith(RPC_PREFIX)) {
    return networkById(pathname.slice(RPC_PREFIX.length))?.family ?? "service";
  }
  if (pathname.startsWith(ESPLORA_PREFIX)) {
    return "bitcoin";
  }
  if (pathname === swapQuoteSolana.path) {
    return "solana";
  }
  if (pathname === swapQuote.path || pathname === bridgeQuote.path) {
    return "evm";
  }
  return "service";
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A fresh client id per scope for one engine session — unlinkable across scopes and sessions. */
export function gatewaySession(url: string, random: (length: number) => Uint8Array): GatewayConfig {
  return {
    url,
    clientIds: {
      evm: hex(random(16)),
      solana: hex(random(16)),
      bitcoin: hex(random(16)),
      service: hex(random(16)),
    },
  };
}

/** `fetch` that adds the scope's client id to requests bound for the gateway's origin only. */
export function gatewayFetch(
  fetch: typeof globalThis.fetch,
  gateway: GatewayConfig | undefined,
): typeof globalThis.fetch {
  const origin = gateway === undefined ? undefined : new URL(gateway.url).origin;
  return async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target);
    if (gateway === undefined || url.origin !== origin) {
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set(CLIENT_ID_HEADER, gateway.clientIds[gatewayScope(url)]);
    return fetch(input, { ...init, headers });
  };
}
