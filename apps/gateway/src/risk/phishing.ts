import {
  decodeHashList,
  difference,
  encodeHashList,
  hashCount,
  hashList,
  parseWith,
  phishingHash,
  phishingKey,
  phishingListResponse,
} from "@qntx/wallet-engine/gateway/contract";
import type { HashList, PhishingListResponse } from "@qntx/wallet-engine/gateway/contract";

import type { PhishingEntries, PhishingSource } from "../config/phishing.ts";

export const SNAPSHOT_KEY = "phishing:snapshot";
export const JOURNAL_KEY = "phishing:journal";

const FETCH_TIMEOUT_MS = 30_000;
const JOURNAL_MAX_AGE_MS = 7 * 24 * 3_600_000;
const JOURNAL_MAX_ENTRIES = 168;
const SHRINK_FLOOR = 0.5;

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

const hashesOf = (entries: ReadonlyArray<string>): HashList => {
  const hashes: Uint8Array[] = [];
  for (const entry of entries) {
    const key = phishingKey(entry);
    if (key !== undefined) {
      hashes.push(phishingHash(key));
    }
  }
  return hashList(hashes);
};

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
  return source.parse(await response.json());
};

/**
 * Fetches every source and, when the merged list changed, writes a new snapshot and journal entry.
 * Any failing source, or a list that shrank by more than half, leaves the stored version alone.
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
  const deny = hashesOf(fetched.flatMap((entries) => entries.deny));
  const allow = hashesOf(fetched.flatMap((entries) => entries.allow));
  const denyB64 = encodeHashList(deny);
  const allowB64 = encodeHashList(allow);

  const previous = await readSnapshot(store);
  if (previous !== undefined) {
    if (hashCount(deny) < hashCount(previous.deny) * SHRINK_FLOOR) {
      skip("deny-shrank", { previous: hashCount(previous.deny), current: hashCount(deny) });
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
