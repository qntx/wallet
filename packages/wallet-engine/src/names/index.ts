import type { NetworkController } from "../networks/controller.ts";
import { resolveEns, lookupEns } from "./ens.ts";
import { lookupSns, resolveSns } from "./sns.ts";
import type { NameResolution } from "./types.ts";

type Networks = Pick<
  NetworkController,
  "info" | "ensClient" | "independentEnsClient" | "solanaRpc" | "independentSolanaRpc"
>;

/** Resolves a name for `network` through the name service of that network's family. */
export const resolveName = async (
  networks: Networks,
  name: string,
  network: string,
): Promise<NameResolution> => {
  const { family } = networks.info(network);
  if (family === "evm") {
    return resolveEns(networks, name, network);
  }
  if (family === "solana") {
    return resolveSns(networks, name, network);
  }
  throw new Error(`names are not supported on ${family} networks`);
};

/** Looks up the verified primary name for `address` on `network`. */
export const lookupName = async (
  networks: Networks,
  address: string,
  network: string,
): Promise<NameResolution | undefined> => {
  const { family } = networks.info(network);
  if (family === "evm") {
    return lookupEns(networks, address, network);
  }
  if (family === "solana") {
    return lookupSns(networks, address, network);
  }
  throw new Error(`names are not supported on ${family} networks`);
};

export type { NameResolution } from "./types.ts";
