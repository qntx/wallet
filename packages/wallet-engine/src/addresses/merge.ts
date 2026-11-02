/**
 * Address-book sync rules, pure: last-writer-wins per id, deterministic ties, tombstone expiry and
 * the record cap. Time is always passed in.
 */
import { isTombstone } from "./record.ts";
import type { AddressBookRecord } from "./record.ts";

/** Entries plus tombstones never exceed this many records. */
export const ADDRESS_BOOK_LIMIT = 128;

/** A tombstone older than this is dropped at merge time. */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const serialized = (record: AddressBookRecord): string => JSON.stringify(record);

/** The winner of two versions of one id: larger `updatedAt`, then the larger serialization. */
export function pickWinner(a: AddressBookRecord, b: AddressBookRecord): AddressBookRecord {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? a : b;
  }
  return serialized(a) >= serialized(b) ? a : b;
}

export const pruneTombstones = (
  records: ReadonlyArray<AddressBookRecord>,
  now: number,
): ReadonlyArray<AddressBookRecord> =>
  records.filter((r) => !isTombstone(r) || now - r.updatedAt <= TOMBSTONE_TTL_MS);

/** Newest first, id as the tiebreak, so every device orders (and truncates) the same way. */
const newestFirst = (a: AddressBookRecord, b: AddressBookRecord): number =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);

/** Drops the oldest tombstones until at most `max` records remain, or no tombstone is left. */
export function evictTombstones(
  records: ReadonlyArray<AddressBookRecord>,
  max: number,
): ReadonlyArray<AddressBookRecord> {
  const excess = records.length - max;
  if (excess <= 0) {
    return records;
  }
  const oldest = new Set(
    records
      .filter(isTombstone)
      .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
      .slice(0, excess)
      .map((r) => r.id),
  );
  return records.filter((r) => !oldest.has(r.id));
}

/**
 * Merges two record sets: one winner per id, tombstones past their TTL dropped, two live entries
 * for the same (family, address) reduced to the winner, then tombstones evicted (and, only if live
 * entries alone exceed the cap, the oldest entries) down to {@link ADDRESS_BOOK_LIMIT}.
 */
export function mergeRecords(
  local: ReadonlyArray<AddressBookRecord>,
  remote: ReadonlyArray<AddressBookRecord>,
  now: number,
): ReadonlyArray<AddressBookRecord> {
  return mergeWithReport(local, remote, now).records;
}

/** {@link mergeRecords}, also counting the live entries the cap forced out. */
export function mergeWithReport(
  local: ReadonlyArray<AddressBookRecord>,
  remote: ReadonlyArray<AddressBookRecord>,
  now: number,
): { readonly records: ReadonlyArray<AddressBookRecord>; readonly droppedLive: number } {
  const byId = new Map<string, AddressBookRecord>();
  for (const record of [...local, ...remote]) {
    const existing = byId.get(record.id);
    byId.set(record.id, existing === undefined ? record : pickWinner(existing, record));
  }
  const live = new Map<string, AddressBookRecord>();
  const kept: AddressBookRecord[] = [];
  for (const record of [...pruneTombstones([...byId.values()], now)].sort(newestFirst)) {
    if (isTombstone(record)) {
      kept.push(record);
      continue;
    }
    const key = `${record.family}:${record.address}`;
    if (!live.has(key)) {
      live.set(key, record);
      kept.push(record);
    }
  }
  const evicted = evictTombstones(kept, ADDRESS_BOOK_LIMIT);
  const bounded = evicted.slice(0, ADDRESS_BOOK_LIMIT);
  return {
    records: [...bounded].sort((a, b) => (a.id < b.id ? -1 : 1)),
    droppedLive: evicted.slice(ADDRESS_BOOK_LIMIT).filter((r) => !isTombstone(r)).length,
  };
}
