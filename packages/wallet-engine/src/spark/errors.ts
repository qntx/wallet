import { SparkError, SparkInputError, SparkRequestError } from "@qntx/spark";

import type { SparkPaymentRecord } from "./payments.ts";

/** SparkController error categories — never carry request bytes or secrets. */
export type SparkErrorCategory =
  | "network"
  | "approval-required"
  | "insufficient-funds"
  | "rejected"
  /** The payment may have committed; `payment` is its open record. */
  | "unknown"
  | "internal";

export class SparkControllerError extends Error {
  readonly category: SparkErrorCategory;
  /** An "unknown" outcome's payment record — open until the Spark operator answers. */
  readonly payment?: SparkPaymentRecord;

  constructor(
    category: SparkErrorCategory,
    message: string,
    cause?: unknown,
    payment?: SparkPaymentRecord,
  ) {
    super(message, { cause });
    this.name = "SparkControllerError";
    this.category = category;
    if (payment !== undefined) {
      this.payment = payment;
    }
  }
}

/**
 * Maps a thrown client/kernel error into a category without leaking payloads. The library's own
 * classes decide first — a `SparkRequestError` is a request or server failure whatever its message
 * happens to say — and only non-Spark errors fall back to their message text.
 */
export function categorize(error: unknown): SparkErrorCategory {
  if (error instanceof SparkRequestError) {
    // Includes SparkTokenBroadcastError — a request failure whose outcome was uncertain.
    return "network";
  }
  if (error instanceof SparkInputError) {
    return /insufficient/i.test(error.message) ? "insufficient-funds" : "rejected";
  }
  if (error instanceof SparkError) {
    return "internal";
  }
  const message = error instanceof Error ? error.message : "";
  if (/approval|denied|rejected/i.test(message)) {
    return /required/i.test(message) ? "approval-required" : "rejected";
  }
  if (/insufficient|not enough|balance/i.test(message)) {
    return "insufficient-funds";
  }
  if (/fetch|network|timeout|unavailable|closed/i.test(message)) {
    return "network";
  }
  return "internal";
}
