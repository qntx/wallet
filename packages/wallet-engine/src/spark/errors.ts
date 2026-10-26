/** SparkController error categories — never carry request bytes or secrets. */
export type SparkErrorCategory =
  | "network"
  | "approval-required"
  | "insufficient-funds"
  | "rejected"
  | "internal";

export class SparkControllerError extends Error {
  readonly category: SparkErrorCategory;

  constructor(category: SparkErrorCategory, message: string) {
    super(message);
    this.name = "SparkControllerError";
    this.category = category;
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
