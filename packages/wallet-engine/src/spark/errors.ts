/** SparkController error categories — never carry request bytes or secrets. */
export type SparkErrorCategory =
  | "network"
  | "approval-required"
  | "insufficient-funds"
  | "rejected"
  /** The payment may have committed; it settles under its transfer id. */
  | "unknown"
  | "internal";

export class SparkControllerError extends Error {
  readonly category: SparkErrorCategory;
  /** The transfer id under which an "unknown" outcome may have committed. */
  readonly transferId?: string;
  /** Token transfers: the spent output ids under which an "unknown" outcome may have committed. */
  readonly inputOutputIds?: ReadonlyArray<string>;

  constructor(
    category: SparkErrorCategory,
    message: string,
    cause?: unknown,
    transferId?: string,
    inputOutputIds?: ReadonlyArray<string>,
  ) {
    super(message, { cause });
    this.name = "SparkControllerError";
    this.category = category;
    if (transferId !== undefined) {
      this.transferId = transferId;
    }
    if (inputOutputIds !== undefined) {
      this.inputOutputIds = inputOutputIds;
    }
  }
}

/** Maps a thrown client/kernel error into a category without leaking payloads. */
export function categorize(error: unknown): SparkErrorCategory {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/approval|denied|rejected/i.test(message)) {
    return /required/i.test(message) ? "approval-required" : "rejected";
  }
  if (/insufficient|not enough|balance/i.test(message)) {
    return "insufficient-funds";
  }
  if (name === "SparkRequestError" || /fetch|network|timeout|unavailable|closed/i.test(message)) {
    return "network";
  }
  return "internal";
}
