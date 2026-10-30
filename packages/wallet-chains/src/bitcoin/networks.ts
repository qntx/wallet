import { NETWORK, TEST_NETWORK } from "@scure/btc-signer/utils.js";
/**
 * Bip122 CAIP-2 networks = `bip122:` + the first 32 hex chars of the genesis hash, verified against
 * Bitcoin Core `src/kernel/chainparams.cpp` (assert(consensus.hashGenesisBlock == ...) per network
 * class).
 */

import { ChainError } from "../index.ts";

export type BitcoinNetwork = {
  readonly caip2: string;
  readonly genesis: string;
  readonly params: typeof NETWORK;
  readonly coinType: 0 | 1;
};

const NETWORKS: ReadonlyArray<BitcoinNetwork> = Object.freeze([
  {
    caip2: "bip122:000000000019d6689c085ae165831e93",
    genesis: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    params: NETWORK,
    coinType: 0,
  },
  {
    caip2: "bip122:00000000da84f2bafbbc53dee25a72ae",
    genesis: "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
    params: TEST_NETWORK,
    coinType: 1,
  },
  {
    caip2: "bip122:00000008819873e925422c1ff0f99f7c",
    genesis: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
    params: TEST_NETWORK,
    coinType: 1,
  },
  {
    caip2: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
    genesis: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
    params: TEST_NETWORK,
    coinType: 1,
  },
] as const);

export const BITCOIN_NETWORKS: Readonly<Record<string, BitcoinNetwork>> = Object.freeze(
  Object.fromEntries(NETWORKS.map((n) => [n.caip2, n])),
);

export const bitcoinNetwork = (caip2: string): BitcoinNetwork => {
  const net = BITCOIN_NETWORKS[caip2];
  if (net === undefined) {
    throw new ChainError("unsupported", `unknown bitcoin network: ${caip2}`);
  }
  return net;
};
