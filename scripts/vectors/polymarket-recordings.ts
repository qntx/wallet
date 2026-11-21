/// <reference types="node" />
/**
 * Records live Polymarket Gamma/CLOB/Data answers into
 * packages/wallet-engine/tests/fixtures/polymarket/<name>.json — `{request:{method,url}, fetchedAt,
 * response}` — so engine tests replay real wire data. Markets are picked deterministically at
 * record time from `volume24hr`: `primary` = top open non-neg-risk market, `negrisk` = top open
 * neg-risk market, `v2` = the top open `version:"v2"` market when one exists (Protocol V2 starts
 * trading 2026-11-23 — the script reports when none does rather than faking one), `closed` = the
 * top closed market that answers `/v2/resolutions` with a row.
 *
 * Run from the repo root: bun scripts/vectors/polymarket-recordings.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(ROOT, "../packages/wallet-engine/tests/fixtures/polymarket");
const MAX_BYTES = 500_000;

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

type Fixture = {
  readonly request: { readonly method: "GET"; readonly url: string };
  readonly fetchedAt: number;
  readonly response: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

async function get(url: string): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- retries are sequential with backoff
      const response = await fetch(url);
      if (response.ok) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- retries are sequential with backoff
        return await response.json();
      }
      last = new Error(`GET ${url} answered ${response.status}`);
    } catch (error) {
      last = error;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- backoff between retries
    await new Promise((_resolve) => {
      setTimeout(_resolve, 500 * (attempt + 1));
    });
  }
  throw last;
}

const save = async (
  name: string,
  url: string,
  response: Promise<unknown>,
  fetchedAt: number,
): Promise<void> => {
  const fixture: Fixture = {
    request: { method: "GET", url },
    fetchedAt,
    response: await response,
  };
  const bytes = JSON.stringify(fixture).length;
  if (bytes > MAX_BYTES) {
    throw new Error(`${name} is ${bytes} B — over the ${MAX_BYTES} B budget`);
  }
  writeFileSync(resolve(OUT, `${name}.json`), `${JSON.stringify(fixture)}\n`);
  console.log(`${name}.json ${bytes} B`);
};

type RawMarket = Record<string, unknown>;

const volume24h = (market: RawMarket): number => {
  const value = market["volume24hrClob"] ?? market["volume24hr"];
  return typeof value === "number" ? value : Number(value) || 0;
};

const isOpen = (market: RawMarket): boolean =>
  market["closed"] === false && market["active"] === true && market["acceptingOrders"] === true;

/** ClobTokenIds (v1) or positionIds (v2) — the first outcome's asset id. */
const firstAssetId = (market: RawMarket): string | undefined => {
  /* v1 markets carry sequential UMA positionIds that are NOT CLOB token ids — only v2 trades
     position ids directly. */
  if (
    market["version"] === "v2" &&
    Array.isArray(market["positionIds"]) &&
    typeof market["positionIds"][0] === "string"
  ) {
    return market["positionIds"][0];
  }
  const text = market["clobTokenIds"];
  if (typeof text === "string") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") {
        return parsed[0];
      }
    } catch {
      /* malformed JSON text */
    }
  }
  return undefined;
};

const eventSlug = (market: RawMarket): string | undefined => {
  const { events } = market;
  if (Array.isArray(events) && isRecord(events[0]) && typeof events[0]["slug"] === "string") {
    return events[0]["slug"];
  }
  return undefined;
};

type Pick = { readonly slug: string; readonly conditionId: string; readonly assetId: string };

const toPick = (market: RawMarket): Pick | undefined => {
  const { slug, conditionId } = market;
  const assetId = firstAssetId(market);
  if (typeof slug !== "string" || typeof conditionId !== "string" || assetId === undefined) {
    return undefined;
  }
  return { slug, conditionId, assetId };
};

/* Some open markets are not yet CLOB-onboarded — `/book` 404s; skip them while picking. */
const bookable = async (pick: Pick): Promise<boolean> => {
  try {
    const response = await fetch(
      `${CLOB}/book?${new URLSearchParams({ token_id: pick.assetId }).toString()}`,
    );
    return response.ok;
  } catch {
    return false;
  }
};

