/** Public-derivation helpers for account-level extended keys — no secrets involved. */
import { HDKey } from "@scure/bip32";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";

import { ChainError } from "../index.ts";
import { bitcoinNetwork } from "./networks.ts";

export type BitcoinAccountTemplate = "btc.bip84" | "btc.bip86";

/**
 * Derive the address at `change`/`index` under an account-level xpub (`m/84'/c'/i'` or
 * `m/86'/c'/i'`) — P2WPKH for `btc.bip84`, P2TR key-path for `btc.bip86`.
 */
export function bitcoinAddressFromXpub(
  xpub: string,
  template: BitcoinAccountTemplate,
  network: string,
  change: 0 | 1,
  index: number,
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new ChainError("invalid-request", "index must be a non-negative integer");
  }
  const net = bitcoinNetwork(network);
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(xpub);
  } catch (error) {
    throw new ChainError(
      "invalid-request",
      `xpub: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const child = node.derive(`m/${change}/${index}`);
  const pub = child.publicKey;
  if (pub === null) {
    throw new ChainError("invalid-request", "xpub carries no public key");
  }
  const address =
    template === "btc.bip84"
      ? p2wpkh(pub, net.params).address
      : p2tr(pub.subarray(1), undefined, net.params).address;
  if (address === undefined) {
    throw new ChainError("invalid-request", "could not encode the derived address");
  }
  return address;
}
