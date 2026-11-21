import { ProviderError } from "../connect/errors.ts";

export type WalletConnectErrorCode =
  | "invalid-uri"
  | "expired-uri"
  | "duplicate-pairing"
  | "unknown-proposal"
  | "expired"
  | "locked"
  | "blocked"
  | "invalid-grant"
  | "unacknowledged";

/** A `createWalletConnect` misuse or a refused pairing/proposal/grant; `code` says which. */
export class WalletConnectError extends Error {
  readonly code: WalletConnectErrorCode;
  constructor(code: WalletConnectErrorCode, message: string) {
    super(message);
    this.name = "WalletConnectError";
    this.code = code;
  }
}

/**
 * The JSON-RPC error a `session_request` answer carries: a user rejection is the protocol's `5000
 * "User rejected."`, other provider errors keep their code, anything else is opaque.
 */
export const requestError = (error: unknown): { code: number; message: string } => {
  if (error instanceof ProviderError) {
    return error.code === 4001
      ? { code: 5000, message: "User rejected." }
      : { code: error.code, message: error.message };
  }
  return { code: -32603, message: "internal error" };
};
