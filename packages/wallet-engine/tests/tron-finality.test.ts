/**
 * `pollTron` reads in a fixed order — the solidified head first (it bounds the drop proof and the
 * rebroadcast window), then the solidified info, then the full-node info — so a transaction that
 * lands between the reads can never be proven dropped. Solidified-node inclusion is final;
 * full-node inclusion is not. An unknown transaction is rebroadcast only while the solid head is
 * inside `expiration`.
 */
import { describe, expect, it } from "vite-plus/test";

import type { PinnedTronApi, TronApi } from "../src/chains/tron.ts";
import type { RouteContext, TrackedTransaction } from "../src/transactions/route.ts";
import { pollTron } from "../src/transactions/tron.ts";

const NET = "tron:3448148188";
const HASH = "ab".repeat(32);
const SOLID_ID = "cd".repeat(32);
const FROM = "TLhBQ1pgDvSYVcPip5HEUcVwjp4pTg44gh";
const RAW = "0a020064";

type Env = {
  solidTime: number;
  solidNumber: number;
  fullHead: number;
  solidInfo: Record<string, unknown> | undefined;
  fullInfo: Record<string, unknown> | undefined;
  broadcasts: string[];
};

const env = (over: Partial<Env> = {}): Env => ({
  solidTime: 900_000,
  solidNumber: 100,
  fullHead: 105,
  solidInfo: undefined,
  fullInfo: undefined,
  broadcasts: [],
  ...over,
});

const apiOf = (e: Env): PinnedTronApi => ({
  pinnedUrl: () => "https://node.test",
  post: async (path, body) => {
    await Promise.resolve();
    const b = body as Record<string, unknown>;
    switch (path) {
      case "/walletsolidity/getnowblock":
        return {
          blockID: SOLID_ID,
          block_header: { raw_data: { number: e.solidNumber, timestamp: e.solidTime } },
        };
      case "/wallet/getnowblock":
        return {
          blockID: "ef".repeat(32),
          block_header: { raw_data: { number: e.fullHead, timestamp: 910_000 } },
        };
      case "/wallet/gettransactioninfobyid":
        return e.fullInfo ?? {};
      case "/walletsolidity/gettransactioninfobyid":
        return e.solidInfo ?? {};
      case "/wallet/broadcasthex":
        e.broadcasts.push(String(b["transaction"]));
        return { result: true, txid: HASH };
      default:
        throw new Error(`unmocked ${path}`);
    }
  },
});

/**
 * Each info round-trip takes long enough for the solidified head to cross expiration. The head read
 * at poll start bounds the drop proof — a later head must not retroactively drop.
 */
const agingApi = (e: Env): PinnedTronApi => {
  const base = apiOf(e);
  return {
    pinnedUrl: () => "https://node.test",
    post: async (path, body) => {
      await Promise.resolve();
      const answer = await base.post(path, body);
      if (path.endsWith("/gettransactioninfobyid")) {
        e.solidTime = 1_060_001;
      }
      return answer;
    },
  };
};

/** Answers `{}` for the first solidified info read, then "lands" the transaction mid-poll. */
const landingApi = (e: Env): PinnedTronApi => {
  const base = apiOf(e);
  let solidInfoCalls = 0;
  return {
    pinnedUrl: () => "https://node.test",
    post: async (path, body) => {
      await Promise.resolve();
      if (path === "/walletsolidity/gettransactioninfobyid") {
        solidInfoCalls += 1;
        if (solidInfoCalls === 1) {
          e.solidInfo = info(); // lands mid-poll — included, never dropped
        }
      }
      return base.post(path, body);
    },
  };
};

const NOT_NEEDED = { kind: "not-needed" };

const ctx = (
  e: Env,
  independent: unknown = NOT_NEEDED,
  now: () => number = () => 1_000_000,
): RouteContext => ({
  options: {
    networks: {
      tronApi: () => apiOf(e),
      pinnedTronApi: () => apiOf(e),
      independentTronApi: () => independent,
      independentPinnedTronApi: () => independent,
    } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n),
    setTimer: () => () => {},
    now,
    logger: { warn: () => {} },
  },
  transition: async (tx, next) => Promise.resolve({ ...tx, ...next }),
  track: () => {},
  txs: () => ({}),
  newId: () => "tx-test",
});

