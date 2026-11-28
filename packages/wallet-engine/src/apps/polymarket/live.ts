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
 * Account views stream the authenticated user channel
 * `wss://ws-subscriptions-clob.polymarket.com/ws/user` over a per-view `createAppSocketCore`
 * socket: the stored credentials are read once at view start, live only in the view closure and are
 * dropped on stop/close/lock; the first frame is the auth message
 * `{"auth":{"apiKey","secret","passphrase"},"type":"user"}` (asyncapi user.json), then a REST
 * snapshot (locate + openOrders + positions + trades) turns the view `live`/`stream`. `order`
 * events upsert (or remove on `CANCELLATION`/non-`LIVE` status) and `trade` events schedule a
 * debounced REST re-read of trades + positions. A disconnect marks the view `stale` — data kept —
 * and falls back to a 10 s REST poll (`source: "poll"`); a reconnect re-sends the auth frame,
 * re-runs the snapshot and returns to `live`/`stream`. `unlock-required`/`not-enabled`, a wallet
 * lock, a credentials delete and the view's wallet being removed stop the view and close its
 * socket. Frames are parsed against bounded schemas and malformed ones dropped with a content-free
 * log — an echoed auth frame would carry the secret.
 */
import type * as z from "zod/mini";

import type { Wallet } from "@qntx/wallet";

import { createAppSocketCore } from "../spi.ts";
import type { AppGroup, AppSocket, AppSocketCore, EngineLogger, SetTimer } from "../spi.ts";
import type {
  PolymarketAccountReads,
  PolymarketOrder,
  PolymarketPosition,
  PolymarketTrade,
} from "./account.ts";
import { MARKET_WS_URL, USER_WS_URL } from "./constants.ts";
import type { PolymarketCredentials, PolymarketCredentialStore } from "./credentials.ts";
import { PolymarketError } from "./errors.ts";
import {
  wsBestBidAskEvent,
  wsBookEvent,
  wsLastTradePriceEvent,
  wsMarketResolvedEvent,
  wsPriceChangeEvent,
  wsTickSizeChangeEvent,
  wsUserOrderEvent,
  wsUserTradeEvent,
} from "./schemas.ts";

const PING_MS = 10_000;
const PONG_TIMEOUT_MS = 5000;
const ACCOUNT_POLL_MS = 10_000;
const TRADE_REFRESH_MS = 1000;
/** A single frame carries at most this many events — anything bigger is dropped whole. */
const MAX_FRAME_EVENTS = 256;

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
  readonly trades: ReadonlyArray<PolymarketTrade>;
  /** Whether the data flows from the user socket or the REST fallback poll. */
  readonly source: "stream" | "poll";
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

const fatal = (error: unknown): error is PolymarketError =>
  error instanceof PolymarketError &&
  (error.category === "unlock-required" || error.category === "not-enabled");

const authFrame = (credentials: PolymarketCredentials): string =>
  JSON.stringify({
    auth: {
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      passphrase: credentials.passphrase,
    },
    type: "user",
  });

const updateFrame = (operation: "subscribe" | "unsubscribe", ids: ReadonlyArray<string>): string =>
  `{"operation":"${operation}","assets_ids":${JSON.stringify(ids)}}`;

