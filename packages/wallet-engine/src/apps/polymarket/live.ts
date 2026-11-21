/**
 * Live Polymarket views.
 *
 * Market views stream the public market channel
 * `wss://ws-subscriptions-clob.polymarket.com/ws/market` over one shared `createAppSocketCore`
 * socket: text `PING` every 10 s (`PONG` answers it, spec asyncapi.json), an initial
 * `{"assets_ids":[…],"type":"market","custom_feature_enabled":true}` on open, and dynamic
 * `{"operation":"subscribe"|"unsubscribe"}` frames while open (documented in the spec — used rather
 * than reconnecting). Frames can carry arrays of events; every event is parsed against a bounded
 * schema and malformed frames are dropped (counted in the log, no state change). A `book` event
 * replaces the snapshot and turns the view `live`; `price_change` applies only on top of a snapshot
 * for its own asset (size "0" removes the level); `last_trade_price`, `best_bid_ask`,
 * `tick_size_change` and `market_resolved` update their fields. A disconnect marks every open view
 * `stale` — data is kept, never presented as live — and a reconnect resubscribes all ids and waits
 * for a fresh `book` before `live` again.
 *
 * Account views poll `openOrders` + `positions` every 10 s on the injected timer. The CLOB's
 * authenticated user channel needs the raw API secret in the main runtime — the secret never leaves
 * the kernel — so authenticated views poll instead of streaming (research.md §4). A failed poll
 * keeps the last data as `stale` and keeps polling; `unlock-required`/`not-enabled` and a wallet
 * lock stop the view entirely.
 */
import type * as z from "zod/mini";

import type { Wallet } from "@qntx/wallet";

import type { EngineLogger } from "../../events.ts";
import type { SetTimer } from "../../timer.ts";
import type { AppSocket } from "../socket.ts";
import { createAppSocketCore } from "../socket.ts";
import type { AppGroup } from "../types.ts";
import type { PolymarketAccountReads, PolymarketOrder, PolymarketPosition } from "./account.ts";
import { MARKET_WS_URL } from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import {
  wsBestBidAskEvent,
  wsBookEvent,
  wsLastTradePriceEvent,
  wsMarketResolvedEvent,
  wsPriceChangeEvent,
  wsTickSizeChangeEvent,
} from "./schemas.ts";

const PING_MS = 10_000;
const PONG_TIMEOUT_MS = 5000;
const ACCOUNT_POLL_MS = 10_000;

/** What a live view reports — `data` is kept while `stale`, never while absent. */
export type PolymarketLiveState<T> = {
  readonly status: "connecting" | "live" | "stale";
  readonly data: T | undefined;
  /** Set when the view stopped on a fatal error (lock, `unlock-required`, `not-enabled`). */
  readonly error: string | undefined;
  readonly updatedAt: number | undefined;
};

export type PolymarketLiveView<T> = {
  readonly getState: () => PolymarketLiveState<T>;
  /** Listener on every state change; returns an unsubscribe. */
  readonly subscribe: (listener: (state: PolymarketLiveState<T>) => void) => () => void;
  /** Drops the subscription — the view keeps its last state and never updates again. */
  readonly close: () => Promise<void>;
};

export type PolymarketBookLevel = { readonly price: string; readonly size: string };

export type PolymarketBookData = {
  /** Bids sorted best-first (price descending). */
  readonly bids: ReadonlyArray<PolymarketBookLevel>;
  /** Asks sorted best-first (price ascending). */
  readonly asks: ReadonlyArray<PolymarketBookLevel>;
  readonly tickSize: string | undefined;
  readonly timestamp: string | undefined;
  readonly hash: string | undefined;
};

export type PolymarketMarketData = {
  readonly book?: PolymarketBookData | undefined;
  readonly lastTrade?:
    | { readonly price: string; readonly size: string; readonly side: "BUY" | "SELL" }
    | undefined;
  readonly bestBidAsk?:
    | { readonly bestBid: string; readonly bestAsk: string; readonly spread: string }
    | undefined;
  readonly resolved?:
    | { readonly winningAssetId: string; readonly winningOutcome: string }
    | undefined;
};

