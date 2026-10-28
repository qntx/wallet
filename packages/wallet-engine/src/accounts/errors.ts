/** Account-tree error categories — messages never carry secrets. */
export type AccountTreeErrorCategory = "invalid-input" | "rejected" | "not-found" | "locked";

export class AccountTreeError extends Error {
  readonly category: AccountTreeErrorCategory;

  constructor(category: AccountTreeErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AccountTreeError";
    this.category = category;
  }
}
