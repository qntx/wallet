import {
  decodeHashList,
  difference,
  encodeHashList,
  hashCount,
  hashList,
  parseWith,
  phishingCandidates,
  phishingHash,
  phishingKey,
  phishingListResponse,
} from "@qntx/wallet-engine/gateway/contract";
import type { HashList, PhishingListResponse } from "@qntx/wallet-engine/gateway/contract";

import type { PhishingEntries, PhishingSource } from "../config/phishing.ts";
import { readCapped } from "../providers/body.ts";

export const SNAPSHOT_KEY = "phishing:snapshot";
export const JOURNAL_KEY = "phishing:journal";
export const SOURCES_KEY = "phishing:sources";

const FETCH_TIMEOUT_MS = 30_000;
/** 4.4x the largest list measured (MetaMask's 3.6 MB phishing config). */
const SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const JOURNAL_MAX_AGE_MS = 7 * 24 * 3_600_000;
const JOURNAL_MAX_ENTRIES = 168;
const SHRINK_FLOOR = 0.5;
/** One hourly build adding more than this many allow keys is far beyond normal churn (87 today). */
const ALLOW_GROW_MAX = 50;

export type RiskStore = {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly put: (key: string, value: string) => Promise<void>;
};

type Diff = Extract<PhishingListResponse, { kind: "diff" }>;
type Snapshot = Extract<PhishingListResponse, { kind: "snapshot" }>;

export type JournalEntry = Omit<Diff, "kind">;
export type Journal = { readonly version: number; readonly entries: ReadonlyArray<JournalEntry> };

export type PhishingBuildOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly store: RiskStore;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly sources: ReadonlyArray<PhishingSource>;
};

/**
 * One source's normalized keys. `deny` is the effective deny: exact-key cancels stay within the
 * source, so a source can exempt its own entries but never another source's.
 */
type SourceKeys = {
  readonly id: string;
  readonly deny: ReadonlySet<string>;
  readonly allow: ReadonlySet<string>;
};

const sourceKeys = (id: string, entries: PhishingEntries): SourceKeys => {
  const allow = new Set<string>();
  for (const entry of entries.allow) {
    const key = phishingKey(entry);
    if (key !== undefined) {
      allow.add(key);
    }
  }
  const deny = new Set<string>();
  for (const entry of entries.deny) {
    const key = phishingKey(entry);
    if (key !== undefined && !allow.has(key)) {
      deny.add(key);
    }
  }
  return { id, deny, allow };
};

/**
 * The publishable allow keys: an allow entry survives only while no OTHER source effectively denies
 * any of the page candidates it would clear — the deny of another source always wins over this
 * source's allow.
 */
function publishableAllowKeys(sources: ReadonlyArray<SourceKeys>): ReadonlySet<string> {
  const allow = new Set<string>();
  for (const [index, source] of sources.entries()) {
    for (const key of source.allow) {
      const denied = sources.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          phishingCandidates(`https://${key}`).some((candidate) => other.deny.has(candidate)),
      );
      if (!denied) {
        allow.add(key);
      }
    }
  }
  return allow;
}

const delta = (before: HashList, after: HashList) => ({
  add: encodeHashList(difference(after, before)),
  remove: encodeHashList(difference(before, after)),
});

