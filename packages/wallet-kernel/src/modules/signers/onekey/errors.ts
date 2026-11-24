/**
 * OneKey protocol errors into kernel errors: the `OneKeyError` codes the protocol client throws map
 * onto the signer module's contract codes — `user-rejected` maps to `device-rejected` like every
 * other refusal, everything transport-side is `integrity`. The throwers `integrity` and
 * `wrongDevice` are the never-returning guards the driver files share.
 */
import { KernelError } from "../../../errors.ts";
import type { KernelErrorCode } from "../../../errors.ts";
import { OneKeyError } from "./protocol/index.ts";
import type { OneKeyErrorCode } from "./protocol/index.ts";

const KERNEL_CODE: Readonly<Record<OneKeyErrorCode, KernelErrorCode>> = {
  frame: "integrity",
  "device-fault": "integrity",
  "device-error": "integrity",
  "user-rejected": "device-rejected",
  "pin-invalid": "device-locked",
  "device-locked": "device-locked",
  "not-initialized": "unsupported",
  unsupported: "unsupported",
  "invalid-input": "invalid-input",
};

// Function declarations, not const arrows: this project's TypeScript narrows never-returning
// calls only when they resolve to a declaration.
export function integrity(message: string): never {
  throw new KernelError("integrity", message);
}

export function wrongDevice(): never {
  throw new KernelError("wrong-device", "the device answered with different keys");
}

/** OneKeyError → KernelError. OneKeyError messages are static by contract — reuse them as-is. */
export function kernelError(error: unknown): Error {
  if (error instanceof OneKeyError) {
    return new KernelError(KERNEL_CODE[error.code], error.message);
  }
  return error instanceof Error ? error : integrity("the device exchange failed");
}
