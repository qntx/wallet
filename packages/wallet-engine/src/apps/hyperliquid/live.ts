import type { ISubscription, TransportError } from "@nktkas/hyperliquid";
import { candleSnapshot, recentTrades } from "@nktkas/hyperliquid/api/info";
import type { CandleSnapshotResponse, RecentTradesResponse } from "@nktkas/hyperliquid/api/info";
/**
 * Live Hyperliquid views over the reconnecting `HyperliquidSocket` — market reads need no unlocked
 * wallet; user views resolve the group to its owner and follow the wallet lock (a lock closes
 * them). Every view reports `LiveState`: `connecting` until the subscription confirms AND the first
 * post-confirmation snapshot is applied, `live` while streaming, `stale` on any disconnect — data
 * is kept, never presented as live. A reconnect re-confirms the subscription (the socket
 * resubscribes and fires `onConfirmed`) and the view only goes `live` again on a fresh snapshot —
 * delta channels re-fetch over HTTP, snapshot channels wait for the server's first frame.
 *
 * Message shapes follow the SDK's subscription functions (`@nktkas/hyperliquid/api/subscription`,
 * docs for-developers/api/websocket/subscriptions): `l2Book` frames are full books (`{coin, time,
 * levels:[bids,asks]}`), `trades` frames are delta arrays, `candle` frames are single candles
 * upserted by open time `t`, `clearinghouseState`/`openOrders` frames are full state, `userFills`
 * frames are `{user, fills, isSnapshot?}` — `isSnapshot` replaces, deltas append deduplicated by
 * `tid`.
 */
import {
  candle as subCandle,
  clearinghouseState as subClearinghouse,
  spotState as subSpotState,
  l2Book as subL2Book,
  openOrders as subOpenOrders,
  trades as subTrades,
  userFills as subUserFills,
} from "@nktkas/hyperliquid/api/subscription";
import type {
  CandleEvent,
  L2BookEvent,
  OpenOrdersEvent,
  SpotStateEvent,
  UserFillsEvent,
  ClearinghouseStateEvent,
  CandleParameters,
} from "@nktkas/hyperliquid/api/subscription";

import type { Wallet } from "@qntx/wallet";

import type { SetTimer } from "../spi.ts";
import type { HyperliquidGroup } from "./agents.ts";
import type { HyperliquidSocket } from "./socket.ts";
import { payloadContains } from "./socket.ts";
import type { createHyperliquidTransport } from "./transport.ts";

/** What a live view reports — `data` is kept while `stale`, never while absent. */
export type LiveState<T> = {
  readonly status: "connecting" | "live" | "stale";
  readonly data: T | undefined;
  readonly updatedAt: number | undefined;
};

export type LiveView<T> = {
  readonly getState: () => LiveState<T>;
  /** Listener on every state change; returns an unsubscribe. */
  readonly subscribe: (listener: (state: LiveState<T>) => void) => () => void;
  /**
   * Drops the subscription and never updates again. Market views keep their last state; account
   * views (`account`, `spotState`, `openOrders`, `fills`) report `stale` with no data.
   */
  readonly close: () => Promise<void>;
};

export type HyperliquidLive = {
  /** Full L2 book — every `l2Book` frame is a complete snapshot and replaces `data`. */
  readonly book: (
    coin: string,
    // oxlint-disable-next-line typescript/no-restricted-types -- the SDK's parameter type is `| null`
    params?: { readonly nSigFigs?: 2 | 3 | 4 | 5 | null },
  ) => LiveView<L2BookEvent>;
  /**
   * Trades — deltas over an HTTP `recentTrades` snapshot; deltas arriving before the snapshot
   * buffer, merge/dedupe by `tid`, newest first, capped at {@link TRADES_CAP}.
   */
  readonly trades: (coin: string) => LiveView<RecentTradesResponse>;
  /** Candles — `candle` frames upserted by `t` over an HTTP `candleSnapshot` window. */
  readonly candles: (
    coin: string,
    interval: CandleParameters["interval"],
  ) => LiveView<CandleSnapshotResponse>;
  /** Full margin state — every `clearinghouseState` frame replaces `data`. */
  readonly account: (group: HyperliquidGroup) => LiveView<ClearinghouseStateEvent>;
  /** Full spot state — every `spotState` frame replaces `data`. */
  readonly spotState: (group: HyperliquidGroup) => LiveView<SpotStateEvent>;
  /** Full open-orders state — every `openOrders` frame replaces `data`. */
  readonly openOrders: (group: HyperliquidGroup) => LiveView<OpenOrdersEvent>;
  /**
   * Fills — the first `userFills` frame of a (re)subscription carries `isSnapshot: true` and
   * replaces `data`; later frames append deduplicated by `tid`.
   */
  readonly fills: (group: HyperliquidGroup) => LiveView<UserFillsEvent["fills"]>;
};

