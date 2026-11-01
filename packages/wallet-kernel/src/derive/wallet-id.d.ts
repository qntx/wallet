import type { HDKey } from "@scure/bip32";
/**
 * Stable wallet identifier: lowercase hex of the first 8 bytes of
 * SHA-256(UTF-8("qntx-wallet/wallet-id/v1") ‖ master compressed public key). Derived from public
 * data only — safe to use as a record id.
 */
export declare function walletIdOf(master: HDKey): string;
