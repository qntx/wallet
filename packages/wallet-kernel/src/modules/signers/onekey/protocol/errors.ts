/**
 * The only error type the OneKey protocol client throws. The codes are the public vocabulary the
 * kernel maps onto; messages are static strings that never echo device-supplied text (Failure
 * payloads, labels) or secrets.
 */
export type OneKeyErrorCode =
  | "frame"
  | "device-fault"
  | "user-rejected"
  | "pin-invalid"
  | "device-locked"
  | "not-initialized"
  | "unsupported"
  | "device-error"
  | "invalid-input";

export class OneKeyError extends Error {
  readonly code: OneKeyErrorCode;
  /** The device Failure code that triggered the error, when one did. */
  readonly failure: number | undefined;
  constructor(code: OneKeyErrorCode, message: string, failure?: number) {
    super(message);
    this.name = "OneKeyError";
    this.code = code;
    this.failure = failure;
  }
}
