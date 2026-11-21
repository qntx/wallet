import type { IntentWarning, IntentWarningKind, MessageTextHazard } from "@qntx/wallet-chains";
import { messageTextHazard } from "@qntx/wallet-chains";

/** 0.13.0 callers decided text vs bytes with two helpers; `messageTextHazard` is the call now. */
export function messageIsTextBefore(message: Uint8Array): boolean {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 helpers
  // @ts-expect-error -- isReadableText is removed
  if (!isReadableText(message)) {
    return false;
  }
  const text = new TextDecoder().decode(message);
  // @ts-expect-error -- isHexRendering is removed
  return !isHexRendering(text);
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
  }
}
