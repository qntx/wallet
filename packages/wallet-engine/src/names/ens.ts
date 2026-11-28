/**
 * ENS forward and reverse resolution: names resolve on the L1 that matches the send — mainnet names
 * on `eip155:1`, testnet names on Sepolia. Decisive reads are cross-checked against the independent
 * endpoint when one exists; a disagreement is refused, a failed second read is flagged
 * `reads-unverified`.
 */
import { ens_normalize } from "@adraffy/ens-normalize";
import type { Address, PublicClient } from "viem";
import { getAddress as checksumAddress } from "viem";
import { getEnsAddress, getEnsName, toCoinType } from "viem/ens";

import type { NetworkController } from "../networks/controller.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { assessName } from "../requests/risk.ts";
import { NameDisagreementError } from "./types.ts";
import type { NameResolution } from "./types.ts";

/** The ENS Universal Resolver on both supported resolution networks. */
export const UNIVERSAL_RESOLVER = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";

/** ENSIP-19's default EVM coin type, consulted when the chain-specific record is empty. */
const EVM_DEFAULT_COIN_TYPE = 0x80000000n;

export type EnsDeps = {
  readonly getEnsAddress?: typeof getEnsAddress;
  readonly getEnsName?: typeof getEnsName;
};

type Networks = Pick<NetworkController, "info" | "ensClient" | "independentEnsClient">;

const normalizedEns = (name: string): string => {
  let normalized: string;
  try {
    normalized = ens_normalize(name);
  } catch {
    throw new Error(`"${name}" is not a valid ENS name`);
  }
  if (!normalized.includes(".")) {
    throw new Error(`"${name}" is not an ENS name`);
  }
  return normalized;
};

const resolutionChainId = (testnet: boolean): number => (testnet ? 11155111 : 1);

/** The chain-specific ENSIP-11 coin type, or coin type 60 on the resolution chain itself. */
const ensCoinType = (chainId: number, testnet: boolean): bigint =>
  chainId === resolutionChainId(testnet) ? 60n : toCoinType(chainId);

/**
 * `addr` records in order: the chain's coin type, then the ENSIP-19 EVM default — viem forwards
 * `addr(node, coinType)` to the resolver and has no client-side fallback.
 */
const ensAddress = async (
  getAddress: typeof getEnsAddress,
  client: PublicClient,
  name: string,
  coinType: bigint,
): Promise<Address | undefined> => {
  for (const candidate of [coinType, EVM_DEFAULT_COIN_TYPE]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the default record is the documented fallback order
    const address = await getAddress(client, {
      name,
      coinType: candidate,
      universalResolverAddress: UNIVERSAL_RESOLVER,
    });
    if (address !== null) {
      return address;
    }
  }
  return undefined;
};

const ensNetwork = (
  info: ReturnType<Networks["info"]>,
): { readonly resolutionNetwork: string; readonly coinType: bigint } => {
  if (info.family !== "evm") {
    throw new Error("ENS names can only resolve for EVM networks");
  }
  const chainId = resolutionChainId(info.testnet);
  return {
    resolutionNetwork: `eip155:${chainId}`,
    coinType: ensCoinType(info.chainId, info.testnet),
  };
};

/** Forward-resolves `name` for a send on `network`; throws when it cannot be resolved safely. */
export const resolveEns = async (
  networks: Networks,
  name: string,
  network: string,
  deps: EnsDeps = {},
): Promise<NameResolution> => {
  const getAddress = deps.getEnsAddress ?? getEnsAddress;
  const normalized = normalizedEns(name);
  const info = networks.info(network);
  const { resolutionNetwork, coinType } = ensNetwork(info);
  const address = await ensAddress(
    getAddress,
    networks.ensClient(resolutionNetwork),
    normalized,
    coinType,
  );
  if (address === undefined) {
    throw new Error(`ENS name "${normalized}" does not resolve`);
  }
  const checks: RequestCheckCode[] = [];
  const independent = networks.independentEnsClient(resolutionNetwork);
  if (independent.kind === "available") {
    let other: Address | undefined;
    try {
      other = await ensAddress(getAddress, independent.client, normalized, coinType);
    } catch {
      checks.push("reads-unverified");
      return { name: normalized, address, checks, risk: assessName(normalized) };
    }
    if (other === undefined || other.toLowerCase() !== address.toLowerCase()) {
      throw new NameDisagreementError(
        `ENS name "${normalized}" resolves differently across endpoints`,
      );
    }
  } else if (independent.kind === "unavailable") {
    checks.push("reads-unverified");
  }
  return { name: normalized, address, checks, risk: assessName(normalized) };
};

const addChecks = (into: RequestCheckCode[], extra: ReadonlyArray<RequestCheckCode>): void => {
  for (const check of extra) {
    if (!into.includes(check)) {
      into.push(check);
    }
  }
};

/**
 * The verified primary name for `address` on `network`, or `undefined` when no name survives both
 * endpoint agreement and the independent forward-resolution check.
 */
export const lookupEns = async (
  networks: Networks,
  address: string,
  network: string,
  deps: EnsDeps = {},
): Promise<NameResolution | undefined> => {
  const getName = deps.getEnsName ?? getEnsName;
  const input = checksumAddress(address);
  const info = networks.info(network);
  const { resolutionNetwork, coinType } = ensNetwork(info);
  const primary = await getName(networks.ensClient(resolutionNetwork), {
    address: input,
    coinType,
    universalResolverAddress: UNIVERSAL_RESOLVER,
  });
  const checks: RequestCheckCode[] = [];
  const independent = networks.independentEnsClient(resolutionNetwork);
  if (independent.kind === "available") {
    let other: Awaited<ReturnType<typeof getEnsName>>;
    try {
      other = await getName(independent.client, {
        address: input,
        coinType,
        universalResolverAddress: UNIVERSAL_RESOLVER,
      });
    } catch {
      checks.push("reads-unverified");
      other = primary;
    }
    if (other !== primary) {
      throw new NameDisagreementError(`ENS primary name for ${input} differs across endpoints`);
    }
  } else if (independent.kind === "unavailable") {
    checks.push("reads-unverified");
  }
  if (primary === null) {
    return undefined;
  }
  let normalized: string;
  try {
    normalized = ens_normalize(primary);
  } catch {
    return undefined;
  }
  if (normalized !== primary) {
    return undefined;
  }
  let forward: NameResolution;
  try {
    forward = await resolveEns(networks, primary, network, deps);
  } catch (error) {
    if (error instanceof NameDisagreementError) {
      throw error;
    }
    return undefined;
  }
  if (forward.address.toLowerCase() !== input.toLowerCase()) {
    return undefined;
  }
  addChecks(checks, forward.checks);
  return { name: primary, address: input, checks, risk: assessName(primary) };
};
