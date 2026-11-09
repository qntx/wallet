import type { MiddlewareHandler } from "hono";

import { networkById } from "@qntx/wallet-engine/gateway/contract";

import type { GatewayNetwork, ResolvedProvider, UpstreamAuth, UpstreamAuthId } from "../types.ts";
import { GatewayHttpError } from "./errors.ts";

export type Family = "evm" | "solana" | "bitcoin";

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
 * `auth` absent from `auth` fails construction — a keyed endpoint is never called unauthenticated.
 */
export function indexNetworks(
  networks: ReadonlyArray<GatewayNetwork>,
  auth: Readonly<Partial<Record<UpstreamAuthId, UpstreamAuth>>>,
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
      if (authId === undefined) {
        return rest;
      }
      const resolve = auth[authId];
      if (resolve === undefined) {
        throw new Error(
          `provider ${provider.id} on ${network.id} names unconfigured auth "${authId}"`,
        );
      }
      return { ...rest, auth: resolve };
    });
    served.set(network.id, { id: network.id, providers, family: info.family });
  }
  return served;
}
