/**
 * The address-book record shared by the controller, the sync merge and the metadata document: a
 * live entry, or a tombstone that carries a deletion to the other devices.
 */
import { normalizeAddress } from "./normalize.ts";
import type { AddressFamily } from "./normalize.ts";

export type AddressBookEntry = {
  readonly id: string;
  readonly name: string;
  readonly family: AddressFamily;
  readonly address: string;
  readonly note?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AddressBookTombstone = {
  readonly id: string;
  readonly deleted: true;
  readonly updatedAt: number;
};

export type AddressBookRecord = AddressBookEntry | AddressBookTombstone;

export const isTombstone = (record: AddressBookRecord): record is AddressBookTombstone =>
  "deleted" in record;

export const NAME_MAX = 32;
export const NOTE_MAX = 120;

const isFamily = (v: unknown): v is AddressFamily =>
  v === "evm" || v === "solana" || v === "bitcoin" || v === "spark";
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "family",
  "address",
  "note",
  "createdAt",
  "updatedAt",
]);
const TOMBSTONE_KEYS: ReadonlySet<string> = new Set(["id", "deleted", "updatedAt"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Trimmed name, or `undefined` when it is not 1 to {@link NAME_MAX} characters. */
export const cleanName = (raw: string): string | undefined => {
  const name = raw.trim();
  return name.length > 0 && name.length <= NAME_MAX ? name : undefined;
};

/** Trimmed note; an empty one means no note. `undefined` return with `ok: false` when too long. */
export const cleanNote = (
  raw: string | undefined,
): { readonly ok: true; readonly note: string | undefined } | { readonly ok: false } => {
  const note = raw?.trim();
  if (note === undefined || note.length === 0) {
    return { ok: true, note: undefined };
  }
  return note.length <= NOTE_MAX ? { ok: true, note } : { ok: false };
};

const hasOnly = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((k) => keys.has(k));

/**
 * Strict decode with the controller's rules; the address is re-normalized. Anything else is
 * `undefined`.
 */
export function decodeRecord(value: unknown): AddressBookRecord | undefined {
  if (
    !isObject(value) ||
    typeof value["id"] !== "string" ||
    !isNonNegativeInt(value["updatedAt"])
  ) {
    return undefined;
  }
  if ("deleted" in value) {
    return value["deleted"] === true && hasOnly(value, TOMBSTONE_KEYS)
      ? { id: value["id"], deleted: true, updatedAt: value["updatedAt"] }
      : undefined;
  }
  const { family, name, address, note } = value;
  if (
    !hasOnly(value, ENTRY_KEYS) ||
    !isFamily(family) ||
    typeof name !== "string" ||
    typeof address !== "string" ||
    !isNonNegativeInt(value["createdAt"]) ||
    (note !== undefined && typeof note !== "string")
  ) {
    return undefined;
  }
  const cleanedName = cleanName(name);
  const normalized = normalizeAddress(family, address);
  const cleanedNote = cleanNote(note);
  // A stored note is never empty: an empty string was already dropped when it was written.
  if (
    cleanedName === undefined ||
    normalized === undefined ||
    !cleanedNote.ok ||
    (note !== undefined && cleanedNote.note === undefined)
  ) {
    return undefined;
  }
  return {
    id: value["id"],
    name: cleanedName,
    family,
    address: normalized,
    ...(cleanedNote.note === undefined ? {} : { note: cleanedNote.note }),
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
  };
}
