import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import { encodeSparkAddress } from "@qntx/spark";

import { AddressBookController } from "../src/addresses/controller.ts";
import { AddressBookError } from "../src/addresses/errors.ts";
import {
  ADDRESS_BOOK_LIMIT,
  MAX_CLOCK_SKEW_MS,
  TOMBSTONE_TTL_MS,
  evictTombstones,
  mergeRecords,
  mergeWithReport,
  pickWinner,
  pruneTombstones,
} from "../src/addresses/merge.ts";
import type { AddressBookEntry, AddressBookRecord } from "../src/addresses/record.ts";
import { decodeRecord } from "../src/addresses/record.ts";
import {
  META_DOC_MAX_BYTES,
  decodeMetaDoc,
  decodeMetaDocBytes,
  encodeMetaDoc,
} from "../src/meta/doc.ts";
import type { MetaDoc } from "../src/meta/doc.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const NOW = 1_800_000_000_000;

const entry = (
  id: string,
  updatedAt: number,
  over: Partial<AddressBookEntry> = {},
): AddressBookEntry => ({
  id,
  name: id,
  family: "evm",
  address: `0x${Array.from(id, (c) => c.codePointAt(0))
    .join("")
    .padStart(40, "0")}`,
  createdAt: 1,
  updatedAt,
  ...over,
});
const requireBytes = (bytes: Uint8Array | undefined): Uint8Array => {
  if (bytes === undefined) {
    throw new Error("document did not encode");
  }
  return bytes;
};
const tomb = (id: string, updatedAt: number): AddressBookRecord => ({
  id,
  deleted: true,
  updatedAt,
});

describe("pickWinner", () => {
  it.each([
    ["newer wins", entry("a", 2), entry("a", 1), 2],
    ["newer wins, reversed", entry("a", 1), entry("a", 2), 2],
    ["tombstone beats an older entry", tomb("a", 5), entry("a", 4), 5],
    ["an older tombstone does not beat a newer entry", tomb("a", 3), entry("a", 4), 4],
  ])("%s", (_name, x, y, updatedAt) => {
    expect(pickWinner(x, y).updatedAt).toBe(updatedAt);
  });

  it("breaks a tie by the larger serialization, the same either way round", () => {
    const x = entry("a", 7, { name: "alpha" });
    const y = entry("a", 7, { name: "beta" });
    expect(pickWinner(x, y)).toBe(y);
    expect(pickWinner(y, x)).toBe(y);
  });
});

