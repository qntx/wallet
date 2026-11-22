// oxlint-disable vitest/no-conditional-in-test -- narrowing the union/JSON payloads is inherent to
// asserting on them (same convention as lido-fork.test.ts).

/**
 * Reconcile of an unproven `POST /order` answer: every read absent or failed proves nothing — a V2
 * order signs no expiry and may surface later — so the outcome is `unknown` after a best-effort
 * `DELETE /order` cancel attempt, never `not-found`. Every `unknown` outcome is then re-reconciled
 * for ten minutes via `trade.corrections`, dropped on lock and never re-posted.
 */
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { CLOB_HOST, RELAYER_HOST } from "../src/apps/polymarket/constants.ts";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import { createPolymarketProvider } from "../src/apps/polymarket/provider.ts";
import type { PolymarketProvider } from "../src/apps/polymarket/provider.ts";
import { createPolymarketTrade } from "../src/apps/polymarket/trade.ts";
import type {
  PolymarketOrderOutcome,
  PolymarketOutcomeCorrection,
} from "../src/apps/polymarket/trade.ts";
import { derivePolymarketWallets } from "../src/apps/polymarket/wallets.ts";
import type { AppGroup } from "../src/apps/types.ts";
import type { AppAvailability } from "../src/gateway/contract/eligibility.ts";
import { MNEMONIC, VERIFY, manualTimer, until, world } from "./apps-helpers.ts";

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
  book?: Record<string, unknown>;
  post?: { status: number; body: unknown } | (() => never);
  orderLookup?: ReadonlyArray<{ status: number; body: unknown } | "absent" | "error">;
  orderID?: string;
  /** `DELETE` answers — `"error"` throws (a lost cancel attempt). */
  cancel?: { status: number; body: unknown } | "error";
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
    if (init?.method === "DELETE") {
      if (state.cancel === "error") {
        throw new Error("connection reset");
      }
      const answer = state.cancel ?? {
        status: 200,
        body: { canceled: [], not_canceled: {} },
      };
      return Response.json(answer.body, { status: answer.status });
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
  w = await world(0, { hyperliquid: false });
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

const isOrderPost = (r: Captured) => r.method === "POST" && r.url.pathname === "/order";
const isCancelDelete = (r: Captured) => r.method === "DELETE" && r.url.pathname === "/order";
const isOrderRead = (r: Captured) => r.url.pathname.startsWith("/data/order");

const LIMIT_BUY = {
  kind: "limit" as const,
  assetId: ASSET,
  side: "BUY" as const,
  price: "0.52",
  size: "10",
  orderType: "GTC" as const,
};

describe("an unproven POST outcome resolves unknown — never not-found", () => {
  it.each<
    [
      string,
      NonNullable<FetchState["cancel"]>,
      Pick<PolymarketOrderOutcome & { kind: "unknown" }, "cancel">,
    ]
  >([
    [
      "the CLOB canceled it",
      { status: 200, body: { canceled: ["auto"], not_canceled: {} } },
      { cancel: { kind: "canceled" } },
    ],
    [
      "the CLOB refuses it",
      { status: 200, body: { canceled: [], not_canceled: { auto: "still open" } } },
      { cancel: { kind: "not-canceled", reason: "still open" } },
    ],
    [
      "the CLOB lists it in neither",
      { status: 200, body: { canceled: [], not_canceled: {} } },
      { cancel: { kind: "not-canceled", reason: expect.any(String) } },
    ],
    [
      "the DELETE itself is lost",
      "error",
      { cancel: { kind: "failed", message: expect.stringContaining("connection reset") } },
    ],
  ])(
    "absent on every read → unknown, then one cancel attempt (%s)",
    { timeout: 30_000 },
    async (_name, cancel, want) => {
      const e = env({
        post: { status: 503, body: {} },
        orderLookup: ["absent", "absent", "absent"],
        cancel,
      });
      const placed = await e.provider.trade.place(group, LIMIT_BUY);
      /* `"auto"` placeholders stand for the placed id in the scripted cancel answer. */
      const answer = e.state.cancel;
      if (answer !== undefined && answer !== "error") {
        const body = JSON.stringify(answer.body)
          .replaceAll('"auto"', JSON.stringify(placed.orderId))
          .replaceAll("auto", JSON.stringify(placed.orderId));
        e.state.cancel = { status: answer.status, body: JSON.parse(body) };
      }
      await e.approve(placed.requestId);
      const outcome = await settled(e, placed.outcome);
      expect(outcome).toMatchObject({ kind: "unknown", orderId: placed.orderId, ...want });
      const deletes = e.requests.filter(isCancelDelete);
      expect(deletes).toHaveLength(1);
      expect(JSON.parse(deletes[0]?.body ?? "{}")).toStrictEqual({ orderID: placed.orderId });
      expect(e.requests.filter(isOrderPost)).toHaveLength(1);
    },
  );

  it("every read failing → unknown plus the cancel attempt", { timeout: 30_000 }, async () => {
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: ["error", "error", "error"],
      cancel: { status: 200, body: { canceled: [], not_canceled: {} } },
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcome = await settled(e, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    expect(outcome).toMatchObject({ cancel: { kind: "not-canceled" } });
    expect(e.requests.filter(isCancelDelete)).toHaveLength(1);
    expect(e.requests.filter(isOrderPost)).toHaveLength(1);
  });

  it("found LIVE settles resting — no cancel attempt", async () => {
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: ["absent", { status: 200, body: orderRow("LIVE") }, "absent"],
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    await expect(settled(e, placed.outcome)).resolves.toStrictEqual({
      kind: "resting",
      orderId: placed.orderId,
    });
    expect(e.requests.filter(isCancelDelete)).toHaveLength(0);
  });

  it("a found order with an unrecognized status stays unknown — never canceled, still reconciled", async () => {
    const corrections: PolymarketOutcomeCorrection[] = [];
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: [
        { status: 200, body: orderRow("SETTLING") },
        { status: 200, body: orderRow("LIVE") },
      ],
    });
    e.provider.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcome = await settled(e, placed.outcome);
    expect(outcome).toStrictEqual({ kind: "unknown", orderId: placed.orderId });
    expect("cancel" in outcome).toBe(false);
    /* An order known to exist is never canceled on our behalf. */
    expect(e.requests.filter(isCancelDelete)).toHaveLength(0);
    /* …but it is registered for the late reconcile — a recognizable status corrects it. */
    for (let i = 0; i < 10 && corrections.length === 0; i += 1) {
      e.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
      await realDelay();
    }
    expect(corrections).toStrictEqual([
      { group, orderId: placed.orderId, outcome: { kind: "resting", orderId: placed.orderId } },
    ]);
  });

  it("an id-mismatched 2xx reaches the same cancel-attempt handling", async () => {
    const e = env({
      post: {
        status: 200,
        body: { success: true, orderID: `0x${"ff".repeat(32)}`, status: "live" },
      },
      orderLookup: ["absent", "absent", "absent"],
      cancel: { status: 200, body: { canceled: [], not_canceled: {} } },
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcome = await settled(e, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    expect(e.requests.filter(isCancelDelete)).toHaveLength(1);
    expect(e.requests.filter(isOrderPost)).toHaveLength(1);
  });
});

describe("corrections — the late reconcile of unknown outcomes", () => {
  it("an order surfacing on a later poll emits one correction and drops the entry", async () => {
    const corrections: PolymarketOutcomeCorrection[] = [];
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: ["absent", "absent", "absent", { status: 200, body: orderRow("LIVE") }],
      cancel: { status: 200, body: { canceled: [], not_canceled: {} } },
    });
    const stop = e.provider.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    const outcome = await settled(e, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    /* The late poll re-asks every 10 s: the fourth read finds the order LIVE. */
    for (let i = 0; i < 10 && corrections.length === 0; i += 1) {
      e.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
      await realDelay();
    }
    expect(corrections).toStrictEqual([
      {
        group,
        orderId: placed.orderId,
        outcome: { kind: "resting", orderId: placed.orderId },
      },
    ]);
    const reads = e.requests.filter(isOrderRead).length;
    e.timers.pump();
    e.timers.pump();
    await realDelay();
    /* Dropped after the correction — no second emit, no further reads. */
    expect(corrections).toHaveLength(1);
    expect(e.requests.filter(isOrderRead)).toHaveLength(reads);
    stop();
  });

  it("a failed late read keeps the entry pending — the next poll re-asks", async () => {
    const corrections: PolymarketOutcomeCorrection[] = [];
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: ["absent", "absent", "absent", "error", { status: 200, body: orderRow("LIVE") }],
      cancel: { status: 200, body: { canceled: [], not_canceled: {} } },
    });
    e.provider.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    await settled(e, placed.outcome);
    /* First late poll: the read fails — the entry stays pending, no correction. */
    const reads = () => e.requests.filter(isOrderRead).length;
    const before = reads();
    e.timers.pump();
    for (let i = 0; i < 20 && reads() === before; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the probe settles over microtasks
      await realDelay();
    }
    expect(corrections).toHaveLength(0);
    /* Second poll: the order answers — the correction lands. */
    for (let i = 0; i < 10 && corrections.length === 0; i += 1) {
      e.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
      await realDelay();
    }
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.outcome).toStrictEqual({ kind: "resting", orderId: placed.orderId });
  });

  it("past the reconcile window the entry drops silently — no correction, polling stops", async () => {
    const corrections: PolymarketOutcomeCorrection[] = [];
    const rig = unitRig({});
    rig.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    const placed = await rig.trade.place(group, {
      kind: "limit",
      assetId: ASSET,
      side: "BUY",
      price: "0.51",
      size: "10",
      orderType: "GTC",
    });
    const outcome = await unitSettled(rig, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    /* 600 s window / 10 s polls — each pump pair advances one poll cycle; run past the window. */
    const started = rig.timers.time;
    for (let i = 0; rig.timers.time < started + 610_000 && i < 300; i += 1) {
      rig.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- the probe settles over microtasks
      await realDelay();
    }
    expect(corrections).toHaveLength(0);
    const reads = rig.reads.length;
    for (let i = 0; i < 6; i += 1) {
      rig.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
      await realDelay();
    }
    /* Expired entries left the poll unarmed — no further reads. */
    expect(rig.reads).toHaveLength(reads);
  });

  it("a lock clears pending and an outcome resolving in the locked gap never registers", async () => {
    const corrections: PolymarketOutcomeCorrection[] = [];
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: ["absent", "absent", "absent", { status: 200, body: orderRow("LIVE") }],
      cancel: { status: 200, body: { canceled: [], not_canceled: {} } },
    });
    e.provider.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    await settled(e, placed.outcome);
    /* Registered for late reconcile — then the vault locks and clears it. */
    await w.wallet.vault.lock();
    try {
      for (let i = 0; i < 3; i += 1) {
        e.timers.pump();
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
        await realDelay();
      }
      expect(corrections).toHaveLength(0);
      const reads = e.requests.filter(isOrderRead).length;
      e.timers.pump();
      await realDelay();
      /* No pending entry survived the lock — the poll timer is gone too. */
      expect(e.requests.filter(isOrderRead)).toHaveLength(reads);
    } finally {
      await w.wallet.vault.unlock(VERIFY);
      await until(() => w.session() !== undefined);
    }
  });

  it("unsubscribe stops delivery", async () => {
    const corrections: PolymarketOutcomeCorrection[] = [];
    const e = env({
      post: { status: 503, body: {} },
      orderLookup: ["absent", "absent", "absent", { status: 200, body: orderRow("LIVE") }],
      cancel: { status: 200, body: { canceled: [], not_canceled: {} } },
    });
    const stop = e.provider.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    stop();
    const placed = await e.provider.trade.place(group, LIMIT_BUY);
    await e.approve(placed.requestId);
    await settled(e, placed.outcome);
    for (let i = 0; i < 3; i += 1) {
      e.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
      await realDelay();
    }
    expect(corrections).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * The pending-entry machinery at unit level — 65 unknowns would need 65 kernel
 * roundtrips through the real pipeline, so these stub every option of
 * createPolymarketTrade but the reconcile path itself.
 */
const UNIT_SIGNER = mnemonicToAccount(MNEMONIC).address;

const unitRig = (over: {
  readonly order?: () => Promise<{ status: string; sizeMatched: string } | undefined>;
  readonly vault?: () => "unlocked" | "locked";
}) => {
  const timers = manualTimer(Date.now());
  const vault = over.vault ?? (() => "unlocked" as const);
  const listeners = new Set<() => void>();
  let subscribes = 0;
  const wallet = {
    subscribe: (listener: () => void) => {
      subscribes += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => ({ vault: vault(), wallets: [] }),
  };
  const fire = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const book = {
    assetId: ASSET,
    conditionId: CONDITION,
    version: "v2" as const,
    bids: [{ price: "0.5", size: "100" }],
    asks: [{ price: "0.55", size: "100" }],
    tickSize: "0.01",
    minOrderSize: "1",
    negRisk: false,
    timestamp: "1700000000",
    hash: "0x00",
  };
  const deletes: string[] = [];
  const reads: string[] = [];
  let nextId = 0;
  const trade = createPolymarketTrade({
    wallet: wallet as never,
    l2: {
      credentials: async () => Promise.resolve({ owner: UNIT_SIGNER, ...API }),
      request: async (
        _g: AppGroup,
        input: { readonly method: string; readonly path: string; readonly body?: string },
        _schema: unknown,
      ) => {
        await Promise.resolve();
        if (input.method === "DELETE" && input.path === "/order") {
          deletes.push(input.body ?? "");
          return { canceled: [], not_canceled: {} } as never;
        }
        if (input.method === "POST" && input.path === "/order") {
          throw new PolymarketError("network", "connection reset");
        }
        throw new Error(`unrecorded l2 request ${input.method} ${input.path}`);
      },
    } as never,
    account: {
      closedOnly: async () => Promise.resolve(false),
      locate: async () =>
        Promise.resolve({
          signer: UNIT_SIGNER,
          wallet: depositWallet,
          kind: "deposit-wallet" as const,
          deployed: true,
        }),
      order: async (_g: AppGroup, orderId: string) => {
        await Promise.resolve();
        reads.push(orderId);
        return over.order === undefined ? undefined : over.order();
      },
    } as never,
    markets: { book: async () => Promise.resolve(book) } as never,
    requests: {
      prepare: async () => {
        nextId += 1;
        return Promise.resolve({ id: `r-${nextId}` });
      },
      outcome: async () =>
        Promise.resolve({ kind: "evm.typed-data", signature: new Uint8Array(65) }),
    } as never,
    random: () => new Uint8Array(8).fill(0x11),
    now: () => timers.time,
    setTimer: timers.setTimer,
    availability: () => "available",
  });
  return { trade, timers, reads, deletes, fire, wallet, subscribes: () => subscribes };
};

const unitSettled = async <T>(
  rig: Pick<ReturnType<typeof unitRig>, "timers">,
  promise: Promise<T>,
): Promise<T> => {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `done` flips on settlement
  for (let i = 0; !done && i < 2000; i += 1) {
    rig.timers.pump();
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential pumps
    await realDelay();
  }
  return promise;
};

describe("corrections — the pending map", () => {
  it("the 65th unknown evicts the oldest pending entry", { timeout: 60_000 }, async () => {
    const rig = unitRig({});
    /* 65 distinct cent-aligned prices → 65 distinct order ids. Placed concurrently so all 65
       register inside one reconcile window — sequential places would age entries past it. */
    const prices = ["0.29", ...Array.from({ length: 64 }, (_, i) => (0.3 + i * 0.01).toFixed(2))];
    const placed = await Promise.all(
      prices.map(async (price) =>
        rig.trade.place(group, {
          kind: "limit",
          assetId: ASSET,
          side: "BUY",
          price,
          size: "10",
          orderType: "GTC",
        }),
      ),
    );
    await Promise.all(placed.map(async (p) => unitSettled(rig, p.outcome)));
    rig.reads.length = 0;
    for (let i = 0; i < 10 && rig.reads.length === 0; i += 1) {
      rig.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- the probes are deliberately sequential
      await realDelay();
    }
    /* 64 pending entries were re-asked — the oldest was evicted by the 65th. */
    expect(rig.reads).toHaveLength(64);
    expect(rig.reads).not.toContain(placed[0]?.orderId);
  });

  it("a lock between sign and resolve never registers the outcome", async () => {
    let locked = false;
    const rig = unitRig({ vault: () => (locked ? "locked" : "unlocked") });
    const placing = rig.trade.place(group, {
      kind: "limit",
      assetId: ASSET,
      side: "BUY",
      price: "0.51",
      size: "10",
      orderType: "GTC",
    });
    const placed = await placing;
    locked = true;
    rig.fire();
    const outcome = await unitSettled(rig, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    rig.reads.length = 0;
    rig.timers.pump();
    await realDelay();
    expect(rig.reads).toHaveLength(0);
  });

  it("a snapshot that reports locked — event never seen — never registers", async () => {
    /* The lock listener only sees transitions; a vault already locked when the outcome resolves
       must be caught by the snapshot check itself. */
    const rig = unitRig({ vault: () => "locked" });
    const placed = await rig.trade.place(group, {
      kind: "limit",
      assetId: ASSET,
      side: "BUY",
      price: "0.51",
      size: "10",
      orderType: "GTC",
    });
    const outcome = await unitSettled(rig, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    rig.reads.length = 0;
    rig.timers.pump();
    rig.timers.pump();
    await realDelay();
    expect(rig.reads).toHaveLength(0);
  });

  it("a lock+unlock cycle never lets the previous session's outcome register", async () => {
    let locked = false;
    let calls = 0;
    const rig = unitRig({
      vault: () => (locked ? "locked" : "unlocked"),
      order: async () => {
        calls += 1;
        /* The in-call reconcile's three reads answer absent; any late probe finds it LIVE. */
        return calls <= 3
          ? Promise.resolve(undefined)
          : Promise.resolve({ status: "LIVE", sizeMatched: "0" });
      },
    });
    const placed = await rig.trade.place(group, {
      kind: "limit",
      assetId: ASSET,
      side: "BUY",
      price: "0.51",
      size: "10",
      orderType: "GTC",
    });
    /* Lock then unlock inside the reconcile window — the new session must not inherit it. */
    locked = true;
    rig.fire();
    locked = false;
    const outcome = await unitSettled(rig, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    rig.reads.length = 0;
    for (let i = 0; i < 5; i += 1) {
      rig.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential late polls
      await realDelay();
    }
    expect(rig.reads).toHaveLength(0);
  });

  it("a lock mid-probe discards the in-flight read — no correction from a cleared entry", async () => {
    let resolveRead:
      | ((row: { status: string; sizeMatched: string } | undefined) => void)
      | undefined;
    let probes = 0;
    let calls = 0;
    let locked = false;
    const corrections: PolymarketOutcomeCorrection[] = [];
    const rig = unitRig({
      vault: () => (locked ? "locked" : "unlocked"),
      order: async () => {
        calls += 1;
        /* The in-call reconcile's three reads answer absent; the late probe defers. */
        if (calls <= 3) {
          return Promise.resolve(undefined);
        }
        probes += 1;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    });
    rig.trade.corrections.subscribe((c) => {
      corrections.push(c);
    });
    const placed = await rig.trade.place(group, {
      kind: "limit",
      assetId: ASSET,
      side: "BUY",
      price: "0.51",
      size: "10",
      orderType: "GTC",
    });
    const outcome = await unitSettled(rig, placed.outcome);
    expect(outcome.kind).toBe("unknown");
    /* The late poll's probe is in flight when the lock lands — its answer must not emit. The
       first pump advances time to the poll's deadline, the second fires it. */
    rig.timers.pump();
    rig.timers.pump();
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the callback bumps `probes`
    for (let i = 0; i < 20 && probes === 0; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the probe is one async hop
      await realDelay();
    }
    expect(probes).toBe(1);
    locked = true;
    rig.fire();
    resolveRead?.({ status: "LIVE", sizeMatched: "0" });
    await realDelay();
    expect(corrections).toHaveLength(0);
  });

  it("a reads-only trade never touches the wallet's subscription channel", async () => {
    const rig = unitRig({});
    await expect(
      rig.trade.quote(group, {
        kind: "limit",
        assetId: ASSET,
        side: "BUY",
        price: "0.51",
        size: "10",
        orderType: "GTC",
      }),
    ).resolves.toBeDefined();
    expect(rig.subscribes()).toBe(0);
  });
});
