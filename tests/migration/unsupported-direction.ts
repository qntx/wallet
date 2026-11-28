import type { BackupInspection, UnsupportedReason, VaultState } from "@qntx/wallet";
import { EngineStoreError } from "@qntx/wallet-engine";
import type { EngineStore } from "@qntx/wallet-engine";

/**
 * Every persisted artefact reports `unsupported` with a direction: `older` — a pre-1.0 build wrote
 * it and this build has no reader; `newer` — a newer build wrote it. `older` is recoverable only by
 * starting over (an explicit reset, then restoring from the mnemonic, passkey or cloud backup —
 * behind a data-loss confirmation, never automatic); `newer` means "update the app" — never offer a
 * reset.
 */
export function unsupportedVaultAction(
  vault: VaultState,
): "restore-flow" | "update-app" | undefined {
  if (vault.status !== "unsupported") {
    return undefined;
  }
  return vault.reason === "older" ? "restore-flow" : "update-app";
}

/**
 * `engine.backup.list()` reports an unreadable file with its direction instead of skipping it:
 * `older` → "this backup was made by an older version — restore from the mnemonic"; `newer` →
 * "update the app to restore this backup".
 */
export function backupRowMessage(header: BackupInspection): string | undefined {
  if (header.status === "ok") {
    return undefined;
  }
  return header.reason === "older"
    ? "This backup was made by an older version and cannot be restored — restore from the mnemonic."
    : "Update the app to restore this backup.";
}

/**
 * The engine store is the one artefact with no reset: an `older` database is refused, never wiped,
 * until the host discards it. On confirmation (what is lost: address book, custom tokens/RPCs,
 * watch accounts, connections, sign log, tracked transactions) delete the database and reopen; a
 * `newer` database means "update the app" — rethrow.
 */
export async function openEngineStore(
  databaseName: string,
  open: () => Promise<EngineStore>,
  confirmDiscard: (reason: UnsupportedReason) => Promise<boolean>,
): Promise<EngineStore> {
  try {
    return await open();
  } catch (error) {
    if (
      error instanceof EngineStoreError &&
      error.code === "unsupported" &&
      error.reason === "older" &&
      (await confirmDiscard("older"))
    ) {
      // Await the deletion — `blocked` means another connection still holds the database.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.addEventListener("success", () => {
          resolve();
        });
        request.addEventListener("blocked", () => {
          reject(new Error("engine store: deleteDatabase blocked"));
        });
        request.addEventListener("error", () => {
          reject(request.error ?? new Error("engine store: deleteDatabase failed"));
        });
      });
      return open();
    }
    throw error;
  }
}
