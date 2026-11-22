/**
 * The only error type the qntx card protocol client throws. The codes are the public vocabulary the
 * kernel maps onto; messages are static strings that never echo card output or secrets.
 */
export type CardErrorCode =
  | "card-not-genuine"
  | "session-broken"
  | "wrong-access-code"
  | "wait-required"
  | "wallet-erased"
  | "not-verified"
  | "wrong-state"
  | "invalid-data"
  | "card-fault"
  | "invalid-input";

export class CardError extends Error {
  readonly code: CardErrorCode;
  /** The outer or inner status word that triggered the error, when one did. */
  readonly sw: number | undefined;
  /** Attempts left before erasure; only set on `wrong-access-code` (1–9, protocol.md §13.2). */
  readonly remaining: number | undefined;

  constructor(code: CardErrorCode, message: string, sw?: number, remaining?: number) {
    super(message);
    this.name = "CardError";
    this.code = code;
    this.sw = sw;
    this.remaining = remaining;
  }
}
