export type QrErrorCode =
  | "scan-failed"
  | "scan-timeout"
  | "scan-exhausted"
  | "malformed"
  | "unsupported"
  | "fingerprint-missing"
  | "result-mismatch"
  | "account-mismatch"
  | "network-unknown"
  | "chain-mismatch"
  | "network-ambiguous"
  | "unbound"
  | "contract-creation"
  | "self-call"
  | "multisig-unsupported"
  | "nothing-to-sign"
  | "sighash-unsupported"
  | "wallet-unsupported";

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

/** Throw the `malformed` variant — a payload or record that cannot parse. */
export function malformed(detail: string): never {
  throw new QrError("malformed", detail);
}

/** Throw the `unsupported` variant — a well-formed payload outside what the qr layer serves. */
export function unsupported(detail: string): never {
  throw new QrError("unsupported", detail);
}

/** Throw the `result-mismatch` variant — a response or export that does not match its request. */
export function resultMismatch(detail: string): never {
  throw new QrError("result-mismatch", detail);
}
