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

export const internalError = (message: string): ProviderError => new ProviderError(-32603, message);
