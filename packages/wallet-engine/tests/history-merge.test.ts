/**
 * OrderedMerge and compose: k-way frontier-safe merge with dedupe, error isolation and a fetch
 * budget; local/chain fold preserving localTxId, windowed local-only entries and lookalike flags.
 */
import { describe, expect, it } from "vite-plus/test";

import { OrderedMerge, compose } from "../src/history/merge.ts";
import type { Stream } from "../src/history/merge.ts";
import type { HistoryEntry } from "../src/history/types.ts";

type Item = { id: string; key: number };

type Page = { items: Item[]; done: boolean };

const stream = (id: string, pages: Page[], calls?: { count: number }): Stream<Item> => ({
  id,
  next: async () => {
    if (calls !== undefined) {
      calls.count += 1;
    }
    const page = pages.shift();
    if (page === undefined) {
      return Promise.resolve({ items: [], done: true });
    }
    return Promise.resolve({ items: page.items, done: page.done });
  },
});

const item = (key: number, id?: string): Item => ({ id: id ?? `i${key}`, key });

const NO_KNOWN = { evm: [], solana: [], bitcoin: [], tron: [], spark: [] } as const;

const entry = (over: Partial<HistoryEntry> & Pick<HistoryEntry, "id">): HistoryEntry => ({
  family: "evm",
  network: "eip155:1",
  hash: "0xhash",
  direction: "in",
  status: "confirmed",
  counterparties: [],
  changes: [],
  verified: true,
  origin: "chain",
  flags: [],
  ...over,
});

describe("OrderedMerge", () => {
  it("interleaves three streams into globally descending pages", async () => {
    const merge = new OrderedMerge<Item>(
      [
        stream("a", [
          { items: [item(30), item(10)], done: false },
          { items: [item(5)], done: true },
        ]),
        stream("b", [
          { items: [item(25), item(20)], done: false },
          { items: [], done: true },
        ]),
        stream("c", [{ items: [item(15)], done: true }]),
      ],
      (i) => i.key,
      (i) => i.id,
      () => {},
    );
    const first = await merge.take(10);
    expect(first.items.map((i) => i.key)).toStrictEqual([30, 25, 20, 15, 10, 5]);
    expect(first.done).toBe(true);
    const second = await merge.take(10);
    expect(second.items).toStrictEqual([]);
    expect(second.done).toBe(true);
  });

  it("withholds items tied at the frontier until the stream advances", async () => {
    const aCalls = { count: 0 };
    const merge = new OrderedMerge<Item>(
      [
        stream(
          "a",
          [
            { items: [{ id: "a1", key: 100 }], done: false },
            { items: [{ id: "a2", key: 50 }], done: true },
          ],
          aCalls,
        ),
        stream("b", [{ items: [{ id: "b1", key: 100 }], done: true }]),
      ],
      (i) => i.key,
      (i) => i.id,
      () => {},
    );
    const page = await merge.take(10);
    // The key-100 tie could not be emitted until stream a fetched again past it.
    expect(aCalls.count).toBe(2);
    expect(page.items.map((i) => i.id)).toStrictEqual(["a1", "b1", "a2"]);
    expect(page.done).toBe(true);
  });

  it("dedupes the same id across streams, keeping the earlier stream's copy", async () => {
    const merge = new OrderedMerge<Item>(
      [
        stream("a", [{ items: [{ id: "x", key: 10 }], done: true }]),
        stream("b", [
          {
            items: [
              { id: "x", key: 10 },
              { id: "y", key: 9 },
            ],
            done: true,
          },
        ]),
      ],
      (i) => i.key,
      (i) => i.id,
      () => {},
    );
    const page = await merge.take(10);
    expect(page.items.map((i) => i.id)).toStrictEqual(["x", "y"]);
  });

  it("marks a throwing stream done, reports it, and keeps the rest going", async () => {
    const errors: string[] = [];
    const failing: Stream<Item> = {
      id: "bad",
      next: async () => Promise.reject(new Error("stream exploded")),
    };
    const merge = new OrderedMerge<Item>(
      [failing, stream("ok", [{ items: [item(1)], done: true }])],
      (i) => i.key,
      (i) => i.id,
      (id) => {
        errors.push(id);
      },
    );
    const page = await merge.take(10);
    expect(errors).toStrictEqual(["bad"]);
    expect(page.items.map((i) => i.id)).toStrictEqual(["i1"]);
    expect(page.done).toBe(true);
  });

  it("bounds stream fetches by maxFetches", async () => {
    const calls = { count: 0 };
    const merge = new OrderedMerge<Item>(
      [
        stream(
          "drip",
          Array.from({ length: 40 }, (_, i) => ({
            items: [{ id: `d${i}`, key: 1000 - i }],
            done: false,
          })),
          calls,
        ),
      ],
      (i) => i.key,
      (i) => i.id,
      () => {},
      8,
    );
    const page = await merge.take(10);
    expect(calls.count).toBe(8);
    expect(page.items).toHaveLength(7);
    expect(page.done).toBe(false);
  });
});

describe("compose", () => {
  it("folds local and chain entries with the same id, preserving localTxId", () => {
    const emitted = [entry({ id: "eip155:1:0xabc", timestamp: 100 })];
    const local = [
      entry({
        id: "eip155:1:0xabc",
        timestamp: 100,
        origin: "local",
        verified: false,
        localTxId: "tx-1",
      }),
    ];
    const entries = compose(emitted, local, NO_KNOWN, true);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.localTxId).toBe("tx-1");
    expect(entries[0]?.origin).toBe("chain");
  });

  it("hides local-only entries older than the emitted window until the merge is done", () => {
    const emitted = [entry({ id: "a", timestamp: 100 })];
    const local = [entry({ id: "b", timestamp: 50, origin: "local", verified: false })];
    const open = compose(emitted, local, NO_KNOWN, false);
    expect(open.map((e) => e.id)).toStrictEqual(["a"]);
    const closed = compose(emitted, local, NO_KNOWN, true);
    expect(closed.map((e) => e.id)).toStrictEqual(["a", "b"]);
  });

  it("keeps a pending local-only entry on top regardless of the window", () => {
    const emitted = [entry({ id: "a", timestamp: 100 })];
    const local = [
      entry({ id: "b", timestamp: 50, origin: "local", verified: false, status: "pending" }),
      entry({ id: "c", timestamp: 200, origin: "local", verified: false, status: "pending" }),
    ];
    const entries = compose(emitted, local, NO_KNOWN, false);
    expect(entries.map((e) => e.id)).toStrictEqual(["c", "a", "b"]);
  });

  it("adds lookalike-counterparty when a counterparty shadows a known address", () => {
    const known = { ...NO_KNOWN, evm: ["0x9845636f12345678901234567890123456173d"] };
    const emitted = [
      entry({
        id: "poison",
        counterparties: ["0x984573e312345678901234567890123456173d"],
      }),
      entry({
        id: "clean",
        counterparties: ["0x1111111111111111111111111111111111111111"],
      }),
    ];
    const entries = compose(emitted, [], known, true);
    expect(entries.find((e) => e.id === "poison")?.flags).toContain("lookalike-counterparty");
    expect(entries.find((e) => e.id === "clean")?.flags).toStrictEqual([]);
  });
});