const pickWithBook = async (candidates: ReadonlyArray<RawMarket>): Promise<Pick | undefined> => {
  for (const market of candidates) {
    const pick = toPick(market);
    // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are probed one at a time
    if (pick !== undefined && (await bookable(pick))) {
      return pick;
    }
  }
  return undefined;
};

mkdirSync(OUT, { recursive: true });
const fetchedAt = Date.now();

/* The open-market universe, ranked by 24h volume. */
const openUrl = `${GAMMA}/markets?${new URLSearchParams({
  active: "true",
  closed: "false",
  limit: "100",
}).toString()}`;
const open = await get(openUrl);
if (!Array.isArray(open)) {
  throw new TypeError("gamma /markets answered non-array");
}
const tradeable = open.filter(isRecord).filter((m) => isOpen(m) && firstAssetId(m) !== undefined);
const byVolume = tradeable.toSorted((a, b) => volume24h(b) - volume24h(a));

const primaryMarket = byVolume.find((m) => m["negRisk"] === false && m["version"] !== "v2");
const v2Market = byVolume.find((m) => m["version"] === "v2");
console.log(
  v2Market === undefined
    ? "no open version:v2 market exists yet — V2 coverage records later"
    : `v2 market: ${String(v2Market["slug"])}`,
);

const primary = await pickWithBook(
  byVolume.filter((m) => m["negRisk"] === false && m["version"] !== "v2"),
);
const negrisk = await pickWithBook(byVolume.filter((m) => m["negRisk"] === true));
const v2 = v2Market === undefined ? null : ((await pickWithBook([v2Market])) ?? null);
if (primary === undefined || negrisk === undefined) {
  throw new Error("could not pick a primary or neg-risk market with a book");
}

/* A closed market that actually has a resolution row. */
const closedUrl = `${GAMMA}/markets?${new URLSearchParams({
  active: "false",
  closed: "true",
  limit: "50",
}).toString()}`;
const closed = await get(closedUrl);
if (!Array.isArray(closed)) {
  throw new TypeError("gamma /markets closed answered non-array");
}
let closedMarket: RawMarket | undefined;
for (const market of closed) {
  if (!isRecord(market) || typeof market["conditionId"] !== "string") {
    continue;
  }
  // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are probed one at a time
  const resolutions = await get(`${DATA}/v2/resolutions?condition=${market["conditionId"]}`);
  if (
    isRecord(resolutions) &&
    Array.isArray(resolutions["data"]) &&
    resolutions["data"].length > 0
  ) {
    closedMarket = market;
    break;
  }
}
if (closedMarket === undefined) {
  throw new Error("no closed market with a resolution row found");
}

const closedPick = toPick(closedMarket);
if (closedPick === undefined) {
  throw new Error("the closed pick is missing slug/conditionId/assetId");
}
const picks = { primary, negrisk, v2, closed: closedPick };
writeFileSync(resolve(OUT, "_picks.json"), `${JSON.stringify(picks, undefined, 2)}\n`);

/* Universe listings + the per-market reads for every picked role. */
await save("time", `${CLOB}/time`, get(`${CLOB}/time`), fetchedAt);
/* Events embed their full markets — one row is already hundreds of KB. */
await save(
  "events",
  `${GAMMA}/events?${new URLSearchParams({ closed: "false", limit: "1", order: "volume", ascending: "false" }).toString()}`,
  get(
    `${GAMMA}/events?${new URLSearchParams({ closed: "false", limit: "1", order: "volume", ascending: "false" }).toString()}`,
  ),
  fetchedAt,
);
await save(
  "markets",
  `${GAMMA}/markets?${new URLSearchParams({ closed: "false", limit: "3" }).toString()}`,
  get(`${GAMMA}/markets?${new URLSearchParams({ closed: "false", limit: "3" }).toString()}`),
  fetchedAt,
);

/* `search(query)` sends exactly `?q=` — the fixture mirrors the client's request shape. */
const slug = primary.slug.split("-")[0] ?? "polymarket";
await save(
  "search",
  `${GAMMA}/public-search?${new URLSearchParams({ q: slug }).toString()}`,
  get(`${GAMMA}/public-search?${new URLSearchParams({ q: slug }).toString()}`),
  fetchedAt,
);

