/**
 * Address book: named recipients, validated and normalized per chain family, persisted in the
 * engine store and cleared from memory on lock. Request risk checks treat its addresses as known.
 */
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import { AddressBookError } from "./errors.ts";
import { normalizeAddress } from "./normalize.ts";
import type { AddressFamily } from "./normalize.ts";

export type { AddressFamily } from "./normalize.ts";

export type AddressBookEntry = {
  readonly id: string;
  readonly name: string;
  readonly family: AddressFamily;
  readonly address: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AddressBookState = {
  readonly entries: Record<string, AddressBookEntry>;
};

export type AddressBookOptions = {
  readonly openStore: () => Promise<EngineStore>;
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

const COLLECTION = "contacts";
const NAME_MAX = 32;

const FAMILIES: ReadonlySet<string> = new Set(["evm", "solana", "bitcoin", "spark"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isEntry = (value: unknown): value is AddressBookEntry =>
  isObject(value) &&
  typeof value["id"] === "string" &&
  typeof value["name"] === "string" &&
  typeof value["family"] === "string" &&
  FAMILIES.has(value["family"]) &&
  typeof value["address"] === "string" &&
  typeof value["createdAt"] === "number" &&
  typeof value["updatedAt"] === "number";

const validName = (raw: string): string => {
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new AddressBookError("invalid-input", `name must be 1 to ${NAME_MAX} characters`);
  }
  return name;
};

export class AddressBookController extends Controller<AddressBookState> {
  private readonly options: AddressBookOptions;
  private engineStore: EngineStore | undefined;

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
    const entries: Record<string, AddressBookEntry> = {};
    for (const raw of rows) {
      if (raw === undefined) {
        continue;
      }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (isEntry(parsed)) {
        entries[parsed.id] = parsed;
      } else {
        this.options.logger.warn("address book entry skipped: malformed");
      }
    }
    this.update(() => ({ entries }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.engineStore = undefined;
    this.update(() => ({ entries: {} }));
  }

  async add(params: {
    readonly name: string;
    readonly family: AddressFamily;
    readonly address: string;
  }): Promise<AddressBookEntry> {
    const store = this.requireStore();
    const name = validName(params.name);
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
    const now = this.options.now();
    const id = `contact-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const entry: AddressBookEntry = {
      id,
      name,
      family: params.family,
      address,
      createdAt: now,
      updatedAt: now,
    };
    await this.persist(store, entry);
    return entry;
  }

  async rename(id: string, name: string): Promise<AddressBookEntry> {
    const store = this.requireStore();
    const existing = this.getState().entries[id];
    if (existing === undefined) {
      throw new AddressBookError("not-found", `unknown contact ${id}`);
    }
    const entry: AddressBookEntry = {
      ...existing,
      name: validName(name),
      updatedAt: this.options.now(),
    };
    await this.persist(store, entry);
    return entry;
  }

  async remove(id: string): Promise<void> {
    const store = this.requireStore();
    if (this.getState().entries[id] === undefined) {
      throw new AddressBookError("not-found", `unknown contact ${id}`);
    }
    await store.collection(COLLECTION).delete(id);
    this.update((s) => {
      const { [id]: _removed, ...entries } = s.entries;
      return { entries };
    });
  }

  private async persist(store: EngineStore, entry: AddressBookEntry): Promise<void> {
    await store
      .collection(COLLECTION)
      .put(entry.id, new TextEncoder().encode(JSON.stringify(entry)));
    this.update((s) => ({ entries: { ...s.entries, [entry.id]: entry } }));
  }

  private requireStore(): EngineStore {
    if (this.engineStore === undefined) {
      throw new AddressBookError("locked", "the address book requires an unlocked vault");
    }
    return this.engineStore;
  }
}
