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
    node = HDKey.fromExtendedKey(xpub, net.bip32);
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

/**
 * The compressed (P2WPKH) or x-only (P2TR) public key at `change`/`index` under an account-level
 * xpub — the key placed in a PSBT's bip32Derivation/tapBip32Derivation entry so the signing kernel
 * can re-derive it.
 */
export function bitcoinPubkeyFromXpub(
  xpub: string,
  template: BitcoinAccountTemplate,
  network: string,
  change: 0 | 1,
  index: number,
): Uint8Array {
  if (!Number.isInteger(index) || index < 0) {
    throw new ChainError("invalid-request", "index must be a non-negative integer");
  }
  const net = bitcoinNetwork(network);
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(xpub, net.bip32);
  } catch (error) {
    throw new ChainError(
      "invalid-request",
      `xpub: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pub = node.derive(`m/${change}/${index}`).publicKey;
  if (pub === null) {
    throw new ChainError("invalid-request", "xpub carries no public key");
  }
  return template === "btc.bip84" ? pub : pub.subarray(1);
}
