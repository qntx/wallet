import { KernelError } from "../../../errors.ts";
import type { KernelErrorCode } from "../../../errors.ts";
/**
 * Ledger protocol errors into kernel errors: the wire-level `LedgerError` codes the protocol
 * clients throw map onto the signer module's contract codes. `user-rejected` is the only code a
 * caller may want to intercept before mapping (an address check answers `matched: false` rather
 * than failing), so the map is exported as a pure function and the catch is the caller's.
 */
import { LedgerError } from "../../ledger/protocol/errors.ts";
import type { LedgerErrorCode } from "../../ledger/protocol/errors.ts";

const CODES: Readonly<Record<LedgerErrorCode, KernelErrorCode>> = {
  "device-locked": "device-locked",
  "app-not-open": "device-app-closed",
  "app-not-installed": "device-app-closed",
  "user-rejected": "device-rejected",
  "setting-required": "blind-signing-disabled",
  unsupported: "unsupported",
  "invalid-input": "unsupported",
  "invalid-response": "integrity",
  transport: "integrity",
  "device-fault": "unsupported",
};

/** Maps one `LedgerError` to the kernel code its ledger code names. */
export const mapLedgerError = (error: LedgerError): KernelError =>
  new KernelError(
    CODES[error.code],
    error.code === "device-fault" ? "the device refused the request" : error.message,
  );

/**
 * Runs `job` and maps any `LedgerError` it throws to the kernel code for that ledger code —
 * `device-fault` loses its (unreliable, status-word-dependent) message for the fixed refusal text.
 * Kernel errors from the driver's own guards pass through untouched.
 */
export const call = async <T>(job: () => Promise<T>): Promise<T> => {
  try {
    return await job();
  } catch (error) {
    if (error instanceof LedgerError) {
      throw mapLedgerError(error);
    }
    throw error;
  }
};
