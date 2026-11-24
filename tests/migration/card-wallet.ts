/**
 * §30 Card wallets: `WalletInfo` is a union discriminated by `custody`, so `words`, `passphrase`
 * and the vault `backup` values exist only on a vault wallet. A card wallet signs through
 * `card(wallet).start`, not `chains(wallet).sign` (which answers `device-required`); the host only
 * renders the steps the kernel reports and can cancel. Compiled only.
 */
import { WalletError } from "@qntx/wallet";
import type { VerifyFactor, Wallet, WalletInfo } from "@qntx/wallet";
import { card } from "@qntx/wallet/card";
import type { CardStep } from "@qntx/wallet/card";
import { chains } from "@qntx/wallet/chains";
import type { ChainSignRequest, ChainSignResult } from "@qntx/wallet/chains";

/** The recovery line a wallet list shows — narrow on `custody` before reading vault-only fields. */
export function recoveryText(info: WalletInfo): string {
  if (info.custody === "card") {
    return `${info.cards.length} of ${info.members} cards`;
  }
  if (info.custody === "hardware") {
    return `the ${info.device}'s own recovery`;
  }
  return `${info.words}-word recovery phrase`;
}

// @ts-expect-error -- 0.13.0 read `words` on every wallet; a card wallet has none
export type Words = WalletInfo["words"];

/** What the host shows for a step: `input` mounts `SecureInput`, `tap` the hold-the-card sheet. */
export function stepText(step: CardStep): string {
  switch (step.kind) {
    case "input":
      return step.purpose === "short-id"
        ? `Type the ID printed on card ${step.card ?? ""}`
        : "Enter the card's access code";
    case "tap":
      return step.hold === true ? "Hold the card until it is done" : "Tap your card";
    case "done":
      return "Done";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- §30 wants the never default as the exhaustiveness proof
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

/** Sign on a vault wallet as before; a card wallet answers `device-required` and runs a card task. */
export async function signAnyWallet(
  wallet: Wallet,
  request: ChainSignRequest,
  verify: VerifyFactor,
  render: (text: string) => void,
): Promise<ChainSignResult> {
  try {
    return await chains(wallet).sign({ request, verify });
  } catch (error) {
    if (!(error instanceof WalletError) || error.code !== "device-required") {
      throw error;
    }
  }
  const task = card(wallet).start({ kind: "sign", request }, { verify });
  const stop = task.observe((step) => {
    render(stepText(step));
  });
  try {
    const outcome = await task.result;
    if (outcome.kind !== "sign") {
      throw new WalletError("integrity", "a sign task answered another result");
    }
    return outcome.result;
  } finally {
    stop();
  }
}
