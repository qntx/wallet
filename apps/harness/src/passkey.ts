/**
 * Native passkey RP config shared by the smokes. The salts use the playground's labels so a
 * wallet created through Safari on wallet-harness.qntx.org restores to the same walletId.
 */
import type { PasskeyConfig } from "@qntx/wallet";

export const PASSKEY: PasskeyConfig = {
  // Served by apps/harness/relying-party (AASA + assetlinks for this app).
  rpId: "wallet-harness.qntx.org",
  rpName: "QNTX Wallet Harness",
  walletSalt: "qntx/wallet",
  vaultSalt: "qntx/vault",
  backupSalt: "qntx/backup",
};
