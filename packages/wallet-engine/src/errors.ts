export type EngineErrorCode = "closed" | "integrity";

/** Typed engine errors: store codes are `closed` and `integrity` (decrypt or bind failure). */
export class EngineStoreError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineStoreError";
    this.code = code;
  }
}
