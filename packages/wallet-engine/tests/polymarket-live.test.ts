/**
 * `live.book` streams the market channel over the shared socket core — heartbeat `PING`/`PONG`,
 * dynamic `{"operation":...}` frames (documented in asyncapi.json), a fresh `book` snapshot per
 * (re)connect, deltas only on top of a snapshot, `stale` on every disconnect — and `live.account`
 * streams the authenticated user channel: the stored credentials go out as the first frame, a REST
 * snapshot turns the view `live`/`stream`, `order` events upsert or remove, `trade` events debounce
 * into one trades+positions re-read, a disconnect falls back to a `stale` REST poll and a reconnect
 * returns to `stream`. Lock, missing credentials and hostile frames behave as the module contract
 * says. The recorded `ws-market.json` and the doc-example `ws-user.json` frames replay end to end.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { PolymarketAccountReads, PolymarketOrder } from "../src/apps/polymarket/account.ts";
import { USER_WS_URL } from "../src/apps/polymarket/constants.ts";
import type {
  PolymarketCredentials,
  PolymarketCredentialStore,
} from "../src/apps/polymarket/credentials.ts";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import { createPolymarketLive } from "../src/apps/polymarket/live.ts";
import type { AppSocket } from "../src/apps/socket.ts";
import { manualTimers } from "./support/timers.ts";

const ASSET = "350977769852917329387037893294763093471844346281449484439085576212613048126";
const OTHER = "8707389984558146348518634628839865856";
const WALLET = "0x9355a4bf4c8d8f9a4f9a2c11a4c1b2d3e4f56789" as `0x${string}`;
const CREDS: PolymarketCredentials = {
  owner: WALLET,
  apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2",
  secret: "lqe4ydrr/A0eL0BRYnOElaa3yNnq+wwdLj9QYXKDlKU=",
  passphrase: "test-passphrase-1",
};

const USER_FIXTURE = JSON.parse(
  readFileSync(new URL("fixtures/polymarket/ws-user.json", import.meta.url), "utf8"),
) as { response: { frames: ReadonlyArray<Record<string, unknown>> } };
const FRAMES = USER_FIXTURE.response.frames;
const PLACEMENT_ID = "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b";

type Fake = AppSocket & {
  sent: string[];
  opened: () => void;
  recv: (raw: string) => void;
  drop: () => void;
};

const sockets: Fake[] = [];
const makeSocket = (): Fake => {
  let ready = 0;
  const fake: Fake = {
    get readyState() {
      return ready;
    },
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    close() {
      ready = 3;
      this.onclose?.();
    },
    opened() {
      ready = 1;
      this.onopen?.();
    },
    recv(raw) {
      this.onmessage?.({ data: raw });
    },
    drop() {
      this.onclose?.();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  sockets.push(fake);
  return fake;
};

let vaultState = "unlocked";
const notifyLock = (): void => {
  vaultState = "locked";
  walletListener?.();
};
let walletListener: (() => void) | undefined;
const walletStub = (): Wallet =>
  ({
    getSnapshot: () => ({ vault: vaultState }),
    subscribe: (listener: () => void) => {
      walletListener = listener;
      return () => {
        walletListener = undefined;
      };
    },
  }) as unknown as Wallet;

const warns: string[] = [];
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m: string) => {
    warns.push(m);
  },
  error: () => undefined,
};

const located = {
  signer: WALLET,
  wallet: WALLET,
  kind: "deposit-wallet" as const,
  deployed: true,
};
const BASE_ORDER: PolymarketOrder = {
  id: "0xbase",
  status: "LIVE",
  conditionId: `0x${"c".repeat(64)}`,
  assetId: "1",
  side: "BUY",
  price: "0.5",
  originalSize: "5",
  sizeMatched: "0",
  orderType: "GTC",
  expiration: "0",
  createdAt: 1,
  makerAddress: WALLET,
};

let accountBehavior: "ok" | "fail" | "unlock" | "not-enabled" = "ok";
const calls = { locate: 0, openOrders: 0, positions: 0, trades: 0 };
const accountStub = (): PolymarketAccountReads =>
  ({
    locate: async () => {
      await Promise.resolve();
      calls.locate += 1;
      if (accountBehavior === "unlock") {
        throw new PolymarketError("unlock-required", "locked");
      }
      return located;
    },
    openOrders: async () => {
      await Promise.resolve();
      calls.openOrders += 1;
      if (accountBehavior === "fail") {
        throw new PolymarketError("unavailable", "boom");
      }
      return { items: [BASE_ORDER] };
    },
    positions: async () => {
      await Promise.resolve();
      calls.positions += 1;
      if (accountBehavior === "fail") {
        throw new PolymarketError("unavailable", "boom");
      }
      if (accountBehavior === "not-enabled") {
        throw new PolymarketError("not-enabled", "no creds");
      }
      return { items: [] };
    },
    trades: async () => {
      await Promise.resolve();
      calls.trades += 1;
      if (accountBehavior === "fail") {
        throw new PolymarketError("unavailable", "boom");
      }
      return { items: [] };
    },
  }) as unknown as PolymarketAccountReads;

let credsGet: () => Promise<PolymarketCredentials | undefined>;
const credentialsStub = (): PolymarketCredentialStore => ({
  get: async () => credsGet(),
  put: async () => {
    await Promise.resolve();
  },
  delete: async () => {
    await Promise.resolve();
  },
  groups: async () => {
    await Promise.resolve();
    return [];
  },
});

/* The account poll awaits locate → two reads — a handful of microtask turns settles it. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each turn must settle before the next.
    await Promise.resolve();
  }
};

let lastUrl = "";
const setup = () => {
  sockets.length = 0;
  warns.length = 0;
  lastUrl = "";
  calls.locate = 0;
  calls.openOrders = 0;
  calls.positions = 0;
  calls.trades = 0;
  accountBehavior = "ok";
  vaultState = "unlocked";
  credsGet = async () => {
    await Promise.resolve();
    return CREDS;
  };
  const timers = manualTimers();
  const live = createPolymarketLive({
    account: accountStub(),
    credentials: credentialsStub(),
    socket: (url) => {
      lastUrl = url;
      return makeSocket();
    },
    setTimer: timers.setTimer,
    now: () => 1000,
    random: () => new Uint8Array([0]),
    wallet: walletStub(),
    logger,
  });
  return { live, timers };
};

const bookFrame = (assetId = ASSET) =>
  JSON.stringify({
    event_type: "book",
    asset_id: assetId,
    market: `0x${"a".repeat(64)}`,
    bids: [
      { price: "0.40", size: "10" },
      { price: "0.49", size: "20" },
    ],
    asks: [
      { price: "0.52", size: "30" },
      { price: "0.60", size: "5" },
    ],
    timestamp: "1795270107046",
    hash: "abc",
    tick_size: "0.01",
  });

const priceChange = (
  changes: Array<{ asset_id: string; price: string; size: string; side: string }>,
) =>
  JSON.stringify({
    event_type: "price_change",
    market: `0x${"a".repeat(64)}`,
    price_changes: changes,
    timestamp: "1795270108000",
  });

describe("polymarket live market views", () => {
  it("subscribes on open and heartbeats with PING", async () => {
    const { live, timers } = setup();
    live.book(ASSET);
    expect(sockets).toHaveLength(1);
    sockets[0]!.opened();
    expect(sockets[0]!.sent[0]).toBe(
      `{"assets_ids":["${ASSET}"],"type":"market","custom_feature_enabled":true}`,
    );
    await timers.fire(10_000);
    expect(sockets[0]!.sent).toContain("PING");
  });

  it("drops the socket when no PONG answers a PING", async () => {
    const { live, timers } = setup();
    const view = live.book(ASSET);
    sockets[0]!.opened();
    await timers.fire(10_000);
    expect(sockets[0]!.sent).toContain("PING");
    await timers.fire(5000);
    expect(sockets[0]!.readyState).toBe(3);
    expect(view.getState().status).toBe("stale");
  });

  it("PONG clears the pong wait", async () => {
    const { live, timers } = setup();
    live.book(ASSET);
    sockets[0]!.opened();
    await timers.fire(10_000);
    sockets[0]!.recv("PONG");
    await timers.fire(5000);
    expect(sockets[0]!.readyState).toBe(1);
  });

  it("adds a view on an open socket with the dynamic subscribe frame", () => {
    const { live } = setup();
    live.book(ASSET);
    sockets[0]!.opened();
    live.book(OTHER);
    expect(sockets[0]!.sent).toContain(`{"operation":"subscribe","assets_ids":["${OTHER}"]}`);
  });

  it("unsubscribes when the last view on an asset closes and closes the socket on the last view", async () => {
    const { live } = setup();
    const a = live.book(ASSET);
    const b = live.book(OTHER);
    sockets[0]!.opened();
    await b.close();
    expect(sockets[0]!.sent).toContain(`{"operation":"unsubscribe","assets_ids":["${OTHER}"]}`);
    await a.close();
    expect(sockets[0]!.readyState).toBe(3);
  });

  it("reconnect resubscribes every open asset and waits for a fresh book", async () => {
    const { live, timers } = setup();
    const view = live.book(ASSET);
    live.book(OTHER);
    sockets[0]!.opened();
    sockets[0]!.recv(bookFrame());
    sockets[0]!.recv(
      JSON.stringify({
        event_type: "book",
        asset_id: OTHER,
        market: `0x${"b".repeat(64)}`,
        bids: [],
        asks: [],
        timestamp: "1",
      }),
    );
    sockets[0]!.drop();
    expect(view.getState().status).toBe("stale");
    await timers.fire();
    expect(sockets).toHaveLength(2);
    sockets[1]!.opened();
    expect(sockets[1]!.sent[0]).toBe(
      `{"assets_ids":["${ASSET}","${OTHER}"],"type":"market","custom_feature_enabled":true}`,
    );
    expect(view.getState().status).toBe("connecting");
    sockets[1]!.recv(bookFrame());
    expect(view.getState().status).toBe("live");
  });

  it("a book snapshot sorts bids desc and asks asc and turns the view live", () => {
    const { live } = setup();
    const view = live.book(ASSET);
    sockets[0]!.opened();
    sockets[0]!.recv(bookFrame());
    const book = view.getState().data?.book;
    expect(view.getState().status).toBe("live");
    expect(book?.bids.map((l) => l.price)).toStrictEqual(["0.49", "0.40"]);
    expect(book?.asks.map((l) => l.price)).toStrictEqual(["0.52", "0.60"]);
    expect(book?.tickSize).toBe("0.01");
    expect(book?.hash).toBe("abc");
  });

  it("applies price changes only on top of a snapshot and removes zero-size levels", () => {
    const { live } = setup();
    const view = live.book(ASSET);
    sockets[0]!.opened();
    /* Delta before any snapshot is ignored. */
    sockets[0]!.recv(priceChange([{ asset_id: ASSET, price: "0.45", size: "5", side: "BUY" }]));
    expect(view.getState().data?.book).toBeUndefined();
    sockets[0]!.recv(bookFrame());
    /* A foreign asset's change is ignored. */
    sockets[0]!.recv(priceChange([{ asset_id: OTHER, price: "0.99", size: "9", side: "BUY" }]));
    expect(view.getState().data?.book?.bids).toHaveLength(2);
    sockets[0]!.recv(
      priceChange([
        { asset_id: ASSET, price: "0.45", size: "5", side: "BUY" },
        { asset_id: ASSET, price: "0.49", size: "0", side: "BUY" },
      ]),
    );
    const bids = view.getState().data?.book?.bids;
    expect(bids?.map((l) => `${l.price}:${l.size}`)).toStrictEqual(["0.45:5", "0.40:10"]);
  });

  it("updates trade, best-bid/ask, tick and resolution fields", () => {
    const { live } = setup();
    const view = live.book(ASSET);
    sockets[0]!.opened();
    sockets[0]!.recv(bookFrame());
    sockets[0]!.recv(
      JSON.stringify({
        event_type: "last_trade_price",
        asset_id: ASSET,
        market: `0x${"a".repeat(64)}`,
        price: "0.47",
        size: "12",
        side: "BUY",
        timestamp: "1",
      }),
    );
    sockets[0]!.recv(
      JSON.stringify({
        event_type: "best_bid_ask",
        asset_id: ASSET,
        market: `0x${"a".repeat(64)}`,
        best_bid: "0.49",
        best_ask: "0.52",
        spread: "0.03",
        timestamp: "1",
      }),
    );
    sockets[0]!.recv(
      JSON.stringify({
        event_type: "tick_size_change",
        asset_id: ASSET,
        market: `0x${"a".repeat(64)}`,
        old_tick_size: "0.01",
        new_tick_size: "0.001",
        timestamp: "1",
      }),
    );
    sockets[0]!.recv(
      JSON.stringify({
        event_type: "market_resolved",
        market: `0x${"a".repeat(64)}`,
        assets_ids: [ASSET, OTHER],
        winning_asset_id: ASSET,
        winning_outcome: "Yes",
        timestamp: "1",
      }),
    );
    const { data } = view.getState();
    expect(data?.lastTrade).toStrictEqual({ price: "0.47", size: "12", side: "BUY" });
    expect(data?.bestBidAsk).toStrictEqual({ bestBid: "0.49", bestAsk: "0.52", spread: "0.03" });
    expect(data?.book?.tickSize).toBe("0.001");
    expect(data?.resolved).toStrictEqual({ winningAssetId: ASSET, winningOutcome: "Yes" });
  });

  it("drops malformed frames without touching state", () => {
    const { live } = setup();
    const view = live.book(ASSET);
    sockets[0]!.opened();
    sockets[0]!.recv("not json at all");
    sockets[0]!.recv(JSON.stringify({ event_type: "new_market", id: "1" }));
    sockets[0]!.recv(JSON.stringify([{ event_type: "book" }]));
    expect(view.getState().status).toBe("connecting");
    expect(warns.length).toBeGreaterThanOrEqual(2);
  });

  it("replays the recorded market frames", () => {
    const { live } = setup();
    const view = live.book(ASSET);
    sockets[0]!.opened();
    const fixture = JSON.parse(
      readFileSync(new URL("fixtures/polymarket/ws-market.json", import.meta.url), "utf8"),
    ) as { response: { frames: unknown[] } };
    for (const frame of fixture.response.frames) {
      sockets[0]!.recv(JSON.stringify(frame));
    }
    expect(view.getState().status).toBe("live");
    expect(view.getState().data?.book?.bids.length).toBeGreaterThan(0);
    expect(view.getState().data?.book?.tickSize).toBe("0.001");
  });
});