describe("mergeRecords", () => {
  it("unions disjoint records, sorted by id", () => {
    const merged = mergeRecords([entry("b", 1)], [entry("a", 1)], NOW);
    expect(merged.map((r) => r.id)).toStrictEqual(["a", "b"]);
  });

  it("is last-writer-wins per id and symmetric while the identity matches", () => {
    const local = [entry("a", 5, { name: "local" })];
    const remote = [entry("a", 9, { name: "remote" })];
    expect(mergeRecords(local, remote, NOW)).toStrictEqual(mergeRecords(remote, local, NOW));
    expect(mergeRecords(local, remote, NOW)[0]).toMatchObject({ name: "remote" });
  });

  it("a remote tombstone removes a local entry whatever the stamps", () => {
    expect(mergeRecords([entry("a", NOW - 2)], [tomb("a", NOW - 1)], NOW)).toStrictEqual([
      tomb("a", NOW - 1),
    ]);
    expect(mergeRecords([entry("a", NOW - 1)], [tomb("a", NOW - 2)], NOW)).toStrictEqual([
      tomb("a", NOW - 2),
    ]);
  });

  it("a tombstone is never resurrected by a newer remote entry", () => {
    const local = tomb("a", NOW - 100);
    const remote = entry("a", NOW + 100);
    const { records, refused } = mergeWithReport([local], [remote], NOW);
    expect(records).toStrictEqual([local]);
    expect(refused).toBe(0);
  });

  it("two tombstones keep the later stamp", () => {
    const older = tomb("a", NOW - 200);
    const newer = tomb("a", NOW - 100);
    expect(mergeWithReport([older], [newer], NOW).records).toStrictEqual([newer]);
    expect(mergeWithReport([newer], [older], NOW).records).toStrictEqual([newer]);
  });

  it.each<[string, Partial<AddressBookEntry>]>([
    ["address", { address: EVM }],
    ["family", { family: "solana", address: "11111111111111111111111111111111" }],
    ["createdAt", { createdAt: 2 }],
  ])("refuses a remote entry that rewrites the %s of a local one", (_part, over) => {
    const local = entry("a", 5, { name: "local" });
    const { records, refused } = mergeWithReport([local], [entry("a", 9, over)], NOW);
    expect(records).toStrictEqual([local]);
    expect(refused).toBe(1);
  });

  it("refuses a remote entry that rewrites only the family of a local one", () => {
    const local = entry("a", 5, { name: "local" });
    // Same address and createdAt — family alone differs, so no other guard can refuse it.
    const { records, refused } = mergeWithReport(
      [local],
      [entry("a", 9, { family: "bitcoin" })],
      NOW,
    );
    expect(records).toStrictEqual([local]);
    expect(refused).toBe(1);
  });

  it("refuses a remote record stamped past the clock bound but accepts the boundary", () => {
    const { records, refused } = mergeWithReport(
      [],
      [entry("late", NOW + MAX_CLOCK_SKEW_MS + 1), entry("edge", NOW + MAX_CLOCK_SKEW_MS)],
      NOW,
    );
    expect(records).toStrictEqual([entry("edge", NOW + MAX_CLOCK_SKEW_MS)]);
    expect(refused).toBe(1);
  });

  it("drops tombstones past 90 days and keeps the boundary", () => {
    const fresh = tomb("a", NOW - TOMBSTONE_TTL_MS);
    const stale = tomb("b", NOW - TOMBSTONE_TTL_MS - 1);
    expect(pruneTombstones([fresh, stale, entry("c", 1)], NOW).map((r) => r.id)).toStrictEqual([
      "a",
      "c",
    ]);
    expect(mergeRecords([stale], [], NOW)).toStrictEqual([]);
  });

  it("keeps one live entry per (family, address): the winner", () => {
    const x = entry("a", 5, { address: EVM });
    const y = entry("b", 9, { address: EVM });
    expect(mergeRecords([x], [y], NOW)).toStrictEqual([y]);
    expect(mergeRecords([y], [x], NOW)).toStrictEqual([y]);
  });

  it("evicts the oldest tombstones first when over the cap", () => {
    const live = Array.from({ length: 100 }, (_v, i) =>
      entry(`e${String(i).padStart(3, "0")}`, 10),
    );
    const tombs = Array.from({ length: 40 }, (_v, i) =>
      tomb(`t${String(i).padStart(3, "0")}`, NOW - 1000 + i),
    );
    const merged = mergeRecords(live, tombs, NOW);
    expect(merged).toHaveLength(ADDRESS_BOOK_LIMIT);
    const keptTombs = merged.filter((r) => "deleted" in r).map((r) => r.id);
    expect(keptTombs).toHaveLength(28);
    expect(keptTombs).not.toContain("t000");
    expect(keptTombs).toContain("t039");
  });

  it("evictTombstones leaves live entries alone", () => {
    const live = Array.from({ length: 5 }, (_v, i) => entry(`e${i}`, i));
    expect(evictTombstones(live, 3)).toStrictEqual(live);
    expect(evictTombstones([...live, tomb("t", 1)], 5)).toHaveLength(5);
  });

  it("truncates to the newest records when live entries alone exceed the cap", () => {
    const live = Array.from({ length: ADDRESS_BOOK_LIMIT + 2 }, (_v, i) =>
      entry(`e${String(i).padStart(3, "0")}`, i),
    );
    const merged = mergeRecords(live, [], NOW);
    expect(merged).toHaveLength(ADDRESS_BOOK_LIMIT);
    expect(merged.map((r) => r.id)).not.toContain("e000");
  });
});

