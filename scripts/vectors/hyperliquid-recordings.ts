/// <reference types="node" />
/**
 * Records live Hyperliquid info responses into
 * packages/wallet-engine/tests/fixtures/hyperliquid/<network>/<type>.json — the request body, the
 * fetch date and the raw response — so engine tests replay real wire data instead of hand-made
 * fixtures. Market reads hit the main DEX; account reads pick an active account from recentTrades
 * on BTC (ETH as fallback) per network. orderStatus is recorded twice: one known oid found in the
 * account's fills, and an unused oid for the `unknownOid` shape.
 *
 * Run from the repo root: bun scripts/vectors/hyperliquid-recordings.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = resolve(ROOT, "../packages/wallet-engine/tests/fixtures/hyperliquid");
// spotMetaAndAssetCtxs is ~370 KB on mainnet and ~1 MB on testnet — untrimmable raw;
// the budget only guards against runaway growth beyond what was recorded.
const MAX_BYTES = 1_200_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const NETWORKS = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const;

type Request = { readonly type: string; readonly [key: string]: unknown };
type Fixture = {
  readonly request: Request;
  readonly fetchedAt: number;
  readonly response: unknown;
};

async function info(base: string, request: Request): Promise<{ body: unknown; date: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- retries are sequential with backoff
      const response = await fetch(`${base}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (response.ok) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- retries are sequential with backoff
        return { body: await response.json(), date: response.headers.get("date") ?? "" };
      }
      last = new Error(`${request.type} answered ${response.status}`);
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

const save = (network: string, name: string, fixture: Fixture): void => {
  const path = resolve(OUT, network, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(fixture)}\n`);
  console.log(`${network}/${name}.json ${JSON.stringify(fixture).length} B`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recentUsers = async (base: string, coin: string): Promise<ReadonlyArray<string>> => {
  const { body } = await info(base, { type: "recentTrades", coin });
  if (!Array.isArray(body)) {
    return [];
  }
  const users = new Set<string>();
  for (const trade of body) {
    if (isRecord(trade) && Array.isArray(trade["users"])) {
      for (const user of trade["users"]) {
        if (typeof user === "string") {
          users.add(user);
        }
      }
    }
  }
  return [...users];
};

/** The first recent trader whose userFills is non-empty and small enough to keep. */
async function pickAccount(base: string): Promise<{ user: string; coin: string }> {
  for (const coin of ["BTC", "ETH"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are probed one at a time
    for (const user of await recentUsers(base, coin)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are probed one at a time
      const { body } = await info(base, { type: "userFills", user });
      const bytes = JSON.stringify(body).length;
      if (Array.isArray(body) && body.length > 0 && bytes <= 200_000) {
        return { user, coin };
      }
    }
  }
  throw new Error("no active account found");
}

/** A recorded oid from the account's own fills, or undefined when the fill list hides it. */
const fillOid = async (base: string, user: string): Promise<number | undefined> => {
  const { body } = await info(base, { type: "userFills", user });
  if (!Array.isArray(body)) {
    return undefined;
  }
  for (const fill of body) {
    if (isRecord(fill) && typeof fill["oid"] === "number") {
      return fill["oid"];
    }
  }
  return undefined;
};

async function record(network: keyof typeof NETWORKS): Promise<void> {
  const base = NETWORKS[network];
  const fetchedAt = Date.now();
  mkdirSync(resolve(OUT, network), { recursive: true });
  const post = async (name: string, request: Request): Promise<void> => {
    const { body } = await info(base, request);
    const fixture: Fixture = { request, fetchedAt, response: body };
    const bytes = JSON.stringify(fixture).length;
    if (bytes > MAX_BYTES) {
      throw new Error(`${network}/${name} is ${bytes} B — over the ${MAX_BYTES} B budget`);
    }
    save(network, name, fixture);
  };

  // Market reads.
  await post("metaAndAssetCtxs", { type: "metaAndAssetCtxs" });
  await post("spotMetaAndAssetCtxs", { type: "spotMetaAndAssetCtxs" });
  await post("l2Book", { type: "l2Book", coin: "BTC" });
  await post("candleSnapshot", {
    type: "candleSnapshot",
    req: { coin: "BTC", interval: "1h", startTime: fetchedAt - DAY, endTime: fetchedAt },
  });
  await post("recentTrades", { type: "recentTrades", coin: "BTC" });
  await post("fundingHistory", {
    type: "fundingHistory",
    coin: "BTC",
    startTime: fetchedAt - 7 * DAY,
  });
  await post("predictedFundings", { type: "predictedFundings" });
  await post("allMids", { type: "allMids" });

  // Account reads against one active account.
  const { user } = await pickAccount(base);
  const oid = await fillOid(base, user);
  const account: Record<string, unknown> = { user, oid, fetchedAt };
  await post("clearinghouseState", { type: "clearinghouseState", user });
  await post("spotClearinghouseState", { type: "spotClearinghouseState", user });
  await post("frontendOpenOrders", { type: "frontendOpenOrders", user });
  await post("userFills", { type: "userFills", user });
  await post("userFunding", {
    type: "userFunding",
    user,
    startTime: fetchedAt - 30 * DAY,
  });
  await post("portfolio", { type: "portfolio", user });
  await post("userRateLimit", { type: "userRateLimit", user });
  await post("userFees", { type: "userFees", user });
  await post("extraAgents", { type: "extraAgents", user });
  await post("maxBuilderFee", { type: "maxBuilderFee", user, builder: user });
  await post("userRole", { type: "userRole", user });
  if (oid !== undefined) {
    await post("orderStatus", { type: "orderStatus", user, oid });
  }
  await post("orderStatus-unknown", {
    type: "orderStatus",
    user,
    oid: 9_999_999_999_999,
  });
  writeFileSync(
    resolve(OUT, network, "_account.json"),
    `${JSON.stringify(account, undefined, 2)}\n`,
  );
  console.log(`${network}: account ${user}${oid === undefined ? "" : `, oid ${oid}`}`);
}

for (const network of ["mainnet", "testnet"] as const) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: same rate-limit budget
  await record(network);
}
