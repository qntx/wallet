/**
 * `live.book` streams the market channel over the shared socket core — heartbeat `PING`/`PONG`,
 * dynamic `{"operation":...}` frames (documented in asyncapi.json), a fresh `book` snapshot per
 * (re)connect, deltas only on top of a snapshot, `stale` on every disconnect — and `live.account`
 * polls orders + positions, stopping on lock or a fatal category. The recorded `ws-market.json`
 * frames replay end to end.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { PolymarketAccountReads } from "../src/apps/polymarket/account.ts";
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import { createPolymarketLive } from "../src/apps/polymarket/live.ts";
import type { AppSocket } from "../src/apps/socket.ts";
import { manualTimers } from "./support/timers.ts";

const ASSET = "350977769852917329387037893294763093471844346281449484439085576212613048126";
const OTHER = "8707389984558146348518634628839865856";
const WALLET = "0x9355a4bf4c8d8f9a4f9a2c11a4c1b2d3e4f56789";

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
let accountBehavior: "ok" | "fail" | "unlock" | "not-enabled" = "ok";
const accountStub = (): PolymarketAccountReads =>
  ({
    locate: async () => {
      await Promise.resolve();
      if (accountBehavior === "unlock") {
        throw new PolymarketError("unlock-required", "locked");
      }
      return located;
    },
    openOrders: async () => {
      await Promise.resolve();
      if (accountBehavior === "fail") {
        throw new PolymarketError("unavailable", "boom");
      }
      return { items: [] };
    },
    positions: async () => {
      await Promise.resolve();
      if (accountBehavior === "fail") {
        throw new PolymarketError("unavailable", "boom");
      }
      if (accountBehavior === "not-enabled") {
        throw new PolymarketError("not-enabled", "no creds");
      }
      return { items: [] };
    },
  }) as unknown as PolymarketAccountReads;

/* The account poll awaits locate → two reads — a handful of microtask turns settles it. */
const flush = async (): Promise<void> => {
  // oxlint-disable-next-line eslint/no-await-in-loop -- each turn must settle before the next.
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
};

const setup = () => {
  sockets.length = 0;
  warns.length = 0;
  accountBehavior = "ok";
  vaultState = "unlocked";
  const timers = manualTimers();
  const live = createPolymarketLive({
    account: accountStub(),
    socket: () => makeSocket(),
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

  it("reaches live on the first poll and keeps data through a failed poll", async () => {
    const { live, timers } = setup();
    const view = live.account(group);
    await flush();
    expect(view.getState().status).toBe("live");
    expect(view.getState().data?.wallet).toBe(WALLET);
    accountBehavior = "fail";
    await timers.fire(10_000);
    await flush();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().data?.wallet).toBe(WALLET);
    accountBehavior = "ok";
    await timers.fire(10_000);
    await flush();
    expect(view.getState().status).toBe("live");
  });

  it("stops polling on a fatal category", async () => {
    const { live, timers } = setup();
    accountBehavior = "not-enabled";
    const view = live.account(group);
    await flush();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("not-enabled");
    await timers.fire(10_000);
    await timers.fire(10_000);
    expect(view.getState().error).toBe("not-enabled");
  });

  it("a wallet lock stops every account view", async () => {
    const { live } = setup();
    const view = live.account(group);
    await flush();
    expect(view.getState().status).toBe("live");
    notifyLock();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBe("unlock-required");
  });
});