const readJson = async (store: RiskStore, key: string): Promise<unknown> => {
  const raw = await store.get(key);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export async function readJournal(store: RiskStore): Promise<Journal | undefined> {
  const json = await readJson(store, JOURNAL_KEY);
  if (typeof json !== "object" || json === null || !("version" in json) || !("entries" in json)) {
    return undefined;
  }
  const { version, entries } = json;
  if (typeof version !== "number" || !Array.isArray(entries)) {
    return undefined;
  }
  const valid: JournalEntry[] = [];
  for (const entry of entries) {
    const parsed = parseWith(phishingListResponse, { kind: "diff", ...entry });
    if (parsed?.kind !== "diff") {
      return undefined;
    }
    valid.push({
      from: parsed.from,
      version: parsed.version,
      deny: parsed.deny,
      allow: parsed.allow,
    });
  }
  return { version, entries: valid };
}

type StoredSnapshot = {
  readonly snapshot: Snapshot;
  readonly deny: HashList;
  readonly allow: HashList;
};

async function readSnapshot(store: RiskStore): Promise<StoredSnapshot | undefined> {
  const snapshot = parseWith(phishingListResponse, await readJson(store, SNAPSHOT_KEY));
  if (snapshot?.kind !== "snapshot") {
    return undefined;
  }
  const deny = decodeHashList(snapshot.deny);
  const allow = decodeHashList(snapshot.allow);
  return deny === undefined || allow === undefined ? undefined : { snapshot, deny, allow };
}

const fetchSource = async (
  source: PhishingSource,
  options: PhishingBuildOptions,
): Promise<PhishingEntries> => {
  const response = await options.fetch(source.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${source.id}: upstream status ${response.status}`);
  }
  return source.parse(JSON.parse(await readCapped(response, SOURCE_MAX_BYTES)));
};

/**
 * Fetches every source and, when the merged list changed, writes a new snapshot and journal entry.
 * Allows cancel denies only within their own source; another source's deny always wins. A failing
 * source, a source whose effective deny halved, or an allow list that grew implausibly leaves the
 * stored version alone.
 */
export async function buildPhishingList(options: PhishingBuildOptions): Promise<void> {
  const { store, now, log } = options;
  const skip = (reason: string, detail: Record<string, unknown> = {}): void => {
    log(JSON.stringify({ event: "phishing-build-skipped", reason, ...detail }));
  };

  let fetched;
  try {
    fetched = await Promise.all(
      options.sources.map(async (source) => fetchSource(source, options)),
    );
  } catch (error) {
    skip("source-failed", { error: error instanceof Error ? error.message : "unknown" });
    return;
  }
  const sources = options.sources.map((source, index) =>
    sourceKeys(source.id, fetched[index] ?? { deny: [], allow: [] }),
  );
  const deny = hashList(sources.flatMap((source) => [...source.deny]).map(phishingHash));
  const allow = hashList([...publishableAllowKeys(sources)].map(phishingHash));
  const denyB64 = encodeHashList(deny);
  const allowB64 = encodeHashList(allow);

  const previous = await readSnapshot(store);
  if (previous !== undefined) {
    const stored = await readJson(store, SOURCES_KEY);
    if (typeof stored === "object" && stored !== null) {
      for (const [id, count] of Object.entries(stored)) {
        const current = sources.find((source) => source.id === id)?.deny.size ?? 0;
        if (typeof count === "number" && current < count * SHRINK_FLOOR) {
          skip("deny-shrank", { source: id, previous: count, current });
          return;
        }
      }
    }
    const allowAdded = hashCount(difference(allow, previous.allow));
    if (allowAdded > ALLOW_GROW_MAX) {
      skip("allow-grew", { added: allowAdded, allow: hashCount(allow) });
      return;
    }
    if (denyB64 === previous.snapshot.deny && allowB64 === previous.snapshot.allow) {
      return;
    }
  }

  const at = now();
  const version = previous === undefined ? at : Math.max(at, previous.snapshot.version + 1);
  const snapshot: Snapshot = { kind: "snapshot", version, deny: denyB64, allow: allowB64 };
  const journal = previous === undefined ? undefined : await readJournal(store);
  const entries: JournalEntry[] = [
    ...(journal?.entries ?? []),
    ...(previous === undefined
      ? []
      : [
          {
            from: previous.snapshot.version,
            version,
            deny: delta(previous.deny, deny),
            allow: delta(previous.allow, allow),
          },
        ]),
  ]
    .filter((entry) => entry.version >= at - JOURNAL_MAX_AGE_MS)
    .slice(-JOURNAL_MAX_ENTRIES);

  await store.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
  await store.put(JOURNAL_KEY, JSON.stringify({ version, entries }));
  await store.put(
    SOURCES_KEY,
    JSON.stringify(Object.fromEntries(sources.map((source) => [source.id, source.deny.size]))),
  );
  log(
    JSON.stringify({
      event: "phishing-build",
      version,
      deny: hashCount(deny),
      allow: hashCount(allow),
      bytes: denyB64.length + allowB64.length,
    }),
  );
}