export type PolymarketAccountLiveData = {
  readonly wallet: `0x${string}`;
  readonly openOrders: ReadonlyArray<PolymarketOrder>;
  readonly positions: ReadonlyArray<PolymarketPosition>;
};

const sortLevels = (
  levels: ReadonlyArray<{ price: string; size: string }>,
  desc: boolean,
): PolymarketBookLevel[] =>
  [...levels].sort((a, b) => {
    const cmp = Number(a.price) - Number(b.price);
    return desc ? -cmp : cmp;
  });

const initialFrame = (ids: ReadonlyArray<string>): string =>
  `{"assets_ids":${JSON.stringify(ids)},"type":"market","custom_feature_enabled":true}`;

const updateFrame = (operation: "subscribe" | "unsubscribe", ids: ReadonlyArray<string>): string =>
  `{"operation":"${operation}","assets_ids":${JSON.stringify(ids)}}`;

export type PolymarketLive = {
  /** The order book for one outcome asset (CLOB token id). */
  readonly book: (assetId: string) => PolymarketLiveView<PolymarketMarketData>;
  /**
   * Open orders + positions for the group — polled (the user channel would need the API secret,
   * which stays inside the kernel). Stops on lock or a `unlock-required`/`not-enabled` error.
   */
  readonly account: (group: AppGroup) => PolymarketLiveView<PolymarketAccountLiveData>;
};

type MarketView = {
  readonly assetId: string;
  state: PolymarketLiveState<PolymarketMarketData>;
  listeners: Set<(state: PolymarketLiveState<PolymarketMarketData>) => void>;
};

