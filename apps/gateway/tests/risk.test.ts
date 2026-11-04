import { describe, expect, it } from "vite-plus/test";

import {
  applyDiff,
  contains,
  decodeHashList,
  hashList,
  phishingHash,
  phishingListResponse,
} from "@qntx/wallet-engine/gateway/contract";

import { PHISHING_SOURCES } from "../src/config/phishing.ts";
import { JOURNAL_KEY, SNAPSHOT_KEY, buildPhishingList } from "../src/risk/phishing.ts";
import { expectContract, fakeFetch, gateway, headers, memoryRiskStore } from "./helpers.ts";

const [METAMASK, POLKADOT] = PHISHING_SOURCES;
const HOUR = 3_600_000;

type Lists = { deny: string[]; allow: string[] };

type Override = { metamask?: () => Response; polkadot?: () => Response };

const sourceFetch = (metamask: Lists, polkadot: Lists, override: Override) =>
  fakeFetch({
    [METAMASK?.url ?? ""]:
      override.metamask ??
      (() => Response.json({ blacklist: metamask.deny, whitelist: metamask.allow })),
    [POLKADOT?.url ?? ""]:
      override.polkadot ?? (() => Response.json({ deny: polkadot.deny, allow: polkadot.allow })),
  });

const listOf = (keys: ReadonlyArray<string>) => hashList(keys.map((key) => phishingHash(key)));

const decode = (encoded: string): Uint8Array => decodeHashList(encoded) ?? new Uint8Array();

const membership = (encoded: string, keys: ReadonlyArray<string>): string[] =>
  keys.filter((key) => contains(decode(encoded), phishingHash(key)));

const applyDelta = (base: string, delta: { add: string; remove: string }): Uint8Array =>
  applyDiff(decode(base), decode(delta.add), decode(delta.remove));

const logAt = (logs: ReadonlyArray<string>, index: number): unknown =>
  JSON.parse(logs.at(index) ?? "{}");

const journalOf = (store: ReturnType<typeof memoryRiskStore>) =>
  JSON.parse(store.data.get(JOURNAL_KEY) ?? "{}") as {
    version: number;
    entries: Array<{ version: number }>;
  };

const inOrder = async (steps: ReadonlyArray<() => Promise<void>>): Promise<void> => {
  const [step, ...rest] = steps;
  if (step !== undefined) {
    await step();
    await inOrder(rest);
  }
};

function setup() {
  const store = memoryRiskStore();
  const logs: string[] = [];
  let clock = 1_000_000_000_000;
  const build = async (
    metamask: Lists,
    polkadot: Lists,
    override: Override = {},
  ): Promise<void> => {
    const upstream = sourceFetch(metamask, polkadot, override);
    await buildPhishingList({
      fetch: upstream.fetch,
      store,
      now: () => clock,
      log: (line) => logs.push(line),
      sources: PHISHING_SOURCES,
    });
  };
  const advance = (ms: number): void => {
    clock += ms;
  };
  return { store, logs, build, advance };
}

const snapshotOf = (store: ReturnType<typeof memoryRiskStore>) =>
  JSON.parse(store.data.get(SNAPSHOT_KEY) ?? "null") as {
    version: number;
    deny: string;
    allow: string;
  };

describe("phishing list generation", () => {
  it("merges both sources, normalizes, hashes, sorts and dedupes", async () => {
    const { store, build } = setup();
    await build(
      {
        deny: ["Evil.COM", "*.scam.io", "https://dropped.com", "evil.com", "x"],
        allow: ["ok.org"],
      },
      { deny: ["evil.com", "sites.google.com/view/phish/", "other.net"], allow: ["fine.dev"] },
    );
    const snapshot = snapshotOf(store);
    expect(decodeHashList(snapshot.deny)).toStrictEqual(
      listOf(["evil.com", "scam.io", "sites.google.com/view/phish", "other.net"]),
    );
    expect(decodeHashList(snapshot.allow)).toStrictEqual(listOf(["ok.org", "fine.dev"]));
  });

  it("skips a build whose deny list shrank by more than half", async () => {
    const { store, logs, build, advance } = setup();
    const many = Array.from({ length: 10 }, (_, i) => `host${String(i)}.com`);
    await build({ deny: many, allow: [] }, { deny: [], allow: [] });
    const before = store.data.get(SNAPSHOT_KEY);
    advance(HOUR);
    await build({ deny: many.slice(0, 4), allow: [] }, { deny: [], allow: [] });
    expect(store.data.get(SNAPSHOT_KEY)).toBe(before);
    expect(logAt(logs, -1)).toMatchObject({ reason: "deny-shrank" });
  });

  it("makes no new version when the lists are unchanged", async () => {
    const { store, build, advance } = setup();
    const lists = { deny: ["a.com", "b.com"], allow: ["c.com"] };
    await build(lists, { deny: [], allow: [] });
    const snapshot = store.data.get(SNAPSHOT_KEY);
    const journal = store.data.get(JOURNAL_KEY);
    advance(HOUR);
    await build(lists, { deny: [], allow: [] });
    expect(store.data.get(SNAPSHOT_KEY)).toBe(snapshot);
    expect(store.data.get(JOURNAL_KEY)).toBe(journal);
  });

  it("prunes the journal by count", async () => {
    const { store, build, advance } = setup();
    const versions = Array.from({ length: 171 }, (_, i) =>
      Array.from({ length: i + 1 }, (_n, n) => `a${String(n)}.com`),
    );
    await inOrder(
      versions.map((deny) => async () => {
        advance(HOUR);
        await build({ deny, allow: [] }, { deny: [], allow: [] });
      }),
    );
    const journal = journalOf(store);
    expect(journal.entries).toHaveLength(168);
    expect(journal.entries.at(-1)?.version).toBe(journal.version);
    expect(journal.version).toBe(snapshotOf(store).version);
  });

  it("prunes journal entries older than seven days", async () => {
    const { store, build, advance } = setup();
    const steps = [
      { gap: 0, deny: ["a.com"] },
      { gap: 24 * HOUR, deny: ["a.com", "b.com"] },
      { gap: 24 * HOUR * 8, deny: ["a.com", "b.com", "c.com"] },
    ];
    await inOrder(
      steps.map(({ gap, deny }) => async () => {
        advance(gap);
        await build({ deny, allow: [] }, { deny: [], allow: [] });
      }),
    );
    expect(journalOf(store).entries).toHaveLength(1);
  });
});

