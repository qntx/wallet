import type { Wallet } from "@qntx/wallet";

/**
 * A 0.13.0 vault is format 3, which this release reports as `unsupported` and never opens. The only
 * way forward is a reset followed by a restore from the user's mnemonic, passkey or a backup made
 * after the upgrade — confirm with the user first, because the reset erases every wallet and key.
 */
export async function replaceUnsupportedVault(
  wallet: Wallet,
  confirmErase: () => Promise<boolean>,
): Promise<"reset" | "kept"> {
  if (wallet.getSnapshot().vault !== "unsupported" || !(await confirmErase())) {
    return "kept";
  }
  await wallet.vault.reset();
  return "reset";
}

/** After the reset: a mnemonic wallet comes back from its phrase, a passkey wallet from its passkey. */
export async function restoreAfterReset(
  wallet: Wallet,
  source: { readonly kind: "mnemonic"; readonly mnemonic: string } | { readonly kind: "passkey" },
): Promise<string> {
  const info =
    source.kind === "mnemonic"
      ? await wallet.wallets.importMnemonic({ mnemonic: source.mnemonic })
      : await wallet.wallets.restoreWithPasskey();
  return info.walletId;
}