const roles: ReadonlyArray<readonly [string, Pick]> = [
  ["primary", primary],
  ["negrisk", negrisk],
  ...(v2 === null ? [] : ([["v2", v2]] as const)),
  ["closed", closedPick],
];
for (const [role, pick] of roles) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- one sequential request per fixture
  await save(
    `market-${role}`,
    `${GAMMA}/markets/slug/${pick.slug}`,
    get(`${GAMMA}/markets/slug/${pick.slug}`),
    fetchedAt,
  );
  if (role !== "closed") {
    /* Closed markets are delisted — `/book` and `/clob-markets` 404 for them. */
    // oxlint-disable-next-line eslint/no-await-in-loop -- one sequential request per fixture
    await save(
      `clob-market-${role}`,
      `${CLOB}/clob-markets/${pick.conditionId}`,
      get(`${CLOB}/clob-markets/${pick.conditionId}`),
      fetchedAt,
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- one sequential request per fixture
    await save(
      `book-${role}`,
      `${CLOB}/book?${new URLSearchParams({ token_id: pick.assetId }).toString()}`,
      get(`${CLOB}/book?${new URLSearchParams({ token_id: pick.assetId }).toString()}`),
      fetchedAt,
    );
  }
}

const slugEvent = primaryMarket === undefined ? undefined : eventSlug(primaryMarket);
if (slugEvent === undefined) {
  console.log("primary market embeds no event — event fixture skipped");
} else {
  await save(
    "event",
    `${GAMMA}/events/slug/${slugEvent}`,
    get(`${GAMMA}/events/slug/${slugEvent}`),
    fetchedAt,
  );
}

await save(
  "price-primary",
  `${CLOB}/price?${new URLSearchParams({ token_id: primary.assetId, side: "BUY" }).toString()}`,
  get(
    `${CLOB}/price?${new URLSearchParams({ token_id: primary.assetId, side: "BUY" }).toString()}`,
  ),
  fetchedAt,
);
await save(
  "midpoint-primary",
  `${CLOB}/midpoint?${new URLSearchParams({ token_id: primary.assetId }).toString()}`,
  get(`${CLOB}/midpoint?${new URLSearchParams({ token_id: primary.assetId }).toString()}`),
  fetchedAt,
);
await save(
  "history-primary",
  `${CLOB}/prices-history?${new URLSearchParams({ market: primary.assetId, interval: "1w", fidelity: "60" }).toString()}`,
  get(
    `${CLOB}/prices-history?${new URLSearchParams({ market: primary.assetId, interval: "1w", fidelity: "60" }).toString()}`,
  ),
  fetchedAt,
);
await save(
  "fee-rate-primary",
  `${CLOB}/fee-rate?${new URLSearchParams({ token_id: primary.assetId }).toString()}`,
  get(`${CLOB}/fee-rate?${new URLSearchParams({ token_id: primary.assetId }).toString()}`),
  fetchedAt,
);
await save(
  "resolution-closed",
  `${DATA}/v2/resolutions?condition=${closedPick.conditionId}`,
  get(`${DATA}/v2/resolutions?condition=${closedPick.conditionId}`),
  fetchedAt,
);

/* ---------------------------------------------------- account + relayer --- */

/* One active account wallet, picked deterministically from the newest trades page: the first
   `proxy_wallet` holding ≥ 1 position anchors the fixtures; the scan (bounded at 40 candidates)
   prefers one carrying a redeemable/mergeable row and reports which it found. */
const RELAYER = "https://relayer-v2.polymarket.com";

const tradesPage = await get(`${DATA}/v2/trades?limit=500`);
if (!isRecord(tradesPage) || !Array.isArray(tradesPage["data"])) {
  throw new TypeError("data /v2/trades answered without a data array");
}
const accountCandidates: string[] = [];
for (const row of tradesPage["data"]) {
  if (
    isRecord(row) &&
    typeof row["proxy_wallet"] === "string" &&
    !accountCandidates.includes(row["proxy_wallet"])
  ) {
    accountCandidates.push(row["proxy_wallet"]);
  }
}

const positionsOf = async (wallet: string): Promise<ReadonlyArray<RawMarket>> => {
  const page = await get(`${DATA}/v2/positions?user=${wallet}&limit=50`);
  if (!isRecord(page) || !Array.isArray(page["data"])) {
    return [];
  }
  return page["data"].filter(isRecord);
};

