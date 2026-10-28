/** Meta-sync error categories — messages never carry event or document content. */
export type MetaSyncErrorCategory = "network" | "internal" | "unsupported" | "corrupt";

export class MetaSyncError extends Error {
  readonly category: MetaSyncErrorCategory;

  constructor(category: MetaSyncErrorCategory, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MetaSyncError";
    this.category = category;
  }
}
