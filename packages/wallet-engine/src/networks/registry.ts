/**
 * Built-in EVM network registry: the chain table lives in @qntx/wallet-chains/networks; this module
 * layers the engine-only fields the signing paths need on top of it (Multicall3, fee model,
 * EIP-7702 delegator code hash). Signing-time chainId always comes from the table, never from an
 * RPC endpoint. TRON networks in the chain table are not served by the engine yet.
 */
import { BUILT_IN_NETWORKS } from "@qntx/wallet-chains/networks";
import type { NetworkMeta } from "@qntx/wallet-chains/networks";

/** What a transaction is charged beyond `gasUsed × effectiveGasPrice`. */
export type FeeModel =
  /** Nothing: the chain folds any L1 cost into gas (L1s, Arbitrum Orbit, zk rollups). */
  | { readonly kind: "execution" }
  /** OP Stack: an L1 data fee and an operator fee, read from the GasPriceOracle predeploy. */
  | { readonly kind: "op-stack" };

/** The chain families this registry serves. */
export type EngineFamily = "evm" | "solana" | "bitcoin";

export type NetworkInfo = Omit<NetworkMeta, "family"> & {
  readonly family: EngineFamily;
  readonly multicall3?: string;
  /** How the chain prices costs beyond execution gas; every EVM entry sets it. */
  readonly feeModel?: FeeModel;
  /** Keccak256 of the delegator's runtime code on this chain; absent = EIP-7702 unsupported. */
  readonly delegatorCodeHash?: string;
};

/**
 * Keccak256 of the EIP7702StatelessDeleGator v1.3.0 runtime code per chain (keccak256 of
 * eth_getCode at the delegator, cross-checked on two endpoints; existing entries 2026-11-08,
 * additions 2026-11-20). Differs per chain because OpenZeppelin's EIP712 stores the chain id and
 * the domain separator as immutables. A chain is listed only when the delegator is deployed AND a
 * mined type-0x4 transaction proved EIP-7702 active: HyperEVM (999/998) has no deployment;
 * Avalanche C-Chain (43114/43113) has not activated 7702; Arc, Cronos, MegaETH, Sonic, ZKsync Era,
 * Katana, Unichain, Berachain and Sei deploy the delegator but no mined 7702 transaction was found,
 * so they are absent; all new testnets are absent.
 */
export const DELEGATOR_CODE_HASHES: Readonly<Record<number, string>> = {
  1: "0x0b77e469f5603ed1e9ff0e7ee56238b61a8cf7cb3185b33e53e2eeaad50109ab",
  8453: "0x6af675ac126c441bec5d5013da3331a52e7465fc0d5a662a8708a9f33ce497ba",
  42161: "0xa6603bc6f9f203be551ce8fcfe13b7802e3b6574828780b4c4fe05d1768d17de",
  10: "0x076ce337739f2c16aff0d81341b32ec5826a0050060e54b1346f36c79d89b246",
  137: "0x0a0b90e8b2bb4701283c0b44939f18a5292af9ab58e0f1f4a3413fdbdbebcc35",
  56: "0x2f40923fc79da9330c663341d8a52823ea02372b7da66175a0a9bfc76270d55f",
  4663: "0xa06befcb6f1d7b6c566a607d9d5d932f9b267f3470e55940225c6ee9c4c5e6b0",
  143: "0xd4dee59ae6be4a997964e8f19ae6905f0a233c6ae88d9bc5d945bc60738376c1",
  9745: "0x2820c9685f7aa35fc73a608a61521cdf13e00a18056e6e1f11488033116ce663",
  5000: "0x9f1838d0a0eb4ea73ba7e18ca7eb30f35505b7640f3a750b8a061670b23e07ac",
  100: "0x21dbc654c220eb4b54b591b4364d800d91b64e56f98fc0a8512d99ed25c3f571",
  59144: "0xeef4fc75d341d7b9b0ae6748cb847a4e6558f34e0d9f441b636c39e82b9a6082",
  42220: "0xd9124662db6b65020c6bb256fd849a5713ef91e864db0b8454ecf715ac15cd20",
  11155111: "0x9270f73d98e7ed6978677bf0550038289efd510e67e700d024502d62510fc1e4",
  84532: "0x83805f9ac7395294043b10c3b7c1839b7e4582a3e693028c36df84978b09d4e2",
  421614: "0x7f8a570cc9ebfd8d4dd86c7cc482bb30e9c669cc281352b131c94291747a58c8",
  11155420: "0x9d71e8749e123ade3310cbab813a837f7b2ffff8608aeddb0619a78f64a95663",
  80002: "0xddc1c1b0583d57f3937d04c7bdacfaecb699d8aa27ee00040ab2c7b656ed239b",
  97: "0x27d0d3e53805ac152f306986e91511b7c6c6804cba0dbe0e1420d19905e682e6",
};

// Canonical Multicall3 — https://github.com/mds1/multicall3 deployments (most entries below).
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// The ZKsync stack deploys Multicall3 elsewhere — mds1/multicall3 deployments.json.
const MULTICALL3_ZKSYNC = "0xF9cda624FBC7e059355ce98a31693d299FACd963";

/** Engine facts per built-in EVM chain, keyed by chainId: Multicall3 address and fee model. */
export const EVM_FACTS: Readonly<
  Record<number, { readonly multicall3: string; readonly feeModel: FeeModel }>
> = {
  1: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  8453: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  42161: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  10: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  137: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  56: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  999: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  43114: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  4663: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  143: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  5042: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  9745: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  196: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  1672: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  5000: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  25: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  100: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  988: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  747474: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  80094: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  480: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  130: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  1329: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  59144: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  42220: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  146: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  324: { multicall3: MULTICALL3_ZKSYNC, feeModel: { kind: "execution" } },
  1868: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  4326: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  8217: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  33139: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  11155111: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  84532: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  421614: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  11155420: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  80002: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  97: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  998: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  43113: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  46630: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  10143: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  5042002: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  1952: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  5003: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  10200: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  1301: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  1328: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  59141: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  11142220: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  14601: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
  300: { multicall3: MULTICALL3_ZKSYNC, feeModel: { kind: "execution" } },
  1946: { multicall3: MULTICALL3, feeModel: { kind: "op-stack" } },
  33111: { multicall3: MULTICALL3, feeModel: { kind: "execution" } },
};

export const NETWORKS: ReadonlyArray<NetworkInfo> = BUILT_IN_NETWORKS.filter(
  (n): n is NetworkMeta & { readonly family: "evm" } => n.family === "evm",
).flatMap((meta) => {
  const facts = EVM_FACTS[meta.chainId];
  if (facts === undefined) {
    return [];
  }
  const delegatorCodeHash = DELEGATOR_CODE_HASHES[meta.chainId];
  return [
    {
      ...meta,
      ...facts,
      ...(delegatorCodeHash === undefined ? {} : { delegatorCodeHash }),
    },
  ];
});

export const BITCOIN_NETWORKS: ReadonlyArray<NetworkInfo> = BUILT_IN_NETWORKS.filter(
  (n): n is NetworkMeta & { readonly family: "bitcoin" } => n.family === "bitcoin",
);

export const SOLANA_NETWORKS: ReadonlyArray<NetworkInfo> = BUILT_IN_NETWORKS.filter(
  (n): n is NetworkMeta & { readonly family: "solana" } => n.family === "solana",
);

export const networkById = (id: string): NetworkInfo | undefined =>
  [...NETWORKS, ...SOLANA_NETWORKS, ...BITCOIN_NETWORKS].find((n) => n.id === id);