describe("polymarket live account views", () => {
  const group = { walletId: "w", groupIndex: 0 };
  const authBody = () =>
    ({
      auth: { apiKey: CREDS.apiKey, secret: CREDS.secret, passphrase: CREDS.passphrase },
      type: "user",
    }) as const;

  it("opens the user socket and sends the stored credentials as the first frame", async () => {
    const { live } = setup();
    live.account(group);
    await flush();
    expect(sockets).toHaveLength(1);
    expect(lastUrl).toBe(USER_WS_URL);
    sockets[0]!.opened();
    expect(JSON.parse(String(sockets[0]!.sent[0]))).toStrictEqual(authBody());
  });

  it("snapshots orders, positions and trades, then reports live over the stream", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    const state = view.getState();
    expect(state.status).toBe("live");
    expect(state.data?.source).toBe("stream");
    expect(state.data?.wallet).toBe(WALLET);
    expect(state.data?.openOrders).toStrictEqual([BASE_ORDER]);
    expect(state.data?.positions).toStrictEqual([]);
    expect(state.data?.trades).toStrictEqual([]);
  });

  it("applies the fixture order events — placement adds, update upserts, cancellation removes", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    sockets[0]!.recv(JSON.stringify(FRAMES[0]));
    expect(view.getState().data?.openOrders.map((o) => o.id)).toStrictEqual([
      BASE_ORDER.id,
      PLACEMENT_ID,
    ]);
    const placed = view.getState().data?.openOrders[1];
    expect(placed?.status).toBe("LIVE");
    expect(placed?.side).toBe("SELL");
    expect(placed?.orderType).toBe("GTD");
    expect(placed?.createdAt).toBe(1672290687);
    sockets[0]!.recv(JSON.stringify(FRAMES[1]));
    expect(view.getState().data?.openOrders).toHaveLength(2);
    expect(view.getState().data?.openOrders[1]?.sizeMatched).toBe("4");
    sockets[0]!.recv(JSON.stringify(FRAMES[2]));
    expect(view.getState().data?.openOrders.map((o) => o.id)).toStrictEqual([BASE_ORDER.id]);
  });

  it("removes an order on CANCELLATION even when the event carries no status", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    sockets[0]!.recv(JSON.stringify(FRAMES[0]));
    expect(view.getState().data?.openOrders).toHaveLength(2);
    sockets[0]!.recv(JSON.stringify({ ...FRAMES[2], status: undefined }));
    expect(view.getState().data?.openOrders.map((o) => o.id)).toStrictEqual([BASE_ORDER.id]);
  });

  it("removes an order whose event carries a non-LIVE status", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    sockets[0]!.recv(JSON.stringify(FRAMES[0]));
    expect(view.getState().data?.openOrders).toHaveLength(2);
    sockets[0]!.recv(JSON.stringify({ ...FRAMES[1], type: "UPDATE", status: "MATCHED" }));
    expect(view.getState().data?.openOrders.map((o) => o.id)).toStrictEqual([BASE_ORDER.id]);
  });

  it("replays order events that arrive while the snapshot runs", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    /* The snapshot is still in flight — the placement queues and replays after it emits live. */
    sockets[0]!.recv(JSON.stringify(FRAMES[0]));
    await flush();
    expect(view.getState().status).toBe("live");
    expect(view.getState().data?.openOrders.map((o) => o.id)).toStrictEqual([
      BASE_ORDER.id,
      PLACEMENT_ID,
    ]);
  });

  it("debounces trade events into one trades+positions re-read", async () => {
    const { live, timers } = setup();
    live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    const positionsBefore = calls.positions;
    const tradesBefore = calls.trades;
    sockets[0]!.recv(JSON.stringify(FRAMES[3]));
    sockets[0]!.recv(JSON.stringify(FRAMES[3]));
    expect(calls.trades).toBe(tradesBefore);
    await timers.fire(1000);
    await flush();
    expect(calls.trades - tradesBefore).toBe(1);
    expect(calls.positions - positionsBefore).toBe(1);
  });

  it("falls back to a stale poll while disconnected and returns to stream on reconnect", async () => {
    const { live, timers } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    sockets[0]!.drop();
    expect(view.getState().status).toBe("stale");
    /* The fallback poll refreshes the data but the view stays stale — the stream is down. */
    await timers.fire(10_000);
    await flush();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().data?.source).toBe("poll");
    /* Backoff reconnects: the auth frame goes out again and the snapshot turns the view live. */
    await timers.fire(500);
    expect(sockets).toHaveLength(2);
    sockets[1]!.opened();
    expect(JSON.parse(String(sockets[1]!.sent[0]))).toStrictEqual(authBody());
    await flush();
    expect(view.getState().status).toBe("live");
    expect(view.getState().data?.source).toBe("stream");
    /* Polling has stopped — a further 10 s tick runs no REST reads. */
    const reads = calls.locate;
    await timers.fire(10_000);
    await flush();
    expect(calls.locate).toBe(reads);
    expect(view.getState().status).toBe("live");
  });

  it("stops unlock-required at start on a locked store — no socket opens", async () => {
    const { live } = setup();
    credsGet = async () => {
      await Promise.resolve();
      throw new PolymarketError("unlock-required", "the vault is locked");
    };
    const view = live.account(group);
    await flush();
    expect(sockets).toHaveLength(0);
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("unlock-required");
  });

  it("stops not-enabled at start when the group has no credentials — no socket opens", async () => {
    const { live } = setup();
    credsGet = async () => {
      await Promise.resolve();
      return undefined;
    };
    const view = live.account(group);
    await flush();
    expect(sockets).toHaveLength(0);
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("not-enabled");
  });

  it("stops on a fatal category from the fallback poll", async () => {
    const { live, timers } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    sockets[0]!.drop();
    expect(view.getState().status).toBe("stale");
    accountBehavior = "unlock";
    await timers.fire(10_000);
    await flush();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("unlock-required");
    /* A stopped view schedules nothing further. */
    await timers.fire();
    expect(calls.locate).toBe(2);
  });

  it("a wallet lock stops the view and closes its socket for good", async () => {
    const { live, timers } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    notifyLock();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("unlock-required");
    expect(sockets[0]!.readyState).toBe(3);
    /* The user-close path suppresses the reconnect — no second socket ever appears. */
    await timers.fire();
    expect(sockets).toHaveLength(1);
  });

  it("stops on a fatal category from the snapshot", async () => {
    const { live, timers } = setup();
    accountBehavior = "not-enabled";
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("not-enabled");
    /* A stopped view schedules nothing further — no fallback poll ticks. */
    await timers.fire(10_000);
    expect(calls.locate).toBe(1);
  });

  it("drops hostile frames without a state change and never logs frame content", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    sockets[0]!.opened();
    await flush();
    sockets[0]!.recv("not json at all");
    /* A non-JSON frame can carry a credential — its text must never reach the log either. */
    sockets[0]!.recv(`{"broken ${CREDS.secret}`);
    sockets[0]!.recv(JSON.stringify([1, 2, 3]));
    /* An oversized array is refused whole, even when every element would parse. */
    sockets[0]!.recv(
      JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ ...FRAMES[0], id: `o-${i}` }))),
    );
    sockets[0]!.recv(JSON.stringify({ event_type: "order" }));
    /* The only legit event carries the API key in `owner` — it must never reach view data. */
    sockets[0]!.recv(JSON.stringify({ ...FRAMES[0], owner: CREDS.apiKey }));
    /* An echoed auth frame parses as JSON but matches no event — dropped, content-free. */
    sockets[0]!.recv(String(sockets[0]!.sent[0]));
    const state = view.getState();
    expect(state.status).toBe("live");
    expect(state.data?.openOrders.map((o) => o.id)).toStrictEqual([BASE_ORDER.id, PLACEMENT_ID]);
    const data = JSON.stringify(state.data);
    expect(data).not.toContain(CREDS.apiKey);
    expect(data).not.toContain(CREDS.secret);
    expect(data).not.toContain(CREDS.passphrase);
    const logs = warns.join("\n");
    expect(logs).not.toContain(CREDS.apiKey);
    expect(logs).not.toContain(CREDS.secret);
    expect(logs).not.toContain(CREDS.passphrase);
    expect(warns.length).toBeGreaterThanOrEqual(4);
  });
});
