import {
  PROGRAM_IDS,
  SOLANA_NATIVE_ASSET,
  associatedTokenAddress,
} from "@qntx/wallet-chains/solana";

import type { NetworkController } from "../networks/controller.ts";
import { mergeRisk } from "../requests/risk.ts";
import type { PreparedRequest } from "../transactions/route.ts";
import { resolveName } from "./index.ts";

type Networks = Pick<
  NetworkController,
  "info" | "ensClient" | "independentEnsClient" | "solanaRpc" | "independentSolanaRpc"
>;

type Flow = PreparedRequest["intent"]["outflows"][number];

const associatedToken = (owner: string, mint: string, program: string): string | undefined => {
  try {
    return associatedTokenAddress(owner, mint, program);
  } catch {
    return undefined;
  }
};

/** True when a decoded outflow pays the resolved owner — directly, or through its SPL ATA. */
const paysResolved = (flow: Flow, family: string, address: string): boolean => {
  if (family === "evm") {
    return flow.to.toLowerCase() === address.toLowerCase();
  }
  if (family !== "solana") {
    return false;
  }
  if (flow.to === address) {
    return true;
  }
  if (flow.amount.asset === SOLANA_NATIVE_ASSET) {
    return false;
  }
  return [PROGRAM_IDS.token, PROGRAM_IDS.token2022].some(
    (program) => associatedToken(address, flow.amount.asset, program) === flow.to,
  );
};

/**
 * Resolves a typed recipient name around one route build. The route always sees the address; this
 * wrapper carries the name into matching display outflows, merges the resolution's checks and
 * findings, and re-resolves before signing so a changed or failing answer is stale.
 */
export const withNamedRecipient = async (
  networks: Networks,
  network: string,
  to: string,
  build: (address: string) => Promise<PreparedRequest>,
): Promise<PreparedRequest> => {
  if (!to.includes(".")) {
    return build(to);
  }
  const resolved = await resolveName(networks, to, network);
  const prepared = await build(resolved.address);
  const { family } = networks.info(network);
  const risk = mergeRisk(prepared.risk ?? [], resolved.risk);
  return {
    ...prepared,
    intent: {
      ...prepared.intent,
      outflows: prepared.intent.outflows.map((flow) =>
        paysResolved(flow, family, resolved.address) ? { ...flow, name: resolved.name } : flow,
      ),
    },
    checks: [...new Set([...resolved.checks, ...prepared.checks])],
    ...(risk.length === 0 ? {} : { risk }),
    staleReason: async () => {
      let again;
      try {
        again = await resolveName(networks, to, network);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `${resolved.name} no longer resolves safely (${message}) — start over`;
      }
      const differs =
        family === "evm"
          ? again.address.toLowerCase() !== resolved.address.toLowerCase()
          : again.address !== resolved.address;
      if (differs) {
        return `${resolved.name} now resolves to ${again.address}, not ${resolved.address} — start over`;
      }
      return prepared.staleReason();
    },
  };
};