export function createPolymarketLive(options: {
  readonly account: PolymarketAccountReads;
  readonly socket: (url: string) => AppSocket;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly random: (length: number) => Uint8Array;
  readonly wallet: Wallet;
  readonly logger: EngineLogger;
}): PolymarketLive {
  const views = new Map<string, Set<MarketView>>();
  const viewByAsset = (assetId: string): Set<MarketView> => {
    const set = views.get(assetId);
    if (set === undefined) {
      const next = new Set<MarketView>();
      views.set(assetId, next);
      return next;
    }
    return set;
  };
  let malformed = 0;

  const notify = (view: MarketView): void => {
    for (const listener of view.listeners) {
      listener(view.state);
    }
  };

  const setState = (view: MarketView, next: PolymarketLiveState<PolymarketMarketData>): void => {
    view.state = next;
    notify(view);
  };

  const eachView = (assetId: string, fn: (view: MarketView) => void): void => {
    for (const view of views.get(assetId) ?? []) {
      fn(view);
    }
  };

  const applyBook = (view: MarketView, event: z.infer<typeof wsBookEvent>): void => {
    const book: PolymarketBookData = {
      bids: sortLevels(event.bids, true),
      asks: sortLevels(event.asks, false),
      tickSize: event.tick_size ?? view.state.data?.book?.tickSize,
      timestamp: event.timestamp,
      hash: event.hash,
    };
    setState(view, {
      status: "live",
      error: undefined,
      updatedAt: options.now(),
      data: { ...view.state.data, book, resolved: view.state.data?.resolved },
    });
  };

  const applyPriceChange = (view: MarketView, event: z.infer<typeof wsPriceChangeEvent>): void => {
    const book = view.state.data?.book;
    if (book === undefined) {
      return;
    }
    let bids = [...book.bids];
    let asks = [...book.asks];
    let sawAsset = false;
    for (const change of event.price_changes) {
      /* The event scopes to the subscribed market; changes carry their own asset_id. */
      if (change.asset_id !== view.assetId) {
        continue;
      }
      sawAsset = true;
      const side = change.side === "BUY" ? "bids" : "asks";
      const levels = side === "bids" ? bids : asks;
      const idx = levels.findIndex((l) => l.price === change.price);
      const next = [...levels];
      if (change.size === "0") {
        if (idx !== -1) {
          next.splice(idx, 1);
        }
      } else if (idx === -1) {
        next.push({ price: change.price, size: change.size });
      } else {
        next[idx] = { price: change.price, size: change.size };
      }
      if (side === "bids") {
        bids = sortLevels(next, true);
      } else {
        asks = sortLevels(next, false);
      }
    }
    if (!sawAsset) {
      return;
    }
    setState(view, {
      ...view.state,
      updatedAt: options.now(),
      data: { ...view.state.data, book: { ...book, bids, asks } },
    });
  };

  const dispatch = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformed += 1;
      options.logger.warn("apps.polymarket.live: dropped a malformed frame");
      return;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of events) {
      const book = wsBookEvent.safeParse(event);
      if (book.success) {
        eachView(book.data.asset_id, (view) => applyBook(view, book.data));
        continue;
      }
      const change = wsPriceChangeEvent.safeParse(event);
      if (change.success) {
        for (const assetId of views.keys()) {
          eachView(assetId, (view) => applyPriceChange(view, change.data));
        }
        continue;
      }
      const trade = wsLastTradePriceEvent.safeParse(event);
      if (trade.success) {
        eachView(trade.data.asset_id, (view) =>
          setState(view, {
            ...view.state,
            updatedAt: options.now(),
            data: {
              ...view.state.data,
              lastTrade: {
                price: trade.data.price,
                size: trade.data.size,
                side: trade.data.side,
              },
            },
          }),
        );
        continue;
      }
      const best = wsBestBidAskEvent.safeParse(event);
      if (best.success) {
        eachView(best.data.asset_id, (view) =>
          setState(view, {
            ...view.state,
            updatedAt: options.now(),
            data: {
              ...view.state.data,
              bestBidAsk: {
                bestBid: best.data.best_bid,
                bestAsk: best.data.best_ask,
                spread: best.data.spread,
              },
            },
          }),
        );
        continue;
      }
      const tick = wsTickSizeChangeEvent.safeParse(event);
      if (tick.success) {
        eachView(tick.data.asset_id, (view) => {
          const book = view.state.data?.book;
          if (book === undefined) {
            return;
          }
          setState(view, {
            ...view.state,
            updatedAt: options.now(),
            data: { ...view.state.data, book: { ...book, tickSize: tick.data.new_tick_size } },
          });
        });
        continue;
      }
      const resolved = wsMarketResolvedEvent.safeParse(event);
      if (resolved.success) {
        for (const assetId of resolved.data.assets_ids) {
          eachView(assetId, (view) =>
            setState(view, {
              ...view.state,
              updatedAt: options.now(),
              data: {
                ...view.state.data,
                resolved: {
                  winningAssetId: resolved.data.winning_asset_id,
                  winningOutcome: resolved.data.winning_outcome,
                },
              },
            }),
          );
        }
        continue;
      }
      malformed += 1;
      options.logger.warn("apps.polymarket.live: dropped an unparsed event");
    }
  };

  const core = createAppSocketCore({
    url: MARKET_WS_URL,
    socket: options.socket,
    setTimer: options.setTimer,
    random: options.random,
    heartbeat: {
      intervalMs: PING_MS,
      pongTimeoutMs: PONG_TIMEOUT_MS,
      ping: "PING",
      isPong: (raw) => raw === "PONG",
    },
    onOpen: () => {
      const ids = [...views.keys()];
      if (ids.length > 0) {
        core.send(initialFrame(ids));
      }
      for (const set of views.values()) {
        for (const view of set) {
          setState(view, { ...view.state, status: "connecting" });
        }
      }
    },
    onMessage: dispatch,
    onUserClose: () => {
      for (const set of views.values()) {
        for (const view of set) {
          setState(view, { ...view.state, status: "stale" });
        }
      }
    },
  });
  core.onStatus((status) => {
    if (status === "closed" && !core.closedByUser()) {
      for (const set of views.values()) {
        for (const view of set) {
          setState(view, { ...view.state, status: "stale" });
        }
      }
    } else if (status === "connecting") {
      for (const set of views.values()) {
        for (const view of set) {
          setState(view, { ...view.state, status: "connecting" });
        }
      }
    }
  });

  const book = (assetId: string): PolymarketLiveView<PolymarketMarketData> => {
    const view: MarketView = {
      assetId,
      listeners: new Set(),
      state: {
        status: "connecting",
        error: undefined,
        updatedAt: undefined,
        data: { book: undefined, lastTrade: undefined, bestBidAsk: undefined, resolved: undefined },
      },
    };
    const set = viewByAsset(assetId);
    set.add(view);
    /* The socket is already open when a second view joins — the spec's dynamic frame adds the
       asset without a reconnect. */
    if (core.status() === "open") {
      core.send(updateFrame("subscribe", [assetId]));
    }
    core.connect();
    return {
      getState: () => view.state,
      subscribe: (listener) => {
        view.listeners.add(listener);
        return () => {
          view.listeners.delete(listener);
        };
      },
      close: () => {
        const owners = views.get(assetId);
        owners?.delete(view);
        if (owners !== undefined && owners.size === 0) {
          views.delete(assetId);
          if (core.status() === "open") {
            core.send(updateFrame("unsubscribe", [assetId]));
          }
        }
        if (views.size === 0 && accountViews.size === 0) {
          core.close();
        }
        return Promise.resolve();
      },
    };
  };

  type AccountView = {
    state: PolymarketLiveState<PolymarketAccountLiveData>;
    listeners: Set<(state: PolymarketLiveState<PolymarketAccountLiveData>) => void>;
    cancel: (() => void) | undefined;
    closed: boolean;
  };
  const accountViews = new Set<AccountView>();

  const stopAccountView = (view: AccountView, error: string | undefined): void => {
    if (view.closed) {
      return;
    }
    view.closed = true;
    view.cancel?.();
    accountViews.delete(view);
    if (accountViews.size === 0) {
      unsubscribeWallet?.();
      unsubscribeWallet = undefined;
    }
    view.state = { ...view.state, status: "stale", error };
    for (const listener of view.listeners) {
      listener(view.state);
    }
  };

  /* Lock-following is subscribed lazily on the first account view — a provider built for reads
     only (or with a read-only wallet) never touches `wallet.subscribe`. */
  let unsubscribeWallet: (() => void) | undefined;
  const followLock = (): void => {
    unsubscribeWallet ??= options.wallet.subscribe(() => {
      if (options.wallet.getSnapshot().vault !== "unlocked") {
        for (const view of [...accountViews]) {
          stopAccountView(view, "unlock-required");
        }
      }
    });
  };

  const account = (group: AppGroup): PolymarketLiveView<PolymarketAccountLiveData> => {
    followLock();
    const view: AccountView = {
      listeners: new Set(),
      cancel: undefined,
      closed: false,
      state: { status: "connecting", error: undefined, updatedAt: undefined, data: undefined },
    };
    const emit = (next: PolymarketLiveState<PolymarketAccountLiveData>): void => {
      view.state = next;
      for (const listener of view.listeners) {
        listener(next);
      }
    };
    const poll = async (): Promise<void> => {
      if (view.closed) {
        return;
      }
      try {
        const located = await options.account.locate(group);
        const [orders, positions] = await Promise.all([
          options.account.openOrders(group, {}),
          options.account.positions(located.wallet, {}),
        ]);
        if (view.closed) {
          return;
        }
        emit({
          status: "live",
          error: undefined,
          updatedAt: options.now(),
          data: { wallet: located.wallet, openOrders: orders.items, positions: positions.items },
        });
      } catch (error) {
        if (view.closed) {
          return;
        }
        if (
          error instanceof PolymarketError &&
          (error.category === "unlock-required" || error.category === "not-enabled")
        ) {
          stopAccountView(view, error.category);
          return;
        }
        emit({ ...view.state, status: "stale", error: undefined });
      }
      if (!view.closed) {
        view.cancel = options.setTimer(ACCOUNT_POLL_MS, () => void poll());
      }
    };
    accountViews.add(view);
    void poll();
    return {
      getState: () => view.state,
      subscribe: (listener) => {
        view.listeners.add(listener);
        return () => {
          view.listeners.delete(listener);
        };
      },
      close: () => {
        stopAccountView(view, view.state.error);
        return Promise.resolve();
      },
    };
  };

  return { book, account };
}
