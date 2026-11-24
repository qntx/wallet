import type { WalletErrorCode } from "@qntx/wallet";
import type { BackupErrorCategory, EngineErrorCode, SparkErrorCategory } from "@qntx/wallet-engine";

/**
 * Exhaustive maps: adding or removing a code fails this file, so the list in MIGRATION.md stays
 * complete. New in this release: `verification-unavailable`, `blind-signing-disabled`
 * (`no-device-credential` is gone), the seven `card-*` codes; `weak-password`; `auth-required`;
 * `quota`; `unknown`; `EngineErrorCode` lost `integrity`; `device-required`, `device-locked`,
 * `device-app-closed`, `device-rejected`, `wrong-device`; `app-lock-required`, `limit-exceeded`
 * (session metering).
 */
export const WALLET_ERROR_IS_NEW: Readonly<Record<WalletErrorCode, boolean>> = {
  locked: false,
  cancelled: false,
  "factor-invalidated": false,
  "verification-unavailable": true,
  "passkey-not-configured": false,
  "passkey-prf-unsupported": false,
  "wrong-password": false,
  "wrong-passkey": false,
  "rate-limited": false,
  "invalid-input": false,
  "not-found": false,
  "already-exists": false,
  conflict: false,
  unsupported: false,
  unavailable: false,
  integrity: false,
  "blind-signing-disabled": true,
  "approval-required": false,
  "card-not-genuine": true,
  "card-id-mismatch": true,
  "card-erased": true,
  "card-locked": true,
  "card-tampered": true,
  "card-fault": true,
  "card-unsupported": true,
  "app-lock-required": true,
  "limit-exceeded": true,
  crashed: false,
  "device-required": true,
  "device-locked": true,
  "device-app-closed": true,
  "device-rejected": true,
  "wrong-device": true,
};

export const BACKUP_ERROR_IS_NEW: Readonly<Record<BackupErrorCategory, boolean>> = {
  cloud: false,
  conflict: false,
  unavailable: false,
  "weak-password": true,
  "auth-required": true,
  quota: true,
};

export const SPARK_ERROR_IS_NEW: Readonly<Record<SparkErrorCategory, boolean>> = {
  network: false,
  "approval-required": false,
  "insufficient-funds": false,
  rejected: false,
  unknown: true,
  duplicate: true,
  internal: false,
};

// @ts-expect-error -- the engine store no longer reports integrity: an unreadable row reads absent
export const ENGINE_INTEGRITY: EngineErrorCode = "integrity";