describe("decodeRecord", () => {
  it("accepts entries and tombstones and re-normalizes the address", () => {
    expect(decodeRecord({ ...entry("a", 1), address: EVM.toLowerCase() })).toMatchObject({
      address: EVM,
    });
    expect(decodeRecord(tomb("a", 1))).toStrictEqual(tomb("a", 1));
  });

  it.each([
    ["unknown key", { ...entry("a", 1), extra: 1 }],
    ["bad family", { ...entry("a", 1), family: "dogecoin" }],
    ["bad address", { ...entry("a", 1), address: "0x12" }],
    ["empty name", { ...entry("a", 1), name: "  " }],
    ["long name", { ...entry("a", 1), name: "x".repeat(33) }],
    ["long note", { ...entry("a", 1), note: "x".repeat(121) }],
    ["empty note", { ...entry("a", 1), note: "  " }],
    ["negative time", { ...entry("a", 1), updatedAt: -1 }],
    ["tombstone with extra", { ...tomb("a", 1), name: "x" }],
    ["deleted false", { id: "a", deleted: false, updatedAt: 1 }],
    ["not an object", "x"],
  ])("rejects %s", (_name, value) => {
    expect(decodeRecord(value)).toBeUndefined();
  });
});

const doc = (contacts: ReadonlyArray<AddressBookRecord>): MetaDoc => ({
  v: 2,
  wallet: { updatedAt: 0 },
  groups: [],
  contacts,
});

describe("metadata document v2", () => {
  it("round-trips contacts, entries and tombstones", () => {
    const original = doc([entry("a", 1, { note: "friend" }), tomb("b", 2)]);
    const bytes = encodeMetaDoc(original);
    expect(bytes).toBeDefined();
    expect(decodeMetaDocBytes(requireBytes(bytes))).toStrictEqual(original);
  });

  it("rejects v1 and any other version", () => {
    expect(decodeMetaDoc({ v: 2, wallet: { updatedAt: 0 }, groups: [] })).toBeUndefined();
    expect(decodeMetaDoc({ ...doc([]), v: 3 })).toBeUndefined();
  });

  it("rejects the whole document for one bad contact, a duplicate id, a missing list or too many", () => {
    expect(
      decodeMetaDoc({ ...doc([]), contacts: [{ ...entry("a", 1), address: "bad" }] }),
    ).toBeUndefined();
    expect(decodeMetaDoc(doc([entry("a", 1), entry("a", 2)]))).toBeUndefined();
    const { contacts: _omit, ...withoutContacts } = doc([]);
    expect(decodeMetaDoc(withoutContacts)).toBeUndefined();
    const many = Array.from({ length: ADDRESS_BOOK_LIMIT + 1 }, (_v, i) => entry(`e${i}`, 1));
    expect(decodeMetaDoc(doc(many))).toBeUndefined();
  });

  it("stays under the size limit with 128 maximal entries", () => {
    const fat = Array.from({ length: ADDRESS_BOOK_LIMIT }, (_v, i) =>
      entry(`contact-${String(i).padStart(16, "0")}`, NOW, {
        name: "n".repeat(32),
        note: "x".repeat(120),
        family: "spark",
        address: encodeSparkAddress({
          network: "mainnet",
          identityPublicKey: secp256k1.getPublicKey(new Uint8Array(32).fill(i + 1), true),
        }),
      }),
    );
    const bytes = encodeMetaDoc(doc(fat));
    expect(bytes).toBeDefined();
    expect(requireBytes(bytes).byteLength).toBeLessThan(META_DOC_MAX_BYTES);
  });
});

function book() {
  let n = 0;
  let t = NOW;
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const controller = new AddressBookController({
    openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
    random: (len) => {
      n += 1;
      return new Uint8Array(len).fill(n % 251);
    },
    now: () => {
      t += 1;
      return t;
    },
    logger: { warn: () => undefined },
  });
  return { controller, backing };
}

const failure = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => "ok",
    (error: unknown) => (error instanceof AddressBookError ? error.category : String(error)),
  );

