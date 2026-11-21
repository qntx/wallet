/** Hyperliquid provider error categories — never carry request payloads or secrets. */
export type HyperliquidErrorCategory =
  | "network"
  /** The request may have reached the server; an /exchange post's outcome is unknown. */
  | "timeout"
  /** The server answered with a non-2xx status. */
  | "unavailable"
  /** The device clock disagrees with the server beyond the bound — signing would be refused. */
  | "clock-skew"
  /** A price, size or other caller input fails the tick/lot/canonical rules. */
  | "invalid-input"
  /** Hyperliquid rejected the signed action itself (a `status: "err"` exchange answer). */
  | "rejected"
  /** The vault is locked — the kernel refused to sign; nothing was posted. */
  | "unlock-required"
  /** The enabled agent expired, was rejected by Hyperliquid, or is gone — re-enable is required. */
  | "reauthorization-required"
  /** The account has no enabled, owner-verified agent on this network. */
  | "not-enabled"
  /** The account has no Hyperliquid presence yet — a deposit must land before enabling. */
  | "deposit-required"
  /** The user refused, or the approval request expired or was invalidated. */
  | "approval-rejected"
  /** An enablement flow is already running for the group — wait or cancel it. */
  | "busy";

export class HyperliquidError extends Error {
  readonly category: HyperliquidErrorCategory;

  constructor(category: HyperliquidErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HyperliquidError";
    this.category = category;
  }
}
