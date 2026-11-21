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
  | "invalid-input";

export class HyperliquidError extends Error {
  readonly category: HyperliquidErrorCategory;

  constructor(category: HyperliquidErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HyperliquidError";
    this.category = category;
  }
}
