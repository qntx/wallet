/**
 * A `dropped`/`reorged` answer is a proof, not a poll result: every read of one poll goes to one
 * pinned upstream, and without a host endpoint the same picture must hold on three consecutive
 * polls spanning more than one solidification period (~57 s). These tests exercise the real
 * `pinnedTronCaller` over a two-provider fake gateway so the pinning is observable in the requests:
 * the first call of a poll is unpinned, its answer names the provider, and every later read of that
 * poll carries `x-gateway-provider`.
 */
import { describe, expect, it } from "vite-plus/test";

import { pinnedTronCaller } from "../src/chains/tron.ts";
import type { RouteContext, TrackedTransaction } from "../src/transactions/route.ts";
import { pollTron } from "../src/transactions/tron.ts";

const GATEWAY = "https://gateway.test";
const HOST = "https://host.test";
const NET = "tron:3448148188";
const HASH = "ab".repeat(32);
const SOLID_ID = "cd".repeat(32);
const FROM = "TLhBQ1pgDvSYVcPip5HEUcVwjp4pTg44gh";
const RAW = "0a020064";
const EXPIRATION = 1_060_000;
/** Java-tron solidifies a block once 19 of 27 witnesses produced after it — 19 × 3 s. */
const SOLIDIFY_MS = 19 * 3000;

type Node = {
  solidTime: number;
  solidNumber: number;
  fullHead: number;
  solidInfo: Record<string, unknown> | undefined;
  fullInfo: Record<string, unknown> | undefined;
  /** Paths whose next read throws a transport error. */
  failing: Set<string>;
};

const node = (over: Partial<Node> = {}): Node => ({
  solidTime: 900_000,
  solidNumber: 100,
  fullHead: 105,
  solidInfo: undefined,
  fullInfo: undefined,
  failing: new Set(),
  ...over,
});

const info = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  blockNumber: 90,
  blockTimeStamp: 880_000,
  fee: 200_000,
  receipt: { result: "SUCCESS" },
  ...over,
});

const answer = (n: Node, path: string, _body: Record<string, unknown>): unknown => {
  if (n.failing.has(path)) {
    throw new TypeError("fetch failed");
  }
  switch (path) {
    case "/walletsolidity/getnowblock":
      return {
        blockID: SOLID_ID,
        block_header: { raw_data: { number: n.solidNumber, timestamp: n.solidTime } },
      };
    case "/wallet/getnowblock":
      return {
        blockID: "ef".repeat(32),
        block_header: { raw_data: { number: n.fullHead, timestamp: 910_000 } },
      };
    case "/wallet/gettransactioninfobyid":
      return n.fullInfo ?? {};
    case "/walletsolidity/gettransactioninfobyid":
      return n.solidInfo ?? {};
    case "/wallet/broadcasthex":
      return { result: true, txid: HASH };
    default:
      throw new Error(`unmocked ${path}`);
  }
};

type World = {
  /** Provider ids the gateway routes to, by name. */
  readonly nodes: { readonly a: Node; readonly b: Node };
  /** Every node-path POST the gateway received: the routed provider and the request's pin. */
  readonly requests: Array<{ path: string; provider: string; pin: string | undefined }>;
  /** A fresh pinned caller per call — like `NetworkController.pinnedTronApi`. */
  readonly api: () => ReturnType<typeof pinnedTronCaller>;
  readonly broadcasts: string[];
  /** The world's fetch — for caller-level tests over multiple URLs. */
  readonly fetchFn: typeof globalThis.fetch;
};

