/**
 * The only error type the Ledger protocol client throws. The codes are the public vocabulary the
 * kernel maps onto; messages are static strings that never echo device output.
 */
export type LedgerErrorCode =
  | "invalid-input" // host-side argument out of bounds (path, lengths, values)
  | "transport" // framing violation: channel/tag/sequence wrong, bad frame size, trailing frame
  | "invalid-response" // response structure/length/content violated (incl. inconsistent with request or key)
  | "device-locked" // 5515
  | "app-not-open" // 6E00: dashboard or another app in the foreground
  | "app-not-installed" // OPEN_APP 6807
  | "user-rejected" // 6985, 5501 (Solana also 6982)
  | "setting-required" // needs an app setting: Solana 6808 blind signing, Tron 6A8B/6A8C/6A8D
  | "unsupported" // version gate, 6D00 INS the build lacks (e.g. EIP-7702), Tron 6A8E swap mode
  | "device-fault"; // any other status word, incl. 6Fxx

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  /** The status word that triggered the error, when one did. */
  readonly sw: number | undefined;

  constructor(code: LedgerErrorCode, message: string, sw?: number) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.sw = sw;
  }
}
