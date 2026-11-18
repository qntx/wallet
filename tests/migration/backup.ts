import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { WalletEngine } from "@qntx/wallet-engine";
import { BackupControllerError, backupPasswordStrength } from "@qntx/wallet-engine";

/** `backup.disable` re-verifies like `enable`. */
export async function turnBackupOff(engine: WalletEngine, verify: VerifyFactor): Promise<void> {
  // @ts-expect-error -- disable takes the verification factor
  await engine.backup.disable();
  await engine.backup.disable(verify);
}

/**
 * The backup password is stretched with Argon2id and must be at least 12 characters and reach
 * zxcvbn's top score: rate the draft as the user types, and expect `weak-password` from `enable`.
 */
export async function enablePasswordBackup(
  engine: WalletEngine,
  verify: VerifyFactor,
  password: string,
): Promise<"enabled" | "weak"> {
  const strength = await backupPasswordStrength(password);
  if (!strength.acceptable) {
    return "weak";
  }
  try {
    await engine.backup.enable({ verify, factors: [{ kind: "password", password }] });
    return "enabled";
  } catch (error) {
    if (error instanceof BackupControllerError && error.category === "weak-password") {
      return "weak";
    }
    throw error;
  }
}

/**
 * Restoring with the backup password (or a Web passkey) brings the wallets back but leaves backup
 * off: ask the user to enable it again, which writes a new key and a new cloud file.
 */
export async function restoreFromBackup(
  wallet: Wallet,
  engine: WalletEngine,
  name: string,
  password: string,
): Promise<{ readonly backupOff: boolean }> {
  await engine.backup.restore({ name, backupFactor: { kind: "password", password } });
  return { backupOff: wallet.getSnapshot().backup === null };
}
