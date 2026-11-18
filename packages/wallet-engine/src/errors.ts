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