const world = (): World => {
  const nodes = { a: node(), b: node() };
  const requests: World["requests"] = [];
  const broadcasts: string[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const pin = headers["x-gateway-provider"];
    const provider = pin === "node-b" ? "b" : "a"; // unpinned requests route to the first provider
    const path = new URL(String(input)).pathname;
    requests.push({ path, provider, pin });
    if (path === "/wallet/broadcasthex") {
      const broadcast = JSON.parse(String(init?.body)) as { transaction: string };
      broadcasts.push(broadcast.transaction);
    }
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return Response.json(answer(nodes[provider], path, body as Record<string, unknown>), {
      headers: { "x-gateway-providers": `node-${provider}` },
    });
  };
  /* An unpinned fallback keeps this suite runnable before the caller exists: the drop-proof
     assertions then fail on the bug itself. */
  const unpinned = {
    post: async (path: string, body: unknown) => {
      const res = await fetchFn(`${GATEWAY}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed: unknown = await res.json();
      if (parsed === null || typeof parsed !== "object") {
        throw new Error(`${path}: malformed response`);
      }
      return parsed;
    },
  };
  const makeApi = pinnedTronCaller ?? ((_: ReadonlyArray<string>) => unpinned);
  return { nodes, requests, api: () => makeApi([GATEWAY], fetchFn), broadcasts, fetchFn };
};

type Evidence = Map<string, { since: number; polls: number }>;

const NOT_NEEDED = { kind: "not-needed" };

/** A fetch that throws for any URL under `dead.url` — counting each attempt — delegating the rest. */
const deadEndpoint =
  (dead: { url: string; calls: number }, inner: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(dead.url)) {
      dead.calls += 1;
      throw new TypeError("fetch failed");
    }
    return inner(input, init);
  };

const ctx = (
  w: World,
  independent: unknown = NOT_NEEDED,
  now: () => number = () => 1_000_000,
  networks: Record<string, unknown> = {},
): RouteContext => ({
  options: {
    networks: {
      tronApi: w.api,
      pinnedTronApi: w.api,
      independentTronApi: () => independent,
      independentPinnedTronApi: () => independent,
      ...networks,
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
  tron: { expiration: EXPIRATION, from: FROM },
  raw: RAW,
  submittedAt: 1_000_000,
  error: undefined,
  ...over,
});

const ev = (): Evidence => new Map();

/** Drives `n` polls on `c` against `t`, advancing `now` by `step` before each poll after the first. */
const polls = async (
  c: RouteContext,
  t: TrackedTransaction,
  evidence: Evidence,
  clock: { t: number },
  n: number,
  step = 30_000,
): Promise<unknown> => {
  let last: unknown;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) {
      clock.t += step;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polls are sequential, order is the point
    last = await pollTron(c, t, evidence);
  }
  return last;
};

describe("a dropped answer must be proven on one upstream", () => {
  it("a single lagging-primary poll does not drop", async () => {
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1; // claims the solid head passed expiration, knows nothing
    w.nodes.b.solidInfo = info(); // the second provider knows the transaction
    const answer1 = await pollTron(ctx(w), tx(), ev());
    expect(answer1).toBeUndefined();
    expect(w.broadcasts).toHaveLength(0);
  });

  it("pins every read of a poll to the first answering provider", async () => {
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    w.nodes.b.solidInfo = info(); // would contradict — but it is never asked mid-poll
    await pollTron(ctx(w), tx(), ev());
    // solid head, solidified info, full-node info: one poll is three reads…
    const paths = w.requests.map((r) => r.path);
    expect(paths.slice(0, 3)).toStrictEqual([
      "/walletsolidity/getnowblock",
      "/walletsolidity/gettransactioninfobyid",
      "/wallet/gettransactioninfobyid",
    ]);
    // …the first unpinned, its provider id pinned on every later read
    expect(w.requests[0]?.pin).toBeUndefined();
    expect(w.requests.slice(1).map((r) => r.pin)).toStrictEqual(
      w.requests.slice(1).map(() => "node-a"),
    );
    expect(w.requests.every((r) => r.provider === "a")).toBe(true);
  });

  it("a new poll pins afresh — it may land on a different provider than the last poll", async () => {
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    await pollTron(ctx(w), tx(), ev());
    w.requests.length = 0;
    await pollTron(ctx(w), tx(), ev());
    expect(w.requests[0]?.pin).toBeUndefined(); // fresh pinned client per poll
    expect(w.requests[1]?.pin).toBe("node-a");
  });

  it("drops only after three consecutive polls spanning a solidification period", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += SOLIDIFY_MS; // a full period later — but only the second poll, the streak is too short
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 1; // third poll, span now past one period
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
    expect(clock.t).toBe(1_000_000 + SOLIDIFY_MS + 1);
    expect(w.broadcasts).toHaveLength(0);
  });

  it("two absent polls spanning a full solidification period still do not drop", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += SOLIDIFY_MS + 1; // a full period — but only the second observation
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    // The third consecutive observation completes the proof.
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });

  it("three polls inside one solidification period still do not drop", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const t = tx();
    await expect(polls(c, t, ev(), clock, 3, 5000)).resolves.toBeUndefined();
  });

  it("a solid head back under expiration resets the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.solidTime = EXPIRATION; // contrary observation: the head is inside expiration again
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.solidTime = EXPIRATION + 1;
    // the streak restarts from zero: three fresh corroborating polls over a fresh period
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 31_000; // span from the restarted since: 61 s > one period
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });

  it("a poll that sees the transaction's info ends as included, not dropped", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.solidInfo = info();
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toMatchObject({
      kind: "included",
      state: "confirmed",
    });
  });

  it("a pinned read failure neither drops nor keeps the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx();
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += SOLIDIFY_MS;
    // the pinned provider now fails mid-poll — no failover to the second provider
    w.nodes.a.failing.add("/walletsolidity/gettransactioninfobyid");
    await expect(pollTron(c, t, evidence)).rejects.toThrow(TypeError);
    w.nodes.a.failing.clear();
    // the failed read cleared the streak: it must build again from zero
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_001;
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
  });
});

describe("with a host endpoint configured", () => {
  const hostApi = (n: Node) => {
    let calls = 0;
    return {
      calls: () => calls,
      api: {
        post: async (path: string, body: unknown) => {
          calls += 1;
          await Promise.resolve();
          return answer(n, path, body as Record<string, unknown>);
        },
      },
    };
  };

  it("a host endpoint that knows the transaction is never dropped", async () => {
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const host = hostApi(node({ solidTime: EXPIRATION + 1, solidInfo: info() }));
    const independent = { kind: "available", source: "host", client: host.api };
    const c = ctx(w, independent);
    await expect(polls(c, tx(), ev(), { t: 1_000_000 }, 3)).resolves.toBeUndefined();
  });

  it("a host endpoint agreeing on the drop proves it in one poll", async () => {
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const host = hostApi(node({ solidTime: EXPIRATION + 1 }));
    const independent = { kind: "available", source: "host", client: host.api };
    const answer1 = await pollTron(ctx(w, independent), tx(), ev());
    expect(answer1).toStrictEqual({ kind: "ended", state: "dropped" });
  });

  it("a lagging host endpoint keeps the transaction submitted", async () => {
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const host = hostApi(node({ solidTime: EXPIRATION }));
    const independent = { kind: "available", source: "host", client: host.api };
    await expect(pollTron(ctx(w, independent), tx(), ev())).resolves.toBeUndefined();
  });
});

describe("a reorged answer must be proven the same way", () => {
  const included = { block: { height: 90 } as const, state: "confirmed" as const, final: false };

  it("one poll claiming a reorg no longer ends the row", async () => {
    const w = world();
    w.nodes.a.fullHead = 95; // head past the persisted block, infos empty
    const answer1 = await pollTron(ctx(w), tx({ ...included }), ev());
    expect(answer1).toBeUndefined();
  });

  it("reorgs only after three consecutive polls spanning a solidification period", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.fullHead = 95;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx({ ...included });
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += SOLIDIFY_MS;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 1;
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({ kind: "reorged" });
  });

  it("a full-node head back under the persisted block resets the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.fullHead = 95;
    const c = ctx(w, NOT_NEEDED, () => clock.t);
    const evidence = ev();
    const t = tx({ ...included });
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.fullHead = 80; // the node is just behind — not a reorg
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    w.nodes.a.fullHead = 95;
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 30_000;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 31_000;
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({ kind: "reorged" });
  });

  it("a host endpoint agreeing on the reorg proves it in one poll", async () => {
    const w = world();
    w.nodes.a.fullHead = 95;
    const host = {
      post: async (path: string, body: unknown) => {
        await Promise.resolve();
        return answer(node({ fullHead: 95 }), path, body as Record<string, unknown>);
      },
    };
    const independent = { kind: "available", source: "host", client: host };
    const answer1 = await pollTron(ctx(w, independent), tx({ ...included }), ev());
    expect(answer1).toStrictEqual({ kind: "reorged" });
  });

  it("a host endpoint that still knows the transaction blocks the reorg", async () => {
    const w = world();
    w.nodes.a.fullHead = 95;
    const host = {
      post: async (path: string, body: unknown) => {
        await Promise.resolve();
        return answer(
          node({ fullHead: 95, fullInfo: info() }),
          path,
          body as Record<string, unknown>,
        );
      },
    };
    const independent = { kind: "available", source: "host", client: host };
    await expect(pollTron(ctx(w, independent), tx({ ...included }), ev())).resolves.toBeUndefined();
  });
});

describe("the corroborator is never the pinned upstream", () => {
  it("names the answering endpoint in pinnedUrl once it commits", async () => {
    const w = world();
    const api = pinnedTronCaller([GATEWAY], w.fetchFn);
    expect(api.pinnedUrl()).toBeUndefined();
    await api.post("/walletsolidity/getnowblock", {});
    expect(api.pinnedUrl()).toBe(GATEWAY);
    /* Failover names the endpoint that answered, not the dead first one — the pin, not the
       list order, is what makes a corroborator "the same upstream". */
    const dead = { url: GATEWAY, calls: 0 };
    const failedOver = pinnedTronCaller([GATEWAY, HOST], deadEndpoint(dead, w.fetchFn));
    await failedOver.post("/walletsolidity/getnowblock", {});
    expect(dead.calls).toBe(1);
    expect(failedOver.pinnedUrl()).toBe(HOST);
  });

  it("a drop poll pinned onto the host endpoint keeps the row for the streak", async () => {
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.solidTime = EXPIRATION + 1;
    const dead = { url: GATEWAY, calls: 0 };
    /* The real failover client: the gateway dies on the poll's first read and the pin lands on
       the host URL — the same URL a host corroborator would read. */
    const api = () => pinnedTronCaller([GATEWAY, HOST], deadEndpoint(dead, w.fetchFn));
    const pins: Array<string | undefined> = [];
    const c = ctx(w, NOT_NEEDED, () => clock.t, {
      pinnedTronApi: api,
      /* The controller contract: a corroborator identical to the pinned primary is not-needed,
         so the host-only continuity rule decides instead of a second look at itself. */
      independentPinnedTronApi: (_net: string, primaryUrl: string | undefined) => {
        pins.push(primaryUrl);
        return NOT_NEEDED;
      },
    });
    const evidence = ev();
    const t = tx();
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    expect(pins).toStrictEqual([HOST]);
    /* The identical claim now earns the streak: three polls spanning more than one
       solidification period. */
    clock.t += SOLIDIFY_MS;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 1;
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
    expect(pins).toStrictEqual([HOST, HOST, HOST]);
  });

  it("a reorg poll pinned onto the host endpoint keeps the row for the streak", async () => {
    const included = { block: { height: 90 } as const, state: "confirmed" as const, final: false };
    const clock = { t: 1_000_000 };
    const w = world();
    w.nodes.a.fullHead = 95;
    const dead = { url: GATEWAY, calls: 0 };
    const api = () => pinnedTronCaller([GATEWAY, HOST], deadEndpoint(dead, w.fetchFn));
    const pins: Array<string | undefined> = [];
    const c = ctx(w, NOT_NEEDED, () => clock.t, {
      pinnedTronApi: api,
      independentPinnedTronApi: (_net: string, primaryUrl: string | undefined) => {
        pins.push(primaryUrl);
        return NOT_NEEDED;
      },
    });
    const evidence = ev();
    const t = tx({ ...included });
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    expect(pins).toStrictEqual([HOST]);
    clock.t += SOLIDIFY_MS;
    await expect(pollTron(c, t, evidence)).resolves.toBeUndefined();
    clock.t += 1;
    await expect(pollTron(c, t, evidence)).resolves.toStrictEqual({ kind: "reorged" });
    expect(pins).toStrictEqual([HOST, HOST, HOST]);
  });
});