describe("GET /v1/risk/lists/phishing", () => {
  const get = async (app: ReturnType<typeof gateway>, query = ""): Promise<Response> =>
    app.request(`/v1/risk/lists/phishing${query}`, { headers: headers() });

  async function twoVersions() {
    const ctx = setup();
    await ctx.build(
      { deny: ["a.com", "b.com", "c.com"], allow: ["w.com"] },
      { deny: [], allow: [] },
    );
    const first = snapshotOf(ctx.store);
    ctx.advance(HOUR);
    await ctx.build(
      { deny: ["a.com", "b.com", "d.com"], allow: ["w.com", "x.com"] },
      { deny: [], allow: [] },
    );
    ctx.advance(HOUR);
    await ctx.build(
      { deny: ["a.com", "c.com", "d.com", "e.com"], allow: ["x.com"] },
      { deny: [], allow: [] },
    );
    return { ...ctx, first, last: snapshotOf(ctx.store) };
  }

  it("answers 503 before any list exists", async () => {
    const app = gateway({ fetch: fakeFetch({}).fetch });
    const [plain, withSince] = await Promise.all([get(app), get(app, "?since=5")]);
    expect(plain.status).toBe(503);
    expect(withSince.status).toBe(503);
  });

  it("returns the stored snapshot string without a since", async () => {
    const { store, last } = await twoVersions();
    const app = gateway({ fetch: fakeFetch({}).fetch, risk: store });
    const res = await get(app);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expectContract(res, phishingListResponse);
    await expect(res.text()).resolves.toBe(store.data.get(SNAPSHOT_KEY));
    expect(last.version).toBeGreaterThan(0);
  });

  it("returns current for the current version", async () => {
    const { store, last } = await twoVersions();
    const app = gateway({ fetch: fakeFetch({}).fetch, risk: store });
    const res = await get(app, `?since=${String(last.version)}`);
    await expect(expectContract(res, phishingListResponse)).resolves.toStrictEqual({
      kind: "current",
      version: last.version,
    });
  });

  it("folds the journal after since into one diff that rebuilds the new snapshot", async () => {
    const { store, first, last } = await twoVersions();
    const app = gateway({ fetch: fakeFetch({}).fetch, risk: store });
    const res = await get(app, `?since=${String(first.version)}`);
    const diff = (await expectContract(res, phishingListResponse)) as {
      kind: string;
      from: number;
      version: number;
      deny: { add: string; remove: string };
      allow: { add: string; remove: string };
    };
    expect(diff).toMatchObject({ kind: "diff", from: first.version, version: last.version });
    expect(applyDelta(first.deny, diff.deny)).toStrictEqual(decodeHashList(last.deny));
    expect(applyDelta(first.allow, diff.allow)).toStrictEqual(decodeHashList(last.allow));
    const keys = ["b.com", "c.com", "d.com", "e.com"];
    expect(membership(diff.deny.add, keys)).toStrictEqual(["d.com", "e.com"]);
    expect(membership(diff.deny.remove, keys)).toStrictEqual(["b.com"]);
  });

  it("returns the snapshot for an unknown since", async () => {
    const { store } = await twoVersions();
    const app = gateway({ fetch: fakeFetch({}).fetch, risk: store });
    const res = await get(app, "?since=12345");
    await expect(res.text()).resolves.toBe(store.data.get(SNAPSHOT_KEY));
  });

  it.each(["abc", "-1", "1.5", "1234567890123456", ""])(
    "rejects since=%s with 400",
    async (since) => {
      const app = gateway({ fetch: fakeFetch({}).fetch });
      const res = await get(app, `?since=${since}`);
      expect(res.status).toBe(400);
    },
  );
});
