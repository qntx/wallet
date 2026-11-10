/**
 * Built-in EVM network registry: the chain table lives in @qntx/wallet-chains/networks; this module
 * layers the engine-only fields the signing paths need on top of it (Multicall3, OP Stack L1 data
 * fee, EIP-7702 delegator code hash). Signing-time chainId always comes from the table, never from
 * an RPC endpoint.
 */
import { BUILT_IN_NETWORKS } from "@qntx/wallet-chains/networks";
import type { NetworkMeta } from "@qntx/wallet-chains/networks";

export type NetworkInfo = NetworkMeta & {
  readonly multicall3?: string;
  /** OP Stack chain: transactions also pay an L1 data fee and an operator fee. */
  readonly opStack?: true;
  /** Keccak256 of the delegator's runtime code on this chain; absent = EIP-7702 unsupported. */
  readonly delegatorCodeHash?: string;
};

/**
 * Keccak256 of the EIP7702StatelessDeleGator v1.3.0 runtime code per chain, verified on-chain
 * 2026-11-08. Differs per chain because OpenZeppelin's EIP712 stores the chain id and the domain
 * separator as immutables. HyperEVM (999/998) has no deployment; Avalanche C-Chain (43114/43113)
 * has not activated 7702.
 */
const DELEGATOR_CODE_HASHES: Readonly<Record<number, string>> = {
  1: "0x0b77e469f5603ed1e9ff0e7ee56238b61a8cf7cb3185b33e53e2eeaad50109ab",
  8453: "0x6af675ac126c441bec5d5013da3331a52e7465fc0d5a662a8708a9f33ce497ba",
  42161: "0xa6603bc6f9f203be551ce8fcfe13b7802e3b6574828780b4c4fe05d1768d17de",
  10: "0x076ce337739f2c16aff0d81341b32ec5826a0050060e54b1346f36c79d89b246",
  137: "0x0a0b90e8b2bb4701283c0b44939f18a5292af9ab58e0f1f4a3413fdbdbebcc35",
  56: "0x2f40923fc79da9330c663341d8a52823ea02372b7da66175a0a9bfc76270d55f",
  11155111: "0x9270f73d98e7ed6978677bf0550038289efd510e67e700d024502d62510fc1e4",
  84532: "0x83805f9ac7395294043b10c3b7c1839b7e4582a3e693028c36df84978b09d4e2",
  421614: "0x7f8a570cc9ebfd8d4dd86c7cc482bb30e9c669cc281352b131c94291747a58c8",
  11155420: "0x9d71e8749e123ade3310cbab813a837f7b2ffff8608aeddb0619a78f64a95663",
  80002: "0xddc1c1b0583d57f3937d04c7bdacfaecb699d8aa27ee00040ab2c7b656ed239b",
  97: "0x27d0d3e53805ac152f306986e91511b7c6c6804cba0dbe0e1420d19905e682e6",
};

const OP_STACK_CHAINS = new Set([8453, 10, 84532, 11155420]);

// Canonical Multicall3 — https://github.com/mds1/multicall3 deployments (all entries below).
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const evmEntry = (meta: NetworkMeta): NetworkInfo => ({
  ...meta,
  multicall3: MULTICALL3,
  ...(OP_STACK_CHAINS.has(meta.chainId) ? { opStack: true as const } : {}),
  ...(DELEGATOR_CODE_HASHES[meta.chainId] === undefined
    ? {}
    : { delegatorCodeHash: DELEGATOR_CODE_HASHES[meta.chainId] }),
});

export const NETWORKS: ReadonlyArray<NetworkInfo> = BUILT_IN_NETWORKS.filter(
  (n) => n.family === "evm",
).map(evmEntry);

export const BITCOIN_NETWORKS: ReadonlyArray<NetworkInfo> = BUILT_IN_NETWORKS.filter(
  (n) => n.family === "bitcoin",
);

export const SOLANA_NETWORKS: ReadonlyArray<NetworkInfo> = BUILT_IN_NETWORKS.filter(
  (n) => n.family === "solana",
);

export const networkById = (id: string): NetworkInfo | undefined =>
  [...NETWORKS, ...SOLANA_NETWORKS, ...BITCOIN_NETWORKS].find((n) => n.id === id);
