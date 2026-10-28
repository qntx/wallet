/** BackupController error categories — never carry file contents, digests or secrets. */
export type BackupErrorCategory = "cloud" | "conflict" | "unavailable";

export class BackupControllerError extends Error {
  readonly category: BackupErrorCategory;

  constructor(category: BackupErrorCategory, message: string) {
    super(message);
    this.name = "BackupControllerError";
    this.category = category;
  }
}
