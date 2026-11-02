/**
 * Address book: named recipients, validated and normalized per chain family, persisted in the
 * engine store and cleared from memory on lock. Deletions are kept as tombstones so they reach the
 * other devices; `syncEntries`/`merge` are the whole surface the metadata sync needs. Request risk
 * checks treat its addresses as known.
 */
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import { AddressBookError } from "./errors.ts";
import { ADDRESS_BOOK_LIMIT, evictTombstones, mergeWithReport } from "./merge.ts";
import { normalizeAddress } from "./normalize.ts";
import type { AddressFamily } from "./normalize.ts";
import { cleanName, cleanNote, decodeRecord, isTombstone, NAME_MAX, NOTE_MAX } from "./record.ts";
import type { AddressBookEntry, AddressBookRecord } from "./record.ts";

export type { AddressFamily } from "./normalize.ts";
export type { AddressBookEntry, AddressBookRecord, AddressBookTombstone } from "./record.ts";

export type AddressBookState = {
  /** Live entries only; tombstones stay internal. */
  readonly entries: Record<string, AddressBookEntry>;
};

export type AddressBookOptions = {
  readonly openStore: () => Promise<EngineStore>;
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

const COLLECTION = "contacts";

const entriesOf = (records: ReadonlyArray<AddressBookRecord>): Record<string, AddressBookEntry> =>
  Object.fromEntries(records.flatMap((r) => (isTombstone(r) ? [] : [[r.id, r] as const])));

export class AddressBookController extends Controller<AddressBookState> {
  private readonly options: AddressBookOptions;
  private engineStore: EngineStore | undefined;
  /** Every record, tombstones included, by id. */
  private records = new Map<string, AddressBookRecord>();

  constructor(options: AddressBookOptions) {
    super({ name: "address-book", defaultState: () => ({ entries: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    const store = await this.options.openStore();
    this.engineStore = store;
    const collection = store.collection(COLLECTION);
    const keys = await collection.list();
    const rows = await Promise.all(keys.map(async (key) => collection.get(key)));
    const records = new Map<string, AddressBookRecord>();
    for (const raw of rows) {
      if (raw === undefined) {
        continue;
      }
      const record = decodeRecord(JSON.parse(new TextDecoder().decode(raw)));
      if (record === undefined) {
        this.options.logger.warn("address book record skipped: malformed");
      } else {
        records.set(record.id, record);
      }
    }
    this.records = records;
    this.update(() => ({ entries: entriesOf([...records.values()]) }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.engineStore = undefined;
    this.records = new Map();
    this.update(() => ({ entries: {} }));
  }

  /** Entries and tombstones, for the metadata document. */
  syncEntries(): ReadonlyArray<AddressBookRecord> {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /**
   * Merges records from another device (last writer wins, tombstones win over older entries).
   * Returns whether anything local changed and whether the merged set holds something `remote`
   * lacks, i.e. whether the remote copy needs a newer publish.
   */
  async merge(
    remote: ReadonlyArray<AddressBookRecord>,
  ): Promise<{ readonly changed: boolean; readonly localNewer: boolean }> {
    const store = this.requireStore();
    const before = JSON.stringify(this.syncEntries());
    const { records: merged, droppedLive } = mergeWithReport(
      this.syncEntries(),
      remote,
      this.options.now(),
    );
    if (droppedLive > 0) {
      this.options.logger.warn(
        `address book sync: ${droppedLive} contacts dropped, over the ${ADDRESS_BOOK_LIMIT}-record cap`,
      );
    }
    const remoteSorted = JSON.stringify([...remote].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const localNewer = JSON.stringify(merged) !== remoteSorted;
    if (JSON.stringify(merged) === before) {
      return { changed: false, localNewer };
    }
    const collection = store.collection(COLLECTION);
    const next = new Map(merged.map((r) => [r.id, r]));
    await Promise.all([
      ...merged.map(async (r) => collection.put(r.id, new TextEncoder().encode(JSON.stringify(r)))),
      ...[...this.records.keys()]
        .filter((id) => !next.has(id))
        .map(async (id) => collection.delete(id)),
    ]);
    this.records = next;
    this.update(() => ({ entries: entriesOf(merged) }));
    return { changed: true, localNewer };
  }

  async add(params: {
    readonly name: string;
    readonly family: AddressFamily;
    readonly address: string;
    readonly note?: string;
  }): Promise<AddressBookEntry> {
    const store = this.requireStore();
    const name = cleanName(params.name);
    if (name === undefined) {
      throw new AddressBookError("invalid-input", `name must be 1 to ${NAME_MAX} characters`);
    }
    const note = this.checkedNote(params.note);
    const address = normalizeAddress(params.family, params.address.trim());
    if (address === undefined) {
      throw new AddressBookError("invalid-input", `not a valid ${params.family} address`);
    }
    const duplicate = Object.values(this.getState().entries).some(
      (e) => e.family === params.family && e.address === address,
    );
    if (duplicate) {
      throw new AddressBookError("duplicate", "this address is already in the address book");
    }
    if (this.records.size >= ADDRESS_BOOK_LIMIT) {
      const kept = evictTombstones([...this.records.values()], ADDRESS_BOOK_LIMIT - 1);
      if (kept.length >= ADDRESS_BOOK_LIMIT) {
        throw new AddressBookError(
          "limit",
          `the address book holds at most ${ADDRESS_BOOK_LIMIT} contacts`,
        );
      }
      const keptIds = new Set(kept.map((r) => r.id));
      await Promise.all(
        [...this.records.keys()]
          .filter((id) => !keptIds.has(id))
          .map(async (id) => store.collection(COLLECTION).delete(id)),
      );
      this.records = new Map(kept.map((r) => [r.id, r]));
    }
    const now = this.options.now();
    const id = `contact-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const entry: AddressBookEntry = {
      id,
      name,
      family: params.family,
      address,
      ...(note === undefined ? {} : { note }),
      createdAt: now,
      updatedAt: now,
    };
    await this.persist(store, entry);
    return entry;
  }

  async rename(id: string, name: string): Promise<AddressBookEntry> {
    const store = this.requireStore();
    const existing = this.requireEntry(id);
    const cleaned = cleanName(name);
    if (cleaned === undefined) {
      throw new AddressBookError("invalid-input", `name must be 1 to ${NAME_MAX} characters`);
    }
    const entry: AddressBookEntry = { ...existing, name: cleaned, updatedAt: this.options.now() };
    await this.persist(store, entry);
    return entry;
  }

  /** Sets or clears (empty or `undefined`) the note. */
  async setNote(id: string, note: string | undefined): Promise<AddressBookEntry> {
    const store = this.requireStore();
    const existing = this.requireEntry(id);
    const cleaned = this.checkedNote(note);
    const { note: _previous, ...rest } = existing;
    const entry: AddressBookEntry = {
      ...rest,
      ...(cleaned === undefined ? {} : { note: cleaned }),
      updatedAt: this.options.now(),
    };
    await this.persist(store, entry);
    return entry;
  }

  /** Removes the entry, leaving a tombstone so other devices drop it too. */
  async remove(id: string): Promise<void> {
    const store = this.requireStore();
    this.requireEntry(id);
    await this.persist(store, { id, deleted: true, updatedAt: this.options.now() });
  }

  private checkedNote(note: string | undefined): string | undefined {
    const cleaned = cleanNote(note);
    if (!cleaned.ok) {
      throw new AddressBookError("invalid-input", `note must be at most ${NOTE_MAX} characters`);
    }
    return cleaned.note;
  }

  private requireEntry(id: string): AddressBookEntry {
    const entry = this.getState().entries[id];
    if (entry === undefined) {
      throw new AddressBookError("not-found", `unknown contact ${id}`);
    }
    return entry;
  }

  private async persist(store: EngineStore, record: AddressBookRecord): Promise<void> {
    await store
      .collection(COLLECTION)
      .put(record.id, new TextEncoder().encode(JSON.stringify(record)));
    this.records.set(record.id, record);
    this.update(() => ({ entries: entriesOf([...this.records.values()]) }));
  }

  private requireStore(): EngineStore {
    if (this.engineStore === undefined) {
      throw new AddressBookError("locked", "the address book requires an unlocked vault");
    }
    return this.engineStore;
  }
}