describe("address book notes, tombstones and limit", () => {
  it("validates, trims and persists the note; an empty one means none", async () => {
    const { controller, backing } = book();
    await controller.init();
    const added = await controller.add({ name: "a", family: "evm", address: EVM, note: "  hi  " });
    expect(added.note).toBe("hi");
    const empty = await controller.add({
      name: "b",
      family: "solana",
      address: "11111111111111111111111111111111",
      note: "   ",
    });
    expect(empty).not.toHaveProperty("note");
    await expect(
      failure(
        controller.add({
          name: "c",
          family: "evm",
          address: `0x${"1".repeat(40)}`,
          note: "x".repeat(121),
        }),
      ),
    ).resolves.toBe("invalid-input");

    const cleared = await controller.setNote(added.id, "");
    expect(cleared).not.toHaveProperty("note");
    await controller.setNote(added.id, "again");
    controller.lock();
    const reopened = new AddressBookController({
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (len) => new Uint8Array(len),
      now: () => NOW,
      logger: { warn: () => undefined },
    });
    await reopened.init();
    expect(reopened.getState().entries[added.id]?.note).toBe("again");
  });

  it("remove leaves a tombstone in syncEntries but not in state", async () => {
    const { controller } = book();
    await controller.init();
    const added = await controller.add({ name: "a", family: "evm", address: EVM });
    await controller.remove(added.id);
    expect(controller.getState().entries).toStrictEqual({});
    expect(controller.syncEntries()).toMatchObject([{ id: added.id, deleted: true }]);
    await controller.add({ name: "a again", family: "evm", address: EVM });
  });

  it("merge applies remote changes and reports what the remote lacks", async () => {
    const { controller } = book();
    await controller.init();
    const local = await controller.add({ name: "local", family: "evm", address: EVM });
    const remote = entry("contact-remote", NOW + 10);
    const result = await controller.merge([remote]);
    expect(result).toStrictEqual({ changed: true, localNewer: true });
    expect(Object.keys(controller.getState().entries).toSorted()).toStrictEqual(
      [local.id, remote.id].toSorted(),
    );
    const again = await controller.merge(controller.syncEntries());
    expect(again).toStrictEqual({ changed: false, localNewer: false });
  });

  it("warns with the count when a merge drops live entries over the cap", async () => {
    const warnings: string[] = [];
    const warned = new AddressBookController({
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (len) => new Uint8Array(len),
      now: () => NOW,
      logger: { warn: (m) => warnings.push(m) },
    });
    await warned.init();
    const live = Array.from({ length: ADDRESS_BOOK_LIMIT + 3 }, (_v, i) =>
      entry(`e${String(i).padStart(3, "0")}`, NOW - 1000 + i, { name: "secret-name" }),
    );
    await warned.merge(live);
    expect(warned.syncEntries()).toHaveLength(ADDRESS_BOOK_LIMIT);
    expect(warnings).toStrictEqual([
      `address book sync: 3 contacts dropped, over the ${ADDRESS_BOOK_LIMIT}-record cap`,
    ]);
  });

  it("at the cap, add evicts the oldest tombstone, then fails with limit", async () => {
    const { controller } = book();
    await controller.init();
    const tombs = Array.from({ length: 2 }, (_v, i) => tomb(`t${i}`, NOW + i));
    const live = Array.from({ length: ADDRESS_BOOK_LIMIT - 2 }, (_v, i) =>
      entry(`e${String(i).padStart(3, "0")}`, NOW),
    );
    await controller.merge([...tombs, ...live]);
    expect(controller.syncEntries()).toHaveLength(ADDRESS_BOOK_LIMIT);
    await controller.add({ name: "x", family: "evm", address: EVM });
    const ids = controller.syncEntries().map((r) => r.id);
    expect(ids).not.toContain("t0");
    expect(ids).toContain("t1");
    await controller.add({
      name: "y",
      family: "solana",
      address: "11111111111111111111111111111111",
    });
    await expect(
      failure(controller.add({ name: "z", family: "evm", address: `0x${"2".repeat(40)}` })),
    ).resolves.toBe("limit");
  });
});