export type PolymarketLive = {
  /** The order book for one outcome asset (CLOB token id). */
  readonly book: (assetId: string) => PolymarketLiveView<PolymarketMarketData>;
  /**
   * Orders + positions + trades for the group over the user channel — one authenticated socket per
   * view with a REST poll fallback while disconnected. Stops on lock or a
   * `unlock-required`/`not-enabled` error.
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
  /** The group's stored CLOB credentials — read once per account view, then held in its closure. */
  readonly credentials: PolymarketCredentialStore;
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
      close: async () => {
        const owners = views.get(assetId);
        owners?.delete(view);
        if (owners !== undefined && owners.size === 0) {
          views.delete(assetId);
          if (core.status() === "open") {
            core.send(updateFrame("unsubscribe", [assetId]));
          }
        }
        if (views.size === 0) {
          core.close();
        }
        await Promise.resolve();
      },
    };
  };

  type AccountView = {
    readonly group: AppGroup;
    state: PolymarketLiveState<PolymarketAccountLiveData>;
    listeners: Set<(state: PolymarketLiveState<PolymarketAccountLiveData>) => void>;
    closed: boolean;
    stop: (error: string | undefined) => void;
  };
  const accountViews = new Set<AccountView>();

  /* Lock-following is subscribed lazily on the first account view — a provider built for reads
     only (or with a read-only wallet) never touches `wallet.subscribe`. */
  let unsubscribeWallet: (() => void) | undefined;
  const followLock = (): void => {
    unsubscribeWallet ??= options.wallet.subscribe(() => {
      const snapshot = options.wallet.getSnapshot();
      if (snapshot.vault.status !== "unlocked") {
        // oxlint-disable-next-line unicorn/prefer-spread -- the loop removes views from the set; a snapshot is required.
        for (const view of Array.from(accountViews)) {
          view.stop("unlock-required");
        }
        return;
      }
      /* The wallet-deletion prune drops the record under the view — a deleted wallet stops its
         groups' views while unlocked. */
      const wallets = new Set(snapshot.wallets.map((w) => w.walletId));
      // oxlint-disable-next-line unicorn/prefer-spread -- the loop removes views from the set; a snapshot is required.
      for (const view of Array.from(accountViews)) {
        if (!wallets.has(view.group.walletId)) {
          view.stop("not-enabled");
        }
      }
    });
  };

  const account = (group: AppGroup): PolymarketLiveView<PolymarketAccountLiveData> => {
    followLock();
    /* The credentials the auth frame needs — read once at start, dropped on every exit path. */
    let credentials: PolymarketCredentials | undefined;
    let core: AppSocketCore | undefined;
    /* Frames that arrive while a snapshot runs replay after it — apply is idempotent. */
    let snapshotting = false;
    const queued: string[] = [];
    let pollCancel: (() => void) | undefined;
    let tradeCancel: (() => void) | undefined;
    let unsubscribeDelete: (() => void) | undefined;

    const view: AccountView = {
      group,
      listeners: new Set(),
      closed: false,
      state: { status: "connecting", error: undefined, updatedAt: undefined, data: undefined },
      stop: (error) => {
        if (view.closed) {
          return;
        }
        view.closed = true;
        credentials = undefined;
        queued.length = 0;
        pollCancel?.();
        pollCancel = undefined;
        tradeCancel?.();
        tradeCancel = undefined;
        core?.close();
        core = undefined;
        unsubscribeDelete?.();
        unsubscribeDelete = undefined;
        accountViews.delete(view);
        if (accountViews.size === 0) {
          unsubscribeWallet?.();
          unsubscribeWallet = undefined;
        }
        view.state = { ...view.state, status: "stale", error };
        for (const listener of view.listeners) {
          listener(view.state);
        }
      },
    };
    /* A deleted record must never be re-sent — `disable` deletes through the credential store,
       the wallet prune is caught by the snapshot check in `followLock`. */
    unsubscribeDelete = options.credentials.onDelete((deleted) => {
      if (deleted.walletId === group.walletId && deleted.groupIndex === group.groupIndex) {
        view.stop("not-enabled");
      }
    });
    const emit = (next: PolymarketLiveState<PolymarketAccountLiveData>): void => {
      view.state = next;
      for (const listener of view.listeners) {
        listener(next);
      }
    };

    /* The REST reads the stream snapshot and the fallback poll share. */
    const snapshot = async (): Promise<Omit<PolymarketAccountLiveData, "source">> => {
      const located = await options.account.locate(group);
      const [orders, positions, trades] = await Promise.all([
        options.account.openOrders(group, {}),
        options.account.positions(located.wallet, {}),
        options.account.trades(group, {}),
      ]);
      return {
        wallet: located.wallet,
        openOrders: orders.items,
        positions: positions.items,
        trades: trades.items,
      };
    };

    const applyOrder = (event: z.infer<typeof wsUserOrderEvent>): void => {
      const { data } = view.state;
      if (data === undefined) {
        return;
      }
      if (
        event.type === "CANCELLATION" ||
        (event.status !== undefined && event.status !== "LIVE")
      ) {
        emit({
          ...view.state,
          updatedAt: options.now(),
          data: {
            ...data,
            openOrders: data.openOrders.filter((order) => order.id !== event.id),
          },
        });
        return;
      }
      /* An upsert needs every column a PolymarketOrder carries — anything else is malformed. */
      const createdAt = event.created_at === undefined ? Number.NaN : Number(event.created_at);
      if (
        event.market === undefined ||
        event.asset_id === undefined ||
        event.side === undefined ||
        event.original_size === undefined ||
        event.size_matched === undefined ||
        event.price === undefined ||
        event.order_type === undefined ||
        event.expiration === undefined ||
        event.maker_address === undefined ||
        !Number.isFinite(createdAt)
      ) {
        malformed += 1;
        options.logger.warn("apps.polymarket.live: dropped an unmappable order event");
        return;
      }
      const order: PolymarketOrder = {
        id: event.id,
        status: event.status ?? "LIVE",
        conditionId: event.market,
        assetId: event.asset_id,
        side: event.side,
        price: event.price,
        originalSize: event.original_size,
        sizeMatched: event.size_matched,
        ...(event.outcome === undefined || event.outcome === null
          ? {}
          : { outcome: event.outcome }),
        orderType: event.order_type,
        expiration: event.expiration,
        createdAt,
        makerAddress: event.maker_address,
      };
      const index = data.openOrders.findIndex((existing) => existing.id === order.id);
      const openOrders =
        index === -1
          ? [...data.openOrders, order]
          : data.openOrders.map((existing, at) => (at === index ? order : existing));
      emit({ ...view.state, updatedAt: options.now(), data: { ...data, openOrders } });
    };

    /* A trade event schedules one debounced re-read of what it changes: fills move size_matched
       (order events cover that) while positions and the trade tape only live in REST. */
    const scheduleTradeRead = (): void => {
      if (tradeCancel !== undefined || view.closed) {
        return;
      }
      tradeCancel = options.setTimer(TRADE_REFRESH_MS, () => {
        tradeCancel = undefined;
        void (async () => {
          const wallet = view.state.data?.wallet;
          if (wallet === undefined || view.closed) {
            return;
          }
          try {
            const [positions, trades] = await Promise.all([
              options.account.positions(wallet, {}),
              options.account.trades(group, {}),
            ]);
            const { data } = view.state;
            if (view.closed || data === undefined) {
              return;
            }
            emit({
              ...view.state,
              updatedAt: options.now(),
              data: { ...data, positions: positions.items, trades: trades.items },
            });
          } catch (error) {
            if (view.closed) {
              return;
            }
            if (fatal(error)) {
              view.stop(error.category);
            }
            /* Any other failure keeps the data with no status change. */
          }
        })();
      });
    };

    const applyFrame = (raw: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        malformed += 1;
        /* Never log frame content — an echoed auth frame would carry the secret. */
        options.logger.warn("apps.polymarket.live: dropped a malformed user frame");
        return;
      }
      const events = Array.isArray(parsed) ? parsed : [parsed];
      if (events.length > MAX_FRAME_EVENTS) {
        malformed += 1;
        options.logger.warn("apps.polymarket.live: dropped an oversized user frame");
        return;
      }
      for (const event of events) {
        const order = wsUserOrderEvent.safeParse(event);
        if (order.success) {
          applyOrder(order.data);
          continue;
        }
        const trade = wsUserTradeEvent.safeParse(event);
        if (trade.success) {
          scheduleTradeRead();
          continue;
        }
        malformed += 1;
        options.logger.warn("apps.polymarket.live: dropped an unparsed user event");
      }
    };

    const startPoll = (): void => {
      if (pollCancel !== undefined || view.closed) {
        return;
      }
      const tick = async (): Promise<void> => {
        pollCancel = undefined;
        try {
          const data = await snapshot();
          if (view.closed) {
            return;
          }
          emit({
            ...view.state,
            updatedAt: options.now(),
            data: { ...data, source: "poll" },
          });
        } catch (error) {
          if (view.closed) {
            return;
          }
          if (fatal(error)) {
            view.stop(error.category);
            return;
          }
          /* A failed poll keeps the last data as stale. */
        }
        if (!view.closed) {
          pollCancel = options.setTimer(ACCOUNT_POLL_MS, () => void tick());
        }
      };
      pollCancel = options.setTimer(ACCOUNT_POLL_MS, () => void tick());
    };

    const runSnapshot = async (): Promise<void> => {
      snapshotting = true;
      let degraded = false;
      try {
        const data = await snapshot();
        if (view.closed) {
          return;
        }
        pollCancel?.();
        pollCancel = undefined;
        emit({
          status: "live",
          error: undefined,
          updatedAt: options.now(),
          data: { ...data, source: "stream" },
        });
      } catch (error) {
        if (view.closed) {
          return;
        }
        if (fatal(error)) {
          view.stop(error.category);
          return;
        }
        degraded = true;
        emit({ ...view.state, status: "stale", error: undefined });
      } finally {
        snapshotting = false;
        for (const raw of queued.splice(0)) {
          if (!view.closed) {
            applyFrame(raw);
          }
        }
      }
      if (degraded && !view.closed) {
        startPoll();
      }
    };

    const onUserMessage = (raw: string): void => {
      if (view.closed) {
        return;
      }
      if (snapshotting) {
        /* The replay capacity is generous — a flood beyond it is dropped whole. */
        if (queued.length < MAX_FRAME_EVENTS) {
          queued.push(raw);
        }
        return;
      }
      applyFrame(raw);
    };

    void (async () => {
      try {
        credentials = await options.credentials.get(group);
      } catch (error) {
        view.stop(error instanceof PolymarketError ? error.category : "unavailable");
        return;
      }
      if (view.closed) {
        return;
      }
      if (credentials === undefined) {
        view.stop("not-enabled");
        return;
      }
      const next = createAppSocketCore({
        url: USER_WS_URL,
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
          if (credentials !== undefined) {
            next.send(authFrame(credentials));
          }
          void runSnapshot();
        },
        onMessage: onUserMessage,
      });
      next.onStatus((status) => {
        if (view.closed) {
          return;
        }
        if (status === "closed" && !next.closedByUser()) {
          /* The stream is down — keep the data, mark stale and fall back to REST polling. */
          emit({ ...view.state, status: "stale" });
          startPoll();
        } else if (status === "connecting") {
          emit({ ...view.state, status: "connecting" });
        }
      });
      core = next;
      next.connect();
    })();

    accountViews.add(view);
    return {
      getState: () => view.state,
      subscribe: (listener) => {
        view.listeners.add(listener);
        return () => {
          view.listeners.delete(listener);
        };
      },
      close: async () => {
        view.stop(view.state.error);
        await Promise.resolve();
      },
    };
  };

  return { book, account };
}
