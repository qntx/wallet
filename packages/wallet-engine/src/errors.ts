import { ChainError } from "@qntx/wallet-chains";

export type EngineErrorCode = "closed" | "invalid-input";

/** Typed engine errors: store codes are `closed` and `invalid-input`. */
export class EngineStoreError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineStoreError";
    this.code = code;
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Why an NFT transfer preparation refused, surfaced for callers that branch on it. */
export type NftRefusal =
  | "not-nft"
  | "not-owned"
  | "insufficient-balance"
  | "programmable"
  | "frozen"
  | "not-found";

/** An NFT send refusal: `code` stays `invalid-request`, `reason` names which guard fired. */
export class NftTransferError extends ChainError {
  readonly reason: NftRefusal;

  constructor(reason: NftRefusal, message: string) {
    super("invalid-request", message);
    this.name = "NftTransferError";
    this.reason = reason;
  }
}