const tx = (over: Partial<TrackedTransaction> = {}): TrackedTransaction => ({
  id: "tx-1",
  family: "tron",
  network: NET,
  account: "w",
  hash: HASH,
  state: "submitted",
  intent: undefined,
  nonce: 0,
  tron: { expiration: 1_060_000, from: FROM },
  raw: RAW,
  submittedAt: 1_000_000,
  error: undefined,
  ...over,
});

const info = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  blockNumber: 90,
  blockTimeStamp: 880_000,
  fee: 200_000,
  receipt: { result: "SUCCESS" },
  ...over,
});

describe("pollTron", () => {
  it("a row without a hash ends failed", async () => {
    const e = env();
    const answer = await pollTron(ctx(e), tx({ hash: undefined }), new Map());
    expect(answer).toStrictEqual({ kind: "ended", state: "failed" });
  });

  it("full-node info yields a non-final inclusion", async () => {
    const e = env({ fullInfo: info() });
    const answer = await pollTron(ctx(e), tx(), new Map());
    expect(answer).toStrictEqual({
      kind: "included",
      state: "confirmed",
      block: { height: 90 },
      final: false,
    });
  });

  it("solidified info yields a final inclusion", async () => {
    const e = env({ solidInfo: info() });
    const answer = await pollTron(ctx(e), tx(), new Map());
    expect(answer).toStrictEqual({
      kind: "included",
      state: "confirmed",
      block: { height: 90 },
      final: true,
    });
  });

  it("an OUT_OF_ENERGY receipt fails the transaction with the burned fee", async () => {
    const e = env({
      solidInfo: info({ receipt: { result: "OUT_OF_ENERGY" }, fee: 12_345_000 }),
    });
    const answer = await pollTron(ctx(e), tx(), new Map());
    expect(answer).toStrictEqual({
      kind: "included",
      state: "failed",
      block: { height: 90 },
      final: true,
      error: "OUT_OF_ENERGY — burned 12.345000 TRX",
    });
  });

  it("an unknown transaction is rebroadcast while the solid head is inside expiration", async () => {
    const e = env();
    const answer = await pollTron(ctx(e), tx(), new Map());
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toStrictEqual([RAW]);
  });

  it("a single lagging-primary poll stops rebroadcasting but does not drop", async () => {
    const e = env({ solidTime: 1_060_001 });
    const answer = await pollTron(ctx(e), tx(), new Map());
    // One upstream's "solid head past expiration, nothing known" is a claim, not a proof.
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toHaveLength(0);
  });

  it("a solid head exactly at expiration is still inside it — no drop", async () => {
    const e = env({ solidTime: 1_060_000 }); // == tx.tron.expiration
    const answer = await pollTron(ctx(e), tx(), new Map());
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toStrictEqual([RAW]);
  });

  it("a head that ages past expiration during the info reads does not drop", async () => {
    // The drop proof is bounded by the head read at poll start, not the head as it is once the
    // info round-trips finish — reading it after them would expire a just-sent transaction.
    const e = env();
    const wrapped = agingApi(e);
    const c = ctx(e);
    const answer = await pollTron(
      {
        ...c,
        options: {
          ...c.options,
          networks: {
            tronApi: () => wrapped,
            pinnedTronApi: () => wrapped,
            independentTronApi: () => NOT_NEEDED,
            independentPinnedTronApi: () => NOT_NEEDED,
          } as never,
        },
      },
      tx(),
      new Map(),
    );
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toStrictEqual([RAW]);
  });

  it("a transaction landing between the head read and the info reads still wins inclusion", async () => {
    // solid head read says nothing known; by the time the info reads run, it has landed.
    const e = env();
    const wrapped = landingApi(e);
    const c = ctx(e);
    const answer = await pollTron(
      {
        ...c,
        options: {
          ...c.options,
          networks: {
            tronApi: () => wrapped,
            pinnedTronApi: () => wrapped,
            independentTronApi: () => NOT_NEEDED,
            independentPinnedTronApi: () => NOT_NEEDED,
          } as never,
        },
      },
      tx(),
      new Map(),
    );
    expect(answer).toStrictEqual({
      kind: "included",
      state: "confirmed",
      block: { height: 90 },
      final: true,
    });
  });

  it("one poll with both infos empty past the row's block no longer reorgs", async () => {
    const e = env({ fullHead: 95 });
    const answer = await pollTron(
      ctx(e),
      tx({ block: { height: 90 }, state: "confirmed", final: false }),
      new Map(),
    );
    expect(answer).toBeUndefined(); // a single upstream's claim needs corroboration
  });

  it("an included row still on the full node stays put", async () => {
    const e = env({ fullInfo: info() });
    const answer = await pollTron(
      ctx(e),
      tx({ block: { height: 90 }, state: "confirmed", final: false }),
      new Map(),
    );
    expect(answer).toBeUndefined(); // same state, same block — nothing changed
  });

  it("an included row absent from both nodes whose block is ahead of the head stays put", async () => {
    const e = env({ fullHead: 80 });
    const answer = await pollTron(
      ctx(e),
      tx({ block: { height: 90 }, state: "confirmed", final: false }),
      new Map(),
    );
    expect(answer).toBeUndefined(); // a node behind the persisted block proves nothing
  });

  it("a failed full-node receipt persists the failure reason", async () => {
    const e = env({
      fullInfo: info({ receipt: { result: "REVERT" }, resMessage: "726576657274" }),
    });
    const answer = await pollTron(ctx(e), tx(), new Map());
    expect(answer).toStrictEqual({
      kind: "included",
      state: "failed",
      block: { height: 90 },
      final: false,
      error: "REVERT — burned 0.200000 TRX",
    });
  });

  it("a row without raw is not rebroadcast", async () => {
    const e = env();
    const answer = await pollTron(ctx(e), tx({ raw: undefined }), new Map());
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toHaveLength(0);
  });

  it("drops only when the independent API's solid head is past expiration and it knows nothing", async () => {
    const e = env({ solidTime: 1_060_001 });
    const ie = env({ solidTime: 1_060_001 });
    const answer = await pollTron(
      ctx(e, { kind: "available", source: "host", client: apiOf(ie) }),
      tx(),
      new Map(),
    );
    expect(answer).toStrictEqual({ kind: "ended", state: "dropped" });
    expect(e.broadcasts).toHaveLength(0);
  });

  it("a lagging independent head keeps the transaction submitted", async () => {
    const e = env({ solidTime: 1_060_001 });
    const ie = env({ solidTime: 1_060_000 }); // not yet past expiration
    const answer = await pollTron(
      ctx(e, { kind: "available", source: "host", client: apiOf(ie) }),
      tx(),
      new Map(),
    );
    expect(answer).toBeUndefined();
    // Past its expiration the bytes could never land — watched, but no longer resent.
    expect(e.broadcasts).toHaveLength(0);
  });

  it("an independent node that knows the transaction keeps it submitted", async () => {
    const e = env({ solidTime: 1_060_001 });
    const ie = env({ solidTime: 1_060_001, solidInfo: info() });
    const answer = await pollTron(
      ctx(e, { kind: "available", source: "host", client: apiOf(ie) }),
      tx(),
      new Map(),
    );
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toHaveLength(0);
  });

  it("an independent read failure keeps the transaction submitted", async () => {
    const e = env({ solidTime: 1_060_001 });
    const broken: TronApi = {
      post: async () => Promise.reject(new Error("endpoint down")),
    };
    const answer = await pollTron(
      ctx(e, { kind: "available", source: "host", client: broken }),
      tx(),
      new Map(),
    );
    expect(answer).toBeUndefined();
    expect(e.broadcasts).toHaveLength(0);
  });

  it("an unavailable independent API falls back to repeated corroboration", async () => {
    let now = 1_000_000;
    const e = env({ solidTime: 1_060_001 });
    const c = ctx(e, { kind: "unavailable" }, () => now);
    const ev = new Map();
    await expect(pollTron(c, tx(), ev)).resolves.toBeUndefined();
    now += 30_000;
    await expect(pollTron(c, tx(), ev)).resolves.toBeUndefined();
    now += 30_000; // three consecutive polls spanning 60 s > one solidification period
    await expect(pollTron(c, tx(), ev)).resolves.toStrictEqual({ kind: "ended", state: "dropped" });
    expect(e.broadcasts).toHaveLength(0);
  });
});
