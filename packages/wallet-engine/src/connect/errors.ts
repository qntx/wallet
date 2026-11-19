/** EIP-1193 / EIP-1474 / EIP-3326 error: `code` is what the page's promise rejects with. */
export class ProviderError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export const userRejectedRequest = (message = "user rejected the request"): ProviderError =>
  new ProviderError(4001, message);

export const unauthorized = (message = "not authorized"): ProviderError =>
  new ProviderError(4100, message);

export const unsupportedMethod = (method: string): ProviderError =>
  new ProviderError(4200, `${method} is not supported`);

export const unrecognizedChain = (message = "unrecognized chain"): ProviderError =>
  new ProviderError(4902, message);

export const invalidParams = (message: string): ProviderError => new ProviderError(-32602, message);

export const requestPending = (message: string): ProviderError =>
  new ProviderError(-32002, message);

/** EIP-1474 "limit exceeded": the request is valid but asks for more than the wallet serves. */
export const limitExceeded = (message: string): ProviderError => new ProviderError(-32005, message);

export const internalError = (message: string): ProviderError => new ProviderError(-32603, message);

/** JSON-RPC implementation-defined server error (outside EIP-1474's assigned codes). */
export const PAYMENT_PENDING_CODE = -32010;

/**
 * The payment may have been made — it may still settle, or settled without a usable answer — never
 * an error the page can safely retry: an lnurl dApp that retries on failure would fetch a new
 * invoice and pay twice.
 */
export const paymentPending = (message: string): ProviderError =>
  new ProviderError(PAYMENT_PENDING_CODE, message);

/**
 * A batch send that stopped at `refused.index` (never the first: a first refusal fails the request
 * instead): the message names the refused input and its error, and lists the ids already submitted
 * so the page does not resubmit them.
 */
export const broadcastRefused = (
  refused: { readonly index: number; readonly error: string },
  submitted: ReadonlyArray<string>,
): ProviderError =>
  internalError(
    `the network refused transaction ${String(refused.index)}: ${refused.error} — already ` +
      `submitted, do not resubmit: ${submitted.join(", ")}`,
  );
