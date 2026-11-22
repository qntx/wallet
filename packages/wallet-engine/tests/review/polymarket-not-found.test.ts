/**
 * PoC for finding R-5 (polymarket-not-found-unproven).
 *
 * Property that should hold: `not-found` — "the POST did not land" — is a proof, or at least a
 * durable observation, that the CLOB has no such order. The module's own contract (trade.ts) says a
 * V2 order signs no expiry and "a lost order stays submittable by whoever holds it".
 *
 * Current behaviour pinned here: `reconcile` returns `not-found` after `GET /data/order/{id}`
 * answers absent at 0/+2 s/+5 s — yet a later read can still find the same order LIVE, meaning the
 * POST had landed (or landed later) and the verdict was not a proof of non-arrival.
 *
 * These assertions pin the current behaviour: they pass today and must be revisited by the fix.
 */
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { CLOB_HOST, RELAYER_HOST } from "../../src/apps/polymarket/constants.ts";
import { createPolymarketProvider } from "../../src/apps/polymarket/provider.ts";
import type { PolymarketProvider } from "../../src/apps/polymarket/provider.ts";
import { derivePolymarketWallets } from "../../src/apps/polymarket/wallets.ts";
import type { AppGroup } from "../../src/apps/types.ts";
import type { AppAvailability } from "../../src/gateway/contract/eligibility.ts";
import { MNEMONIC, manualTimer, world } from "../apps-helpers.ts";

const API = {
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
} as const;

const ASSET = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
const CONDITION = `0x${"ab".repeat(32)}`;

const wireBook = (): Record<string, unknown> => ({
  market: CONDITION,
  asset_id: ASSET,
  timestamp: "1700000000",
  hash: "0x00",
  bids: [{ price: "0.5", size: "100" }],
  asks: [{ price: "0.55", size: "100" }],
  min_order_size: "1",
  tick_size: "0.01",
  neg_risk: false,
});

type Captured = {
  readonly url: URL;
  readonly method: string;
  readonly body?: string;
};

type FetchState = {
  /** `/book` answer. */
  book?: Record<string, unknown>;
  /** `POST /order` — status + body or a thrown Error. */
  post?: { status: number; body: unknown } | (() => never);
  /** `GET /data/order/{id}` per attempt — `"absent"` 404s, `"error"` throws. */
  orderLookup?: ReadonlyArray<{ status: number; body: unknown } | "absent" | "error">;
  /** The `orderID` the POST answer echoes. */
  orderID?: string;
};

const makeFetch = (
  state: FetchState,
  requests: Captured[],
  now: () => number,
): typeof globalThis.fetch => {
  let lookups = 0;
  return async (input, init) => {
    await Promise.resolve();
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url.origin === RELAYER_HOST && url.pathname === "/deployed") {
      return Response.json({ deployed: true });
    }
    if (url.origin !== CLOB_HOST) {
      throw new Error(`unrecorded request: ${url.toString()}`);
    }
    if (url.pathname === "/time") {
      return Response.json(Math.floor(now() / 1000));
    }
    if (url.pathname === "/book") {
      return Response.json(state.book ?? wireBook());
    }
    if (url.pathname === "/auth/ban-status/closed-only") {
      return new Response("no record", { status: 404 });
    }
    if (url.pathname.startsWith("/data/order/")) {
      const attempt = state.orderLookup?.[lookups] ?? { status: 404, body: {} };
      lookups += 1;
      if (attempt === "error") {
        throw new Error("connection reset");
      }
      if (attempt === "absent") {
        return new Response("not found", { status: 404 });
      }
      return Response.json(attempt.body, { status: attempt.status });
    }
    if (url.pathname === "/order" && init?.method === "POST") {
      const post = state.post ?? {
        status: 200,
        body: { success: true, orderID: state.orderID ?? "", status: "live" },
      };
      if (typeof post === "function") {
        return post();
      }
      return Response.json(post.body, { status: post.status });
    }
    throw new Error(`unrecorded request: ${url.toString()}`);
  };
};