type HttpTransport = ReturnType<typeof createHyperliquidTransport>;

export type HyperliquidLiveOptions = {
  readonly socket: HyperliquidSocket;
  readonly transport: HttpTransport;
  /** Resolves a group to the owner's master address. */
  readonly ownerOf: (group: HyperliquidGroup) => Promise<string>;
  readonly now: () => number;
  /** Snapshot retries run on the injected timer — a dead HTTP fetch must not stall a view. */
  readonly setTimer: SetTimer;
  /** Jitter source for the snapshot retry backoff. */
  readonly random: (length: number) => Uint8Array;
  /** Lock-following: a vault that is not `unlocked` closes every user view. */
  readonly wallet: Wallet;
  /**
   * Every `openOrders`/`userFills` frame is reported to the exchange — a pending unknown cloid the
   * frame carries is proven (resting) or re-asked (a fill cannot prove a full fill).
   */
  readonly sighted?: (user: string, entry: OpenOrdersEvent | UserFillsEvent) => void;
};

const TRADES_CAP = 100;
const CANDLES_WINDOW = 200;
/* Snapshot retry backoff — the socket's shape: 500 ms·2ⁿ capped at 30 s plus equal jitter. */
const SNAPSHOT_BACKOFF_MIN_MS = 500;
const SNAPSHOT_BACKOFF_MAX_MS = 30_000;

/** Milliseconds per candle interval — the snapshot window is CANDLES_WINDOW intervals deep. */
const INTERVAL_MS: Record<CandleParameters["interval"], number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

const dedupeByTid = <T extends { readonly tid: number }>(list: ReadonlyArray<T>): T[] => {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const item of list) {
    if (!seen.has(item.tid)) {
      seen.add(item.tid);
      out.push(item);
    }
  }
  return out;
};

/** `channel` and the subscribed-payload subset a view waits to see re-confirmed. */
const match =
  (channel: string, expected: unknown) =>
  (ch: string, payload: unknown): boolean =>
    ch === channel && payloadContains(expected, payload);

/* A view wrapper for starts that need an async step first (owner resolution). */
const liveFromPromise = <T>(build: () => Promise<LiveView<T>>): LiveView<T> => {
  const listeners = new Set<(state: LiveState<T>) => void>();
  let inner: LiveView<T> | undefined;
  let innerOff: (() => void) | undefined;
  let current: LiveState<T> = { status: "connecting", data: undefined, updatedAt: undefined };
  let closed = false;
  const emit = (next: LiveState<T>): void => {
    current = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  const ready = (async (): Promise<void> => {
    try {
      const built = await build();
      inner = built;
      if (closed) {
        void built.close();
        return;
      }
      innerOff = built.subscribe(emit);
      emit(built.getState());
    } catch {
      emit({ status: "stale", data: undefined, updatedAt: undefined });
    }
  })();
  return {
    getState: () => inner?.getState() ?? current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await ready;
      innerOff?.();
      await inner?.close();
      /* A user view serves account data — once closed nothing stays readable, even while the
         inner view was still being built. */
      emit({ status: "stale", data: undefined, updatedAt: undefined });
    },
  };
};