const hasFlag = (rows: ReadonlyArray<RawMarket>): boolean =>
  rows.some((row) => row["redeemable"] === true || row["mergeable"] === true);

let accountWallet: string | undefined;
let accountFlagged = false;
for (const candidate of accountCandidates.slice(0, 40)) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are probed one at a time
  const rows = await positionsOf(candidate);
  if (rows.length === 0) {
    continue;
  }
  const flagged = hasFlag(rows);
  if (accountWallet === undefined) {
    accountWallet = candidate;
    accountFlagged = flagged;
  }
  if (flagged) {
    accountWallet = candidate;
    accountFlagged = true;
    break;
  }
}
if (accountWallet === undefined) {
  throw new Error("no recent-trades wallet holds a position");
}
console.log(
  `account wallet: ${accountWallet} (${accountFlagged ? "carries" : "no"} redeemable/mergeable row)`,
);
writeFileSync(
  resolve(OUT, "_account.json"),
  `${JSON.stringify({ wallet: accountWallet, flagged: accountFlagged }, undefined, 2)}\n`,
);

await save(
  "account-positions",
  `${DATA}/v2/positions?user=${accountWallet}&limit=50`,
  get(`${DATA}/v2/positions?user=${accountWallet}&limit=50`),
  fetchedAt,
);
await save(
  "account-value",
  `${DATA}/v2/value?user=${accountWallet}`,
  get(`${DATA}/v2/value?user=${accountWallet}`),
  fetchedAt,
);
await save(
  "account-activity",
  `${DATA}/v2/activity?user=${accountWallet}&limit=50`,
  get(`${DATA}/v2/activity?user=${accountWallet}&limit=50`),
  fetchedAt,
);
await save(
  "account-pnl",
  `${DATA}/v2/user-pnl?user=${accountWallet}`,
  get(`${DATA}/v2/user-pnl?user=${accountWallet}`),
  fetchedAt,
);
await save(
  "account-approvals",
  `${DATA}/v2/approvals?user=${accountWallet}`,
  get(`${DATA}/v2/approvals?user=${accountWallet}`),
  fetchedAt,
);

/* The picked wallet is necessarily deployed; a vanity burn address never is. */
await save(
  "relayer-deployed",
  `${RELAYER}/deployed?${new URLSearchParams({ address: accountWallet, type: "WALLET" }).toString()}`,
  get(
    `${RELAYER}/deployed?${new URLSearchParams({ address: accountWallet, type: "WALLET" }).toString()}`,
  ),
  fetchedAt,
);
const EMPTY_ADDRESS = "0x000000000000000000000000000000000000dEaD";
await save(
  "relayer-undeployed",
  `${RELAYER}/deployed?${new URLSearchParams({ address: EMPTY_ADDRESS, type: "WALLET" }).toString()}`,
  get(
    `${RELAYER}/deployed?${new URLSearchParams({ address: EMPTY_ADDRESS, type: "WALLET" }).toString()}`,
  ),
  fetchedAt,
);

/* --- Market-channel WebSocket capture: the subscribe echo plus every frame for a few seconds
   of the primary asset — replayed by tests/polymarket-live.test.ts. Needs Node ≥ 22 (global
   WebSocket) or bun. */
{
  const primaryAsset = picks.primary?.assetId;
  if (primaryAsset !== undefined) {
    const frames: unknown[] = [];
    const subscription = {
      assets_ids: [primaryAsset],
      type: "market",
      custom_feature_enabled: true,
    };
    await new Promise<void>((resolve) => {
      const socket = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
      const timer = setTimeout(() => {
        socket.close();
        resolve();
      }, 15_000);
      /* oxlint-disable unicorn/prefer-add-event-listener -- the AppSocket property-handler subset */
      socket.onopen = () => {
        socket.send(JSON.stringify(subscription));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data === "PONG") {
          return;
        }
        try {
          frames.push(JSON.parse(event.data));
        } catch {
          /* not JSON — drop */
        }
      };
      socket.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      /* oxlint-enable unicorn/prefer-add-event-listener */
    });
    await save(
      "ws-market",
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      Promise.resolve({ subscription, recordedAt: Date.now(), frames }),
      fetchedAt,
    );
    console.log(`ws-market: ${frames.length} frames`);
  }
}
