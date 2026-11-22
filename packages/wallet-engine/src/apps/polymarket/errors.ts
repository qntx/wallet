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
  /** The vault is locked — the credential store is closed; nothing was posted. */
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
  /** A blocked jurisdiction, or an unknown/error eligibility answer — the gate fails closed. */
  | "blocked"
  /** The group resolves to a legacy Safe — read-only until migrated to a deposit wallet. */
  | "needs-migration"
  /**
   * The relayer, the chain RPC and the host endpoint disagree on which account wallet exists, or
   * the code there is not the expected template — nothing is chosen.
   */
  | "deployment-mismatch";

export class PolymarketError extends Error {
  readonly category: PolymarketErrorCategory;
  /**
   * The HTTP status — set on `unavailable` only. Callers distinguish a definitive 4xx (the request
   * never ran as asked) from a 5xx/timeout (the outcome is unknown).
   */
  readonly status?: number;
  /** The server's parsed JSON error body when it was an object — `unavailable` only. */
  readonly body?: Readonly<Record<string, unknown>>;

  constructor(
    category: PolymarketErrorCategory,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly status?: number;
      readonly body?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "PolymarketError";
    this.category = category;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
    if (options?.body !== undefined) {
      this.body = options.body;
    }
  }
}
