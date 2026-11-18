import { accepts, health, networkById } from "@qntx/wallet-engine/gateway/contract";

import type { GatewayNetwork } from "../src/types.ts";

/** One smoke check: the network id and the family deciding which call to send. */
export type SmokeCheck = { readonly caip2: string; readonly family: "evm" | "solana" | "bitcoin" };

/**
 * The smoke plan for a deployment: every configured network with its registry family. A configured
 * id the registry lacks throws — the same invariant `indexNetworks` enforces, without resolving
 * provider auth (the smoke runs before auth secrets exist in its process).
 */
export function smokePlan(networks: ReadonlyArray<GatewayNetwork>): ReadonlyArray<SmokeCheck> {
  return networks.map(({ id }) => {
    const network = networkById(id);
    if (network === undefined) {
      throw new Error(`configured network ${id} is not in the registry`);
    }
    return { caip2: id, family: network.family };
  });
}

/** The deployment answers healthy only with the contract health body. */
export function healthy(body: unknown): boolean {
  return accepts(health.response, body);
}
