import type { Address, PublicClient } from "viem";
/**
 * ENS forward resolution: names resolve on the L1 that matches the send — mainnet names on
 * `eip155:1`, testnet names on Sepolia. The primary resolution is cross-checked against the
 * host-endpoint client when one exists; a disagreement is refused, a failed second read is flagged
 * `reads-unverified` — the same rule as every other cross-check.
 */
import { getEnsAddress, normalize, toCoinType } from "viem/ens";

import type { NetworkController } from "../networks/controller.ts";
import type { RequestCheckCode } from "../requests/checks.ts";

/** The ENS Universal Resolver on both supported resolution networks. */
export const UNIVERSAL_RESOLVER = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";

/** ENSIP-19's default EVM coin type, consulted when the chain-specific record is empty. */
const EVM_DEFAULT_COIN_TYPE = 0x80000000n;

export type EnsResolution = {
  readonly name: string;
  readonly address: string;
  readonly checks: ReadonlyArray<RequestCheckCode>;
};

type GetEnsAddress = typeof getEnsAddress;

/**
 * `addr` records in order: the chain's ENSIP-11 coin type, then the ENSIP-19 EVM default — viem
 * forwards `addr(node, coinType)` to the resolver and has no client-side fallback.
 */
const ensAddress = async (
  getAddress: GetEnsAddress,
  client: PublicClient,
  name: string,
  chainId: number,
): Promise<Address | undefined> => {
  for (const coinType of [toCoinType(chainId), EVM_DEFAULT_COIN_TYPE]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the default record is the documented fallback order
    const address = await getAddress(client, {
      name,
      coinType,
      universalResolverAddress: UNIVERSAL_RESOLVER,
    });
    if (address !== null) {
      return address;
    }
  }
  return undefined;
};

/** Forward-resolves `name` for a send on `network`; throws when it cannot be resolved safely. */
export const resolveEns = async (
  networks: Pick<NetworkController, "info" | "ensClient" | "independentEnsClient">,
  name: string,
  network: string,
  getAddress: GetEnsAddress = getEnsAddress,
): Promise<EnsResolution> => {
  let normalized: string;
  try {
    normalized = normalize(name);
  } catch {
    throw new Error(`"${name}" is not a valid ENS name`);
  }
  if (!normalized.includes(".")) {
    throw new Error(`"${name}" is not an ENS name`);
  }
  const info = networks.info(network);
  const resolutionNetwork = info.testnet ? "eip155:11155111" : "eip155:1";
  const address = await ensAddress(
    getAddress,
    networks.ensClient(resolutionNetwork),
    normalized,
    info.chainId,
  );
  if (address === undefined) {
    throw new Error(`ENS name "${normalized}" does not resolve`);
  }
  const checks: RequestCheckCode[] = [];
  const independent = networks.independentEnsClient(resolutionNetwork);
  if (independent.kind === "available") {
    let other: Address | undefined;
    try {
      other = await ensAddress(getAddress, independent.client, normalized, info.chainId);
    } catch {
      checks.push("reads-unverified");
      return { name: normalized, address, checks };
    }
    if (other === undefined || other.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`ENS name "${normalized}" resolves differently across endpoints`);
    }
  } else if (independent.kind === "unavailable") {
    checks.push("reads-unverified");
  }
  return { name: normalized, address, checks };
};
