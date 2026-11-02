import { Address } from "@scure/btc-signer";

import { decodeSparkAddress, encodeSparkAddress } from "@qntx/spark";
import { BITCOIN_NETWORKS } from "@qntx/wallet-chains/bitcoin";
import { checksumEvmAddress, isEvmAddress } from "@qntx/wallet-chains/evm";
import { isSolanaAddress } from "@qntx/wallet-chains/solana";

export type AddressFamily = "evm" | "solana" | "bitcoin" | "spark";

/**
 * The canonical form of `address` for its family — EIP-55 for EVM, the re-encoded form for bitcoin
 * (accepted on any known bitcoin network, since a contact is not tied to the wallet's network) and
 * Spark (identity key only, no invoice fields) — or `undefined` when it is not a valid address.
 */
export function normalizeAddress(family: AddressFamily, address: string): string | undefined {
  try {
    if (family === "evm") {
      return isEvmAddress(address) ? checksumEvmAddress(address) : undefined;
    }
    if (family === "solana") {
      return isSolanaAddress(address) ? address : undefined;
    }
    if (family === "spark") {
      const decoded = decodeSparkAddress(address);
      return encodeSparkAddress({
        network: decoded.network,
        identityPublicKey: decoded.identityPublicKey,
      });
    }
    for (const network of Object.values(BITCOIN_NETWORKS)) {
      try {
        const codec = Address(network.params);
        return codec.encode(codec.decode(address));
      } catch {
        // not an address of this network; try the next
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
