export type QrErrorCode =
  | "scan-failed"
  | "scan-timeout"
  | "scan-exhausted"
  | "malformed"
  | "unsupported"
  | "fingerprint-missing"
  | "result-mismatch";

/** Every failure the qr layer reports; nothing else may escape a public entry point. */
export class QrError extends Error {
  readonly code: QrErrorCode;

  constructor(code: QrErrorCode, message: string) {
    super(message);
    this.name = "QrError";
    this.code = code;
  }
}

/** Fold any foreign throw (dcbor, UrError, viem/ox, RangeError) into `code`. */
export const qrGuard = <T>(code: QrErrorCode, run: () => T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof QrError) {
      throw error;
    }
    throw new QrError(code, error instanceof Error ? error.message : "decode failed");
  }
};
