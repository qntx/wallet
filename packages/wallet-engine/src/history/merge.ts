import { lookalike } from "./flags.ts";
import type { HistoryEntry, HistoryFlag } from "./types.ts";

/** One ordered source: `next` yields the next page, oldest last, `done` at its end. */
export type Stream<T> = {
  readonly id: string;
  readonly next: () => Promise<{
    readonly items: ReadonlyArray<T>;
    readonly done: boolean;
  }>;
};

type Pooled<T> = { readonly item: T; readonly seq: number };

type StreamState<T> = {
  readonly stream: Stream<T>;
  readonly pool: Array<Pooled<T>>;
  done: boolean;
  /** The smallest key fetched so far — everything newer in this stream is already pooled. */
  oldest: number;
};

const entryKey = (entry: HistoryEntry): number => entry.timestamp ?? Number.MAX_SAFE_INTEGER;

/**
 * K-way merge over independently paging sources. An item is safe to emit once every live stream's
 * frontier passed it: until then an older item may still arrive on that stream. Emission order is
 * key descending, id ascending; ids dedupe, first fetched wins.
 */
export class OrderedMerge<T> {
  private readonly states: Array<StreamState<T>>;
  private readonly key: (t: T) => number;
  private readonly id: (t: T) => string;
  private readonly onError: (streamId: string, error: unknown) => void;
  private readonly maxFetches: number;
  private seq = 0;
  private readonly emitted = new Set<string>();

  constructor(
    streams: ReadonlyArray<Stream<T>>,
    key: (t: T) => number,
    id: (t: T) => string,
    onError: (streamId: string, error: unknown) => void,
    maxFetches = 8,
  ) {
    this.states = streams.map((stream) => ({
      stream,
      pool: [],
      done: false,
      oldest: Number.POSITIVE_INFINITY,
    }));
    this.key = key;
    this.id = id;
    this.onError = onError;
    this.maxFetches = maxFetches;
  }

  private allDone(): boolean {
    return this.states.every((s) => s.done);
  }

  private unemitted(): boolean {
    return this.states.some((s) => s.pool.some((p) => !this.emitted.has(this.id(p.item))));
  }

  /** Unemitted pooled items past the frontier: deduped, key desc then id asc. */
  private safe(frontier: number): ReadonlyArray<Pooled<T>> {
    const seen = new Set<string>();
    const items: Array<Pooled<T>> = [];
    const pooled = this.states
      .flatMap((s) => s.pool)
      .filter((p) => !this.emitted.has(this.id(p.item)))
      .sort((a, b) => a.seq - b.seq);
    for (const p of pooled) {
      const id = this.id(p.item);
      if (this.key(p.item) <= frontier || seen.has(id)) {
        continue;
      }
      seen.add(id);
      items.push(p);
    }
    items.sort((a, b) => {
      const diff = this.key(b.item) - this.key(a.item);
      if (diff !== 0) {
        return diff;
      }
      return this.id(a.item) < this.id(b.item) ? -1 : 1;
    });
    return items;
  }

  private async fetch(state: StreamState<T>): Promise<void> {
    try {
      const page = await state.stream.next();
      for (const item of page.items) {
        state.pool.push({ item, seq: this.seq });
        this.seq += 1;
      }
      if (page.items.length > 0) {
        state.oldest = Math.min(...page.items.map((item) => this.key(item)), state.oldest);
      }
      state.done = page.done;
    } catch (error) {
      this.onError(state.stream.id, error);
      state.done = true;
    }
  }

  async take(limit: number): Promise<{
    readonly items: ReadonlyArray<T>;
    readonly done: boolean;
  }> {
    let fetches = 0;
    for (;;) {
      const frontier = this.allDone()
        ? Number.NEGATIVE_INFINITY
        : Math.max(...this.states.filter((s) => !s.done).map((s) => s.oldest));
      const safe = this.safe(frontier);
      if (safe.length >= limit || this.allDone() || fetches >= this.maxFetches) {
        const out = safe.slice(0, limit).map((p) => p.item);
        for (const item of out) {
          this.emitted.add(this.id(item));
        }
        return { items: out, done: this.allDone() && !this.unemitted() };
      }
      // The streams sitting on the frontier must move before anything at it can emit.
      const targets = this.states.filter((s) => !s.done && s.oldest === frontier);
      fetches += targets.length;
      // oxlint-disable-next-line eslint/no-await-in-loop -- the next round's frontier needs this round's pages.
      await Promise.all(targets.map(async (s) => this.fetch(s)));
    }
  }
}

/**
 * The emitted chain/provider entries merged with the group's local tracked sends: a local entry
 * whose id a source also produced folds into the source entry (plus `localTxId`); a local-only
 * entry shows while it is pending, once the merge drained, or while it is newer than the oldest
 * emitted entry. `lookalike-counterparty` is (re)computed here — the known set moves with the
 * address book and tracked sends, and history counterparties never feed it.
 */
export const compose = (
  emitted: ReadonlyArray<HistoryEntry>,
  locals: ReadonlyArray<HistoryEntry>,
  known: Readonly<Record<HistoryEntry["family"], ReadonlyArray<string>>>,
  mergeDone: boolean,
): ReadonlyArray<HistoryEntry> => {
  const byId = new Map(emitted.map((entry) => [entry.id, entry]));
  const merged = new Map<string, HistoryEntry>();
  for (const entry of emitted) {
    const local = locals.find((l) => l.id === entry.id);
    merged.set(
      entry.id,
      local?.localTxId === undefined ? entry : { ...entry, localTxId: local.localTxId },
    );
  }
  let oldest = Number.POSITIVE_INFINITY;
  for (const e of emitted) {
    oldest = Math.min(oldest, entryKey(e));
  }
  for (const local of locals) {
    if (byId.has(local.id)) {
      continue;
    }
    if (
      mergeDone ||
      local.status === "pending" ||
      (local.timestamp ?? Number.MAX_SAFE_INTEGER) >= oldest
    ) {
      merged.set(local.id, local);
    }
  }
  const entries: HistoryEntry[] = [];
  for (const entry of merged.values()) {
    if (
      !entry.flags.includes("lookalike-counterparty") &&
      lookalike(entry.family, entry.counterparties, known[entry.family] ?? [])
    ) {
      entries.push({
        ...entry,
        flags: [...entry.flags, "lookalike-counterparty" satisfies HistoryFlag],
      });
    } else {
      entries.push(entry);
    }
  }
  entries.sort((a, b) => {
    const diff = entryKey(b) - entryKey(a);
    if (diff !== 0) {
      return diff;
    }
    return a.id < b.id ? -1 : 1;
  });
  return entries;
};
