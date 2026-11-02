export type AddressBookErrorCategory =
  | "invalid-input"
  | "duplicate"
  | "not-found"
  | "locked"
  | "limit";

export class AddressBookError extends Error {
  readonly category: AddressBookErrorCategory;

  constructor(category: AddressBookErrorCategory, message: string) {
    super(message);
    this.name = "AddressBookError";
    this.category = category;
  }
}
