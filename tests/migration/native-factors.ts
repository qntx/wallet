import type { UnlockFactor, VerifyFactor, Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import type { NativeWallet, NativeWalletOptions } from "@qntx/wallet-native";
import { createNativeWallet } from "@qntx/wallet-native";

/** React Native picks its own vault factors: no `factor` on create, import or restore. */
export async function createOnNative(wallet: Wallet): Promise<void> {
  // @ts-expect-error -- 0.13.0 created native vaults with an explicit hardware factor
  await wallet.wallets.createMnemonic({ words: 12, factor: { kind: "hardware" } });
  const draft = await wallet.wallets.createMnemonic({ words: 12 });
  await draft.discard();
}

/** Without a factor, unlock uses the silent device factor, or `hardware` when app lock is on. */
export async function unlockOnNative(wallet: Wallet): Promise<void> {
  await wallet.vault.unlock();
}

/** 0.13.0 typed every `verify` as `UnlockFactor`, which now includes the silent device factor. */
export async function exportBefore(
  wallet: Wallet,
  walletId: string,
  verify: UnlockFactor,
): Promise<void> {
  // @ts-expect-error -- guarded operations take a VerifyFactor
  await wallet.wallets.exportMnemonic(walletId, verify);
}

/** Guarded operations take a `VerifyFactor`; the silent device factor never verifies. */
export async function exportWithVerification(wallet: Wallet, walletId: string): Promise<void> {
  const verify: VerifyFactor = { kind: "hardware" };
  const exported = await wallet.wallets.exportMnemonic(walletId, verify);
  exported.mnemonic.wipe();
}

/** A vault created without a lock screen can still sign in; guarded calls wait for enrolment. */
export async function ensureVerification(wallet: Wallet): Promise<boolean> {
  if (wallet.getSnapshot().verification === "available") {
    return true;
  }
  try {
    await wallet.vault.enrolVerification();
    return true;
  } catch (error) {
    // Still no lock screen: tell the user to set one, then call enrolVerification again.
    if (error instanceof WalletError && error.code === "verification-unavailable") {
      return false;
    }
    throw error;
  }
}

/** The app-lock switch: `true` makes every unlock verify, `false` restores silent unlock. */
export async function setAppLock(wallet: Wallet, enabled: boolean): Promise<void> {
  await wallet.vault.setAppLock(enabled, { kind: "hardware" });
}

/** One live kernel per process: destroy the previous wallet before creating a new one. */
export async function recreateNativeWallet(
  previous: Wallet | undefined,
  options: NativeWalletOptions,
): Promise<NativeWallet> {
  await previous?.destroy();
  const wallet = await createNativeWallet(options);
  wallet.setAutoLock({ platform: "native", backgroundSeconds: 300 });
  return wallet;
}