type Env = {
  readonly provider: PolymarketProvider;
  readonly requests: Captured[];
  readonly timers: ReturnType<typeof manualTimer>;
  approve: (id: string) => Promise<void>;
  readonly state: FetchState;
};

let w: Awaited<ReturnType<typeof world>>;
let group: AppGroup;
const depositWallet = derivePolymarketWallets(mnemonicToAccount(MNEMONIC).address).beacon;

beforeAll(async () => {
  w = await world();
  group = { walletId: w.walletId, groupIndex: 0 };
  await w.credentials.put(group, { owner: mnemonicToAccount(MNEMONIC).address, ...API });
}, 60_000);

const env = (
  state: FetchState,
  availability: () => AppAvailability | undefined = () => "available",
): Env => {
  const requests: Captured[] = [];
  const timers = manualTimer(Date.now());
  const provider = createPolymarketProvider({
    fetch: makeFetch(state, requests, () => timers.time),
    setTimer: timers.setTimer,
    now: () => timers.time,
    wallet: w.wallet,
    credentials: w.credentials,
    requests: {
      prepare: async (input) => w.requests.prepare(input),
      outcome: async (id) => w.requests.outcome(id),
    },
    random: () => new Uint8Array(8).fill(0x11),
    availability,
    socket: () => ({
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }),
    logger: { warn: () => undefined },
  });
  return { provider, requests, timers, approve: w.approve, state };
};

/** Pump this env's timers until `promise` settles (same helper as tests/polymarket-trade.test.ts). */
const realDelay = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

const settled = async <T>(e: Pick<Env, "timers">, promise: Promise<T>): Promise<T> => {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `done` flips on settlement
  for (let i = 0; !done && i < 400; i += 1) {
    e.timers.pump();
    // oxlint-disable-next-line eslint/no-await-in-loop -- the kernel roundtrip is real IPC
    await realDelay();
  }
  return promise;
};

const orderRow = (status: string, over: Record<string, unknown> = {}) => ({
  id: `0x${"12".repeat(32)}`,
  status,
  owner: "f4f247b7-4ac7-ff29-a152-04fda0a8755a",
  maker_address: depositWallet,
  market: CONDITION,
  asset_id: ASSET,
  side: "BUY",
  original_size: "10",
  size_matched: "4",
  price: "0.52",
  expiration: "0",
  order_type: "GTC",
  created_at: 1700000000,
  ...over,
});

/** The `POST /order` captures among the recorded requests. */
const isOrderPost = (r: Captured) => r.method === "POST" && r.url.pathname === "/order";

const LIMIT_BUY = {
  kind: "limit" as const,
  assetId: ASSET,
  side: "BUY" as const,
  price: "0.52",
  size: "10",
  orderType: "GTC" as const,
};

describe("R-5: `not-found` is not a proof the POST did not land", () => {
  it("a 503 POST + three absent reads settles not-found — then the same order is readable LIVE", async () => {
    const e = env({
      post: { status: 503, body: {} },
      /* Three absent reconcile reads settle the outcome; the fourth — a later independent read —
         finds the very order the verdict says never landed. */
      orderLookup: ["absent", "absent", "absent", { status: 200, body: orderRow("LIVE") }],
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcome = await settled(e, placed.outcome);
    // The verdict the current code gives.
    expect(outcome).toStrictEqual({ kind: "not-found", orderId: placed.orderId });
    /* …but the order is there: the same `/data/order/{id}` read now returns it LIVE. A V2 order
       signs no expiry — the 503 had still committed it (or whoever held the body re-posted). */
    const after = await e.provider.account.order(group, placed.orderId);
    expect(after).toMatchObject({ id: expect.any(String) });
    const lookups = e.requests.filter((r) => r.url.pathname.startsWith("/data/order"));
    expect(lookups).toHaveLength(4);
    expect(e.requests.filter(isOrderPost)).toHaveLength(1);
  });
});
