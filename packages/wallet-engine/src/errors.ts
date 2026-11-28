import type { UnsupportedReason } from "@qntx/wallet";
import { ChainError } from "@qntx/wallet-chains";

export type EngineErrorCode = "closed" | "invalid-input" | "unsupported";

/**
 * Typed engine errors: store codes are `closed`, `invalid-input` and `unsupported` (a persisted
 * format this build cannot read — `reason` is set exactly then: `older` for a pre-1.0 database this
 * build refuses to wipe, `newer` for one a newer build wrote).
 */
export class EngineStoreError extends Error {
  readonly code: EngineErrorCode;
  readonly reason: UnsupportedReason | undefined;

  constructor(code: EngineErrorCode, message: string, reason?: UnsupportedReason) {
    super(message);
    this.name = "EngineStoreError";
    this.code = code;
    this.reason = reason;
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
