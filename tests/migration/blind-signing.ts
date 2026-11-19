import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { PendingRequest, WalletEngine } from "@qntx/wallet-engine";
import { BlindSigningDisabledError, requiredAcknowledgement } from "@qntx/wallet-engine";
import { chains } from "@qntx/wallet/chains";

import type { AccountRef } from "./account-ref.ts";

/** 0.13.0 kept the flag per account group in the engine; it is a vault setting now. */
export function enableBlindSigningBefore(engine: WalletEngine, walletId: string): void {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 method
  // @ts-expect-error -- AccountTreeController.setBlindSigning is removed
  engine.accounts.setBlindSigning(walletId, 0, true);
  // oxlint-enable typescript/no-unsafe-call
}

/** A dApp's blind request stays pending; enable the setting at approval, then approve it again. */
export async function approveBlind(
  wallet: Wallet,
  engine: WalletEngine,
  request: PendingRequest,
  verify: VerifyFactor,
  allowBlindSigning: () => Promise<boolean>,
): Promise<boolean> {
  const options = { verify, acknowledged: requiredAcknowledgement(request) };
  try {
    await engine.requests.approve(request.id, "evm-sign", options);
    return true;
  } catch (error) {
    if (!(error instanceof BlindSigningDisabledError) || !(await allowBlindSigning())) {
      throw error;
    }
  }
  await wallet.vault.setBlindSigning(true, verify);
  await engine.requests.approve(request.id, "evm-sign", options);
  return true;
}

/** Direct kernel signing of a blind request fails `blind-signing-disabled` before any prompt. */
export async function signRawMessage(
  wallet: Wallet,
  account: AccountRef,
  message: Uint8Array,
  verify: VerifyFactor,
): Promise<"signed" | "blind-signing-off"> {
  if (!wallet.getSnapshot().blindSigning) {
    return "blind-signing-off";
  }
  await chains(wallet).sign({
    request: { kind: "evm.personal-message", network: "eip155:1", account, message },
    verify,
  });
  return "signed";
}
