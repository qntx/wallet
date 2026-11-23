import type { IntentWarning, IntentWarningKind, MessageTextHazard } from "@qntx/wallet-chains";
import { messageTextHazard } from "@qntx/wallet-chains";

/** 0.13.0 callers decided text vs bytes with two helpers; `messageTextHazard` is the call now. */
export function messageIsTextBefore(message: Uint8Array): boolean {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 helpers
  // @ts-expect-error -- isReadableText is removed
  if (isReadableText(message) !== true) {
    return false;
  }
  const text = new TextDecoder().decode(message);
  // @ts-expect-error -- isHexRendering is removed
  return isHexRendering(text) !== true;
  // oxlint-enable typescript/no-unsafe-call
}

/** Hazardous text still displays — the hazard classifies it blind, it does not hide it. */
export function messageTextAfter(
  message: Uint8Array,
): { readonly text: string; readonly hazard: MessageTextHazard | undefined } | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(message);
  } catch {
    return undefined;
  }
  // messageTextHazard covers the old isHexRendering check plus digest-length and
  // hidden-character hazards; a hazard means "blind but still shown", not "bytes".
  return { text, hazard: messageTextHazard(text) };
}

/** The warning union is closed — a handler must name every kind. */
export function describeWarning(warning: IntentWarning): string {
  const kind: IntentWarningKind = warning.kind;
  switch (kind) {
    case "platform-fee":
      return "the transaction charges a platform fee";
    case "stake-lockup":
      return "stake stays locked";
    case "sighash-single-anyonecanpay":
      return "the signature commits to one input and one output only";
    case "permit2-witness":
      return "the permit carries an unsigned witness payload";
    case "delegation-replaced":
      return "a newer delegation replaced this one";
    case "token-2022-transfer-fee":
      return "the token charges a transfer fee";
    case "token-2022-extension":
      return "the token carries a Token-2022 extension";
    case "fiat24-internal-account":
      return "the target is a Fiat24 internal account, not a client";
    case "fiat24-card-pull":
      return "the Fiat24 card contract can pull up to the allowance";
    case "fiat24-unlimited-approval":
      return "an unlimited Fiat24 allowance";
    case "fiat24-issuer-rate":
      return "the issuer sets the rate at execution";
    case "fiat24-exact-out-unbounded":
      return "the payment is bounded only by the allowance";
    case "fiat24-swap-quote":
      return "the swap is priced inside the transaction";
    case "fiat24-payee-offchain":
      return "the payee resolves off-chain";
    case "fiat24-account-link":
      return "the address is permanently linked to a verified identity";
    case "fiat24-account-move":
      return "the account NFT hands over control";
    case "fiat24-account-burn":
      return "opening the account burns F24 at the issuer-set price";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