export function createHyperliquidLive(options: HyperliquidLiveOptions): HyperliquidLive {
  const { socket, transport, ownerOf, now, setTimer, random, wallet } = options;
  const jittered = (ms: number): number => ms + Math.floor(((random(1)[0] ?? 0) / 256) * ms);
  const config = { transport: socket };
  const http = { transport };
  /* Open user views — a vault lock closes them all; market views ignore it. */
  const userViews = new Set<{ close: () => Promise<void> }>();
  let walletUnsubscribe: (() => void) | undefined;

  const watchLock = (view: { close: () => Promise<void> }): void => {
    userViews.add(view);
    if (wallet.getSnapshot().vault !== "unlocked") {
      void view.close();
    }
    walletUnsubscribe ??= wallet.subscribe(() => {
      if (wallet.getSnapshot().vault !== "unlocked") {
        /* `close` removes the view from the set — iterate a copy. */
        // oxlint-disable-next-line unicorn/no-useless-spread -- the copy is the point.
        for (const v of [...userViews]) {
          void v.close();
        }
      }
    });
  };

  type SnapshotSource<T> = () => Promise<T>;

  /**
   * The shared skeleton: status bookkeeping, confirmed/status wiring, delta buffering while a
   * snapshot is in flight, and `close` teardown. `subscribeSocket` is the SDK call (its validation +
   * event filtering stay active); `matches` names the payload this view waits to see confirmed;
   * `snapshot` (delta channels only) fetches the window each confirmation opens.
   */
  const view = <M, T>(args: {
    readonly matches: (channel: string, payload: unknown) => boolean;
    readonly start: (
      listener: (message: M) => void,
      onError: (error: TransportError) => void,
    ) => Promise<ISubscription>;
    /** First-frame → data for snapshot channels; undefined for delta channels. */
    readonly snapshot?: SnapshotSource<T>;
    /** Merge one delta into the current data. */
    readonly delta?: (current: T | undefined, message: M) => T;
    /**
     * Push-channel reducer: returns the new data, or `undefined` to keep waiting (e.g. a
     * `userFills` frame before its `isSnapshot`).
     */
    readonly frame?: (current: T | undefined, message: M) => T | undefined;
    /** Account data: `close` clears it — a locked vault leaves nothing account-readable. */
    readonly accountData?: boolean;
  }): LiveView<T> => {
    const listeners = new Set<(state: LiveState<T>) => void>();
    let data: T | undefined;
    let updatedAt: number | undefined;
    let status: LiveState<T>["status"] = "connecting";
    let closed = false;
    let ready = false;
    let generation = 0;
    let subscription: ISubscription | undefined;
    const buffered: M[] = [];

    const state = (): LiveState<T> => ({ status, data, updatedAt });
    const emit = (): void => {
      const current = state();
      for (const listener of listeners) {
        listener(current);
      }
    };
    const set = (patch: Partial<LiveState<T>>): void => {
      status = patch.status ?? status;
      if ("data" in patch) {
        ({ data } = patch);
      }
      if ("updatedAt" in patch) {
        ({ updatedAt } = patch);
      }
      emit();
    };

    /* Post-confirmation: a delta view fetches its window; a snapshot view waits for the first
       frame. Either way `ready` only flips when fresh data is applied. */
    const onConfirmed = async (): Promise<void> => {
      const gen = ++generation;
      ready = false;
      buffered.length = 0;
      set({ status: "connecting" });
      if (args.snapshot === undefined) {
        return;
      }
      /* A failed fetch must not stall the view until the next reconnect — retry on the
         injected timer with the socket's backoff shape, generation-checked. */
      let snap: T | undefined;
      /* oxlint-disable eslint/no-await-in-loop -- retries are sequential by design. */
      for (let attempt = 0; snap === undefined; attempt += 1) {
        try {
          snap = await args.snapshot();
        } catch {
          if (closed || gen !== generation) {
            return;
          }
          const backoff = Math.min(SNAPSHOT_BACKOFF_MAX_MS, SNAPSHOT_BACKOFF_MIN_MS * 2 ** attempt);
          await new Promise<void>((resolve) => {
            setTimer(jittered(backoff), resolve);
          });
        }
        if (closed || gen !== generation) {
          return;
        }
      }
      if (closed || gen !== generation) {
        return;
      }
      let acc: T = snap;
      for (const message of buffered.splice(0)) {
        if (args.delta !== undefined) {
          acc = args.delta(acc, message);
        }
      }
      ready = true;
      set({ status: "live", data: acc, updatedAt: now() });
    };

    const onMessage = (message: M): void => {
      if (closed) {
        return;
      }
      if (args.snapshot !== undefined) {
        if (!ready) {
          buffered.push(message);
          return;
        }
        if (args.delta !== undefined) {
          set({ data: args.delta(data, message), updatedAt: now() });
        }
        return;
      }
      if (args.frame === undefined) {
        return;
      }
      const next = args.frame(data, message);
      if (next !== undefined) {
        ready = true;
        set({ status: "live", data: next, updatedAt: now() });
      }
    };

    const offConfirmed = socket.onConfirmed((channel, payload) => {
      if (!closed && args.matches(channel, payload)) {
        void onConfirmed();
      }
    });
    const offStatus = socket.onStatus((next) => {
      if (closed) {
        return;
      }
      if (next === "closed") {
        ready = false;
        set({ status: "stale" });
      }
    });
    const onError = (): void => {
      ready = false;
      set({ status: "stale" });
    };
    const started = (async (): Promise<void> => {
      try {
        subscription = await args.start(onMessage, onError);
      } catch {
        ready = false;
        set({ status: "stale" });
      }
    })();

    return {
      getState: state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        offConfirmed();
        offStatus();
        await started;
        await subscription?.unsubscribe();
        if (args.accountData === true) {
          set({ status: "stale", data: undefined, updatedAt: undefined });
        } else if (status !== "stale") {
          set({ status: "stale" });
        }
      },
    };
  };

  const userView = <T>(
    build: (user: string) => LiveView<T>,
    group: HyperliquidGroup,
  ): LiveView<T> => {
    /* The group resolves to its owner before subscribing; the view follows the lock. */
    const inner = liveFromPromise<T>(async () => build(await ownerOf(group)));
    const view: LiveView<T> = {
      getState: () => inner.getState(),
      subscribe: (listener) => inner.subscribe(listener),
      /* A closed user view leaves the lock set — a later lock has nothing left to close. */
      close: async () => {
        userViews.delete(view);
        await inner.close();
      },
    };
    watchLock(view);
    return view;
  };

  return {
    book: (coin, params) =>
      view<L2BookEvent, L2BookEvent>({
        matches: match("l2Book", {
          type: "l2Book",
          coin,
          ...(params?.nSigFigs === undefined ? {} : { nSigFigs: params.nSigFigs }),
        }),
        start: async (listener, onError) =>
          subL2Book(
            config,
            { coin, ...(params?.nSigFigs === undefined ? {} : { nSigFigs: params.nSigFigs }) },
            listener,
            { onError },
          ),
        frame: (_current, message) => message,
      }),
    trades: (coin) =>
      view<RecentTradesResponse[number], RecentTradesResponse>({
        matches: match("trades", { type: "trades", coin }),
        start: async (listener, onError) =>
          subTrades(
            config,
            { coin },
            (tradesEvent) => {
              for (const trade of tradesEvent) {
                listener(trade);
              }
            },
            { onError },
          ),
        snapshot: async () => dedupeByTid(await recentTrades(http, { coin })).slice(0, TRADES_CAP),
        delta: (current, message) =>
          dedupeByTid([message, ...(current ?? [])]).slice(0, TRADES_CAP),
      }),
    candles: (coin, interval) =>
      view<CandleEvent, CandleSnapshotResponse>({
        matches: match("candle", { type: "candle", coin, interval }),
        start: async (listener, onError) =>
          subCandle(config, { coin, interval }, listener, { onError }),
        snapshot: async () => {
          const endTime = now();
          return candleSnapshot(http, {
            coin,
            interval,
            startTime: Math.max(0, endTime - INTERVAL_MS[interval] * CANDLES_WINDOW),
            endTime,
          });
        },
        delta: (current, message) => {
          const rest = (current ?? []).filter((c) => c.t !== message.t);
          return [...rest, message].sort((a, b) => a.t - b.t);
        },
      }),
    account: (group) =>
      userView(
        (user) =>
          view<ClearinghouseStateEvent, ClearinghouseStateEvent>({
            matches: match("clearinghouseState", { type: "clearinghouseState", user }),
            start: async (listener, onError) =>
              subClearinghouse(config, { user }, listener, { onError }),
            frame: (_current, message) => message,
            accountData: true,
          }),
        group,
      ),
    spotState: (group) =>
      userView(
        (user) =>
          view<SpotStateEvent, SpotStateEvent>({
            matches: match("spotState", { type: "spotState", user }),
            start: async (listener, onError) =>
              subSpotState(config, { user }, listener, { onError }),
            frame: (_current, message) => message,
            accountData: true,
          }),
        group,
      ),
    openOrders: (group) =>
      userView(
        (user) =>
          view<OpenOrdersEvent, OpenOrdersEvent>({
            matches: match("openOrders", { type: "openOrders", user }),
            start: async (listener, onError) =>
              subOpenOrders(config, { user }, listener, { onError }),
            frame: (_current, message) => {
              options.sighted?.(user, message);
              return message;
            },
            accountData: true,
          }),
        group,
      ),
    fills: (group) =>
      userView(
        (user) =>
          view<UserFillsEvent, UserFillsEvent["fills"]>({
            matches: match("userFills", { type: "userFills", user }),
            start: async (listener, onError) =>
              subUserFills(config, { user }, listener, { onError }),
            frame: (current, message) => {
              options.sighted?.(user, message);
              /* The server re-sends `isSnapshot` on resubscribe — it replaces. */
              if (message.isSnapshot === true) {
                return dedupeByTid(message.fills);
              }
              if (current === undefined) {
                return undefined; // keep waiting for the snapshot frame
              }
              return dedupeByTid([...message.fills, ...current]);
            },
            accountData: true,
          }),
        group,
      ),
  };
}
