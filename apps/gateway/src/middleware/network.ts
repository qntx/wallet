import type { MiddlewareHandler } from "hono";

import { networkById } from "@qntx/wallet-engine/gateway/contract";

import { probeCost, requestCost, tronCost } from "../budget/costs.ts";
import type { Account } from "../config/accounts.ts";
import type {
  GatewayNetwork,
  ResolvedProvider,
  UpstreamAuth,
  UpstreamAuthId,
  UpstreamRequest,
} from "../types.ts";
import { GatewayHttpError } from "./errors.ts";

export type Family = "evm" | "solana" | "bitcoin" | "tron";

export type ResolvedNetwork = Omit<GatewayNetwork, "providers"> & {
  readonly family: Family;
  readonly providers: ReadonlyArray<ResolvedProvider>;
};

export type NetworkVariables = { network: ResolvedNetwork };

/** Resolves `:caip2` to a served network of one of `families`, or 404. */
export const resolveNetwork =
  (
    served: ReadonlyMap<string, ResolvedNetwork>,
    families: ReadonlyArray<Family>,
  ): MiddlewareHandler<{ Variables: NetworkVariables }> =>
  async (c, next) => {
    const network = served.get(c.req.param("caip2") ?? "");
    if (network === undefined || !families.includes(network.family)) {
      throw new GatewayHttpError(404, "unknown-network");
    }
    c.set("network", network);
    await next();
  };

/**
 * Indexes configured networks by id and pins each to its registry family. A provider naming an
 * `auth` absent from `auth` fails construction — a keyed endpoint is never called unauthenticated —
 * and one whose account (`auth ?? id`) is absent from `accounts` fails the same way: an unmetered
 * upstream is never called either. An RPC-priced account cannot serve an Esplora or TRON provider.
 */
export function indexNetworks(
  networks: ReadonlyArray<GatewayNetwork>,
  auth: Readonly<Partial<Record<UpstreamAuthId, UpstreamAuth>>>,
  accounts: Readonly<Record<string, Account>>,
): Map<string, ResolvedNetwork> {
  const served = new Map<string, ResolvedNetwork>();
  for (const network of networks) {
    const info = networkById(network.id);
    if (info === undefined) {
      throw new Error(`network ${network.id} is not in the engine registry`);
    }
    if (network.providers.length === 0) {
      throw new Error(`network ${network.id} has no providers`);
    }
    const providers = network.providers.map((provider) => {
      const { auth: authId, ...rest } = provider;
      const accountName = authId ?? provider.id;
      const account = accounts[accountName];
      if (account === undefined) {
        throw new Error(`provider ${provider.id} on ${network.id} has no account "${accountName}"`);
      }
      const metered =
        info.family === "bitcoin"
          ? account.costs.kind === "request"
          : info.family === "tron"
            ? account.costs.kind === "request" || account.costs.kind === "tron"
            : true;
      if (!metered) {
        throw new Error(
          `provider ${provider.id} on ${network.id} has a ${account.costs.kind} cost model`,
        );
      }
      const resolved = {
        ...rest,
        account: accountName,
        costs: account.costs,
        probe: probeOf(provider.url, account, info.family),
      };
      if (authId === undefined) {
        return resolved;
      }
      const resolve = auth[authId];
      if (resolve === undefined) {
        throw new Error(
          `provider ${provider.id} on ${network.id} names unconfigured auth "${authId}"`,
        );
      }
      return { ...resolved, auth: resolve };
    });
    served.set(network.id, { id: network.id, providers, family: info.family });
  }
  return served;
}

/**
 * The cheap liveness request the forwarder sends after an attempt on this provider times out:
 * `eth_chainId` for EVM, `getHealth` for Solana, the tip height for Esplora, the head block for
 * TRON — billed to the account like any other call.
 */
const probeOf = (url: string, account: Account, family: Family): UpstreamRequest => {
  if (family === "bitcoin") {
    return { url: `${url}/blocks/tip/height`, cost: requestCost(account.costs) };
  }
  if (family === "tron") {
    return {
      url: `${url}/wallet/getnowblock`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      cost: tronCost(account.costs, "/wallet/getnowblock"),
    };
  }
  const method = family === "solana" ? "getHealth" : "eth_chainId";
  return {
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    cost: probeCost(account.costs, method),
  };
};
