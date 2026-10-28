/** Payment layer error categories — messages never carry remote or secret content. */
export type PaymentErrorCategory = "invalid-input" | "network" | "rejected";

export class PaymentError extends Error {
  readonly category: PaymentErrorCategory;

  constructor(category: PaymentErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PaymentError";
    this.category = category;
  }
}