describe("address book merge refuses poisoned remote records", () => {
  const ALICE = `0x${"aa".repeat(20)}`;
  const ATTACKER = `0x${"bb".repeat(20)}`;
  const TEN_YEARS = 10 * 365 * 24 * 60 * 60 * 1000;

  const rig = () => {
    const clock = { t: 1_000_000 };
    const warnings: string[] = [];
    const controller = new AddressBookController({
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => new Uint8Array(n).fill(1),
      now: () => clock.t,
      logger: { warn: (m) => warnings.push(m) },
    });
    return { controller, clock, warnings };
  };

  it("keeps the local address when a same-id remote entry re-points it, and warns", async () => {
    const { controller, clock, warnings } = rig();
    await controller.init();
    const alice = await controller.add({ name: "Alice", family: "evm", address: ALICE });
    // A stamp far past the clock bound is refused before any comparison…
    await controller.merge([{ ...alice, address: ATTACKER, updatedAt: clock.t + TEN_YEARS }]);
    // …and inside the bound a rewritten address is refused as a changed identity.
    await controller.merge([
      { ...alice, address: ATTACKER, updatedAt: clock.t + MAX_CLOCK_SKEW_MS },
    ]);
    expect(controller.getState().entries[alice.id]).toStrictEqual(alice);
    expect(warnings).toStrictEqual([
      "address book sync: 1 remote records refused (future timestamp or changed address)",
      "address book sync: 1 remote records refused (future timestamp or changed address)",
    ]);
  });

  it("a remote entry never resurrects a removed contact", async () => {
    const { controller, clock } = rig();
    await controller.init();
    const alice = await controller.add({ name: "Alice", family: "evm", address: ALICE });
    await controller.remove(alice.id);
    const result = await controller.merge([{ ...alice, updatedAt: clock.t + MAX_CLOCK_SKEW_MS }]);
    expect(controller.getState().entries[alice.id]).toBeUndefined();
    expect(controller.syncEntries()).toMatchObject([{ id: alice.id, deleted: true }]);
    expect(result).toStrictEqual({ changed: false, localNewer: true });
  });

  it("a local rename stamps above the remote entry it replaces and sticks", async () => {
    const { controller, clock } = rig();
    await controller.init();
    const alice = await controller.add({ name: "Alice", family: "evm", address: ALICE });
    const remote: AddressBookEntry = {
      ...alice,
      name: "remote-name",
      updatedAt: clock.t + MAX_CLOCK_SKEW_MS,
    };
    await controller.merge([remote]);
    expect(controller.getState().entries[alice.id]?.name).toBe("remote-name");
    const renamed = await controller.rename(alice.id, "Alice");
    expect(renamed.updatedAt).toBe(remote.updatedAt + 1);
    await controller.merge([remote]);
    expect(controller.getState().entries[alice.id]?.name).toBe("Alice");
  });

  it("a local setNote stamps above the remote entry it replaces and sticks", async () => {
    const { controller, clock } = rig();
    await controller.init();
    const alice = await controller.add({ name: "Alice", family: "evm", address: ALICE });
    const remote: AddressBookEntry = {
      ...alice,
      note: "remote-note",
      updatedAt: clock.t + MAX_CLOCK_SKEW_MS,
    };
    await controller.merge([remote]);
    expect(controller.getState().entries[alice.id]?.note).toBe("remote-note");
    const edited = await controller.setNote(alice.id, "my note");
    expect(edited.updatedAt).toBe(remote.updatedAt + 1);
    await controller.merge([remote]);
    expect(controller.getState().entries[alice.id]?.note).toBe("my note");
  });

  it("a local remove stamps above the remote entry it deletes", async () => {
    const { controller, clock } = rig();
    await controller.init();
    const alice = await controller.add({ name: "Alice", family: "evm", address: ALICE });
    const remote: AddressBookEntry = {
      ...alice,
      name: "remote-name",
      updatedAt: clock.t + MAX_CLOCK_SKEW_MS,
    };
    await controller.merge([remote]);
    await controller.remove(alice.id);
    expect(controller.syncEntries().find((r) => r.id === alice.id)?.updatedAt).toBe(
      remote.updatedAt + 1,
    );
    // The remote tombstone stamped below the local one loses — the local stamp is kept.
    await controller.merge([
      { id: alice.id, deleted: true, updatedAt: clock.t + MAX_CLOCK_SKEW_MS },
    ]);
    expect(controller.syncEntries().find((r) => r.id === alice.id)?.updatedAt).toBe(
      remote.updatedAt + 1,
    );
  });
});
