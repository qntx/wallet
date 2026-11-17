/**
 * ED-PoC-7 — a future-dated address-book record wins last-writer-wins forever, so a poisoned
 * contact cannot be fixed or deleted from the UI.
 *
 * Exercises src/addresses/merge.ts `pickWinner` (≈17-22): pure LWW on `updatedAt` with no clamp on
 * future timestamps — a record stamped now+10y beats every local edit stamped `now` (controller.ts
 * ≈172 add, ≈185 rename, ≈199 setNote, ≈209 tombstone). The meta sync merges `doc.contacts` from
 * every wallet's document into the single shared book (src/meta/controller.ts ≈211, exportDoc
 * ≈237-243), so one poisoned document wins indefinitely.
 *
 * Scenario: local contact X "Alice" → ATTACKER after one merge of a future-dated record; a remove
 * (tombstone at now) followed by the same remote merge RESURRECTS the poisoned contact, and a
 * rename at now is reverted by the next merge too.
 */
import { describe, expect, it } from "vite-plus/test";

import { AddressBookController } from "../../src/addresses/controller.ts";
import type { AddressBookRecord } from "../../src/addresses/record.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";

const ALICE = `0x${"aa".repeat(20)}`;
const ATTACKER = `0x${"bb".repeat(20)}`;
const TEN_YEARS = 10 * 365 * 24 * 60 * 60 * 1000;

const rig = () => {
  const clock = { t: 1_000_000 };
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const book = new AddressBookController({
    openStore: async () => {
      await Promise.resolve();
      return createMemoryEngineStore(backing);
    },
    random: (n) => new Uint8Array(n).fill(1),
    now: () => clock.t,
    logger: { warn: () => undefined },
  });
  return { book, clock };
};

const poison = (id: string, createdAt: number, now: number): AddressBookRecord => ({
  id,
  name: "Alice",
  family: "evm",
  address: ATTACKER,
  createdAt,
  // Far-future stamp: wins every LWW comparison no matter when the user edits locally.
  updatedAt: now + TEN_YEARS,
});

describe("ED-PoC-7 future-dated contact wins LWW forever", () => {
  it("ED-PoC-7a: deleting the poisoned contact cannot stick — the next merge resurrects it", async () => {
    const { book, clock } = rig();
    await book.init();

    const alice = await book.add({ name: "Alice", family: "evm", address: ALICE });
    const remote = poison(alice.id, alice.createdAt, clock.t);

    // One pull merges the poisoned record: the contact silently points at the attacker.
    const first = await book.merge([remote]);
    expect(first.changed).toBe(true);
    expect(book.getState().entries[alice.id]?.address).toBe(ATTACKER);

    // The user deletes the entry — the tombstone is stamped `now`, far behind the poison.
    await book.remove(alice.id);
    expect(book.getState().entries[alice.id]).toBeUndefined();

    // …but the next pull merges the same remote record again: future > now, so the poisoned
    // contact comes back. A deletion can never out-write the future timestamp.
    const second = await book.merge([remote]);
    expect(second.changed).toBe(true);
    expect(book.getState().entries[alice.id]?.address).toBe(ATTACKER);
  });

  it("ED-PoC-7b: renaming at `now` is reverted by the same remote merge", async () => {
    const { book, clock } = rig();
    await book.init();

    const alice = await book.add({ name: "Alice", family: "evm", address: ALICE });
    const remote = poison(alice.id, alice.createdAt, clock.t);
    await book.merge([remote]);

    // The user "fixes" the entry locally — any edit is stamped `now`, always < the future.
    await book.rename(alice.id, "Alice (real)");
    expect(book.getState().entries[alice.id]?.name).toBe("Alice (real)");

    // The next pull wipes the fix: name back to the poisoned value, address still the attacker's.
    await book.merge([remote]);
    const entry = book.getState().entries[alice.id];
    expect(entry?.name).toBe("Alice");
    expect(entry?.address).toBe(ATTACKER);
  });
});
