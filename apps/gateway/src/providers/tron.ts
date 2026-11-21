import { TRON_INDEXER_LIMIT_MAX } from "@qntx/wallet-engine/gateway/contract";
import type { TronIndexerPath } from "@qntx/wallet-engine/gateway/contract";

import type { ResolvedNetwork } from "../middleware/network.ts";
import type { ResolvedProvider } from "../types.ts";

/** A validated indexer request body (`fingerprint`/`limit` are only on the page paths). */
export type TronIndexerBody = {
  readonly address: string;
  readonly fingerprint?: string | undefined;
  readonly limit?: number | undefined;
};

/**
 * The providers that serve the indexer paths — only TronGrid runs `/v1/accounts`. Plain node
 * providers answer the `/wallet` and `/walletsolidity` paths.
 */
export const tronIndexerProviders = (network: ResolvedNetwork): ReadonlyArray<ResolvedProvider> =>
  network.providers.filter((provider) => provider.id === "trongrid");

/**
 * The TronGrid GET a POSTed indexer page maps to: the address moves into the URL and
 * `only_confirmed=true` is always set — the engine never wants mempool rows here.
 */
export const tronIndexerUrl = (
  provider: ResolvedProvider,
  path: TronIndexerPath,
  body: TronIndexerBody,
): string => {
  const base = `${provider.url}/v1/accounts/${body.address}`;
  if (path === "/v1/accounts/account") {
    return base;
  }
  const query = new URLSearchParams({
    only_confirmed: "true",
    limit: String(body.limit ?? TRON_INDEXER_LIMIT_MAX),
  });
  if (body.fingerprint !== undefined) {
    query.set("fingerprint", body.fingerprint);
  }
  const suffix =
    path === "/v1/accounts/transactions/trc20" ? "/transactions/trc20" : "/transactions";
  return `${base}${suffix}?${query.toString()}`;
};
