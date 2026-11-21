/** Polymarket provider error categories — never carry request payloads or secrets. */
export type PolymarketErrorCategory =
  /** The request may have reached the server; an L2 post's outcome is unknown. */
  | "network"
  | "timeout"
  /** The server answered with a non-2xx status. */
  | "unavailable"
  /** The answer did not satisfy its schema — nothing was accepted into state. */
  | "malformed"
  /** The device clock disagrees with the CLOB `/time` beyond the signing window. */
  | "clock-skew"
  /** A caller input fails validation before any request. */
  | "invalid-input"
  /** The CLOB rejected the request itself (a failed L2 action). */
  | "rejected"
  /** The vault is locked — the kernel refused to sign; nothing was posted. */
  | "unlock-required"
  /** The group has no enabled Polymarket credentials — enable first. */
  | "not-enabled"
  /** The step needs the relayer, which requires the host's builder signer. */
  | "builder-required"
  /** The user refused, or the approval request expired or was invalidated. */
  | "approval-rejected"
  /** An enablement flow is already running for the group — wait or cancel it. */
  | "busy"
  /** The account or jurisdiction may only close positions, not open them. */
  | "close-only"
  /** The group resolves to a legacy Safe — read-only until migrated to a deposit wallet. */
  | "needs-migration";

export class PolymarketError extends Error {
  readonly category: PolymarketErrorCategory;

  constructor(category: PolymarketErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PolymarketError";
    this.category = category;
  }
}
