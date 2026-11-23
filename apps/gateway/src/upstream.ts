/**
 * The env-derived upstream configuration both the HTTP worker (`gatewayFor`) and every `PushObject`
 * (`pushRuntimeFor`) share: which networks are served, the provider account table, the upstream
 * auth functions and the `PROVIDER_BUDGET` lease. Deriving it in one place keeps the receipt
 * verifier and the RPC route on the same providers, prices and budgets.
 */
import { durableBudget } from "./budget/leased.ts";
import { PRODUCTION_ACCOUNTS, STAGING_ACCOUNTS } from "./config/accounts.ts";
import type { Account } from "./config/accounts.ts";
import { PRODUCTION_NETWORKS, STAGING_NETWORKS } from "./config/networks.ts";
import type { WorkerEnv } from "./env.ts";
import { bearer, blockstreamAuth, header } from "./providers/auth.ts";
import type { ProviderBudget, GatewayNetwork, UpstreamAuth, UpstreamAuthId } from "./types.ts";

export type Upstream = {
  readonly networks: ReadonlyArray<GatewayNetwork>;
  readonly accounts: Readonly<Record<string, Account>>;
  readonly auth: Readonly<Partial<Record<UpstreamAuthId, UpstreamAuth>>>;
  readonly budget: ProviderBudget;
};

export const upstreamFor = (
  env: WorkerEnv,
  fetchImpl: typeof globalThis.fetch,
  log: (line: string) => void,
): Upstream => {
  const production = env.NETWORKS === "production";
  const accounts = production ? PRODUCTION_ACCOUNTS : STAGING_ACCOUNTS;
  const auth: Partial<Record<UpstreamAuthId, UpstreamAuth>> = production
    ? {
        alchemy: bearer(env.ALCHEMY_API_KEY),
        drpc: header("Drpc-Key", env.DRPC_API_KEY),
        ankr: header("x-api-key", env.ANKR_API_KEY),
        blockstream: blockstreamAuth({
          fetch: fetchImpl,
          clientId: env.BLOCKSTREAM_CLIENT_ID,
          clientSecret: env.BLOCKSTREAM_CLIENT_SECRET,
          now: () => Date.now(),
        }),
        trongrid: header("TRON-PRO-API-KEY", env.TRONGRID_API_KEY),
        tatum: header("x-api-key", env.TATUM_API_KEY),
      }
    : {};
  return {
    networks: production ? PRODUCTION_NETWORKS : STAGING_NETWORKS,
    accounts,
    auth,
    budget: durableBudget(env.PROVIDER_BUDGET, accounts, () => Date.now(), log),
  };
};
