/**
 * An `ISubscriptionTransport` over one lazily-opened socket: subscribe/unsubscribe frames,
 * confirmation matching by "payload ⊆ echo" (most specific pending wins), heartbeat pings,
 * exponential-backoff reconnects with resubscription, and the server-side limits enforced
 * client-side. All I/O is injected (`socket` factory, `setTimer`, `random`) — no ambient I/O.
 * Matching mirrors `@nktkas/hyperliquid` `transport/websocket/_id.js` (`isSubset`/
 * `specificity`/`requestToId`) and `transport/websocket/_dispatcher.js` (queue + response
 * handling); the SDK's subscription functions consume `{ detail }` events only
 * (`api/subscription/_methods/l2Book.js` etc.).
 */
import { TransportError } from "@nktkas/hyperliquid";
import type { ISubscription, ISubscriptionTransport } from "@nktkas/hyperliquid";

import type { HyperliquidNetwork } from "@qntx/wallet/protocol";

import type { SetTimer } from "../../timer.ts";

/* oxlint-disable typescript/no-restricted-types -- the standard WebSocket handler fields are `| null` */
/** The WebSocket property-handler subset every runtime provides (browser, RN, Node ≥ 22). */
export type AppSocket = {
  readonly readyState: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};
/* oxlint-enable typescript/no-restricted-types */

export type HyperliquidSocketOptions = {
  readonly network: HyperliquidNetwork;
  /** The socket factory, e.g. `(url) => new WebSocket(url)`. */
  readonly socket: (url: string) => AppSocket;
  readonly setTimer: SetTimer;
  /** Jitter source — one byte scaled to [0,1) of the backoff. */
  readonly random: (length: number) => Uint8Array;
};

/** Connection lifecycle the live layer watches. */
export type HyperliquidSocketStatus = "connecting" | "open" | "closed";

export type HyperliquidSocket = ISubscriptionTransport & {
  readonly isTestnet: boolean;
  /** Current connection status. */
  readonly status: () => HyperliquidSocketStatus;
  /** Subscribe to status transitions; returns an unsubscribe. */
  readonly onStatus: (listener: (status: HyperliquidSocketStatus) => void) => () => void;
  /**
   * Per-subscription `confirmed` transitions — initial AND every re-confirmation after a reconnect.
   * The listener gets the channel and the subscribed payload.
   */
  readonly onConfirmed: (listener: (channel: string, payload: unknown) => void) => () => void;
  /** Ends every subscription and prevents reconnects. */
  readonly close: () => void;
};

export const HYPERLIQUID_WS: Record<HyperliquidNetwork, string> = {
  Mainnet: "wss://api.hyperliquid.xyz/ws",
  Testnet: "wss://api.hyperliquid-testnet.xyz/ws",
};

const OPEN = 1;
const PING_MS = 30_000;
const PONG_MS = 10_000;
const CONFIRM_MS = 10_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const STABLE_MS = 30_000;
const MAX_SUBSCRIPTIONS = 1000;
const MAX_USERS = 10;

const HEX = /^0x[0-9a-f]+$/i;

const normalize = (value: unknown): unknown => {
  if (typeof value === "string" && HEX.test(value)) {
    return value.toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    const entries: Array<[string, unknown]> = Object.entries(value);
    for (const [key, item] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[key] = normalize(item);
    }
    return out;
  }
  return value;
};

const idOf = (value: unknown): string => JSON.stringify(normalize(value));

const specificity = (value: unknown): number =>
  typeof value === "object" && value !== null
    ? Object.values(value).reduce<number>((sum: number, item) => sum + specificity(item), 0)
    : 1;

const isSubset = (subset: unknown, superset: unknown): boolean => {
  if (typeof subset === "string" && typeof superset === "string") {
    return HEX.test(subset) && HEX.test(superset)
      ? subset.toLowerCase() === superset.toLowerCase()
      : subset === superset;
  }
  if (
    typeof subset !== "object" ||
    typeof superset !== "object" ||
    subset === null ||
    superset === null
  ) {
    return subset === superset;
  }
  if (Array.isArray(subset)) {
    return (
      Array.isArray(superset) &&
      subset.length === superset.length &&
      subset.every((item, i) => isSubset(item, (superset as unknown[])[i]))
    );
  }
  const sup = new Map<string, unknown>(Object.entries(superset));
  return Object.entries(subset).every(([key, item]) => isSubset(item, sup.get(key)));
};

/**
 * `subset ⊆ superset` with hex strings compared case-insensitively — the same rule the confirmation
 * matching uses; the live layer matches `onConfirmed` payloads with it.
 */
export const payloadContains: (subset: unknown, superset: unknown) => boolean = isSubset;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const userOf = (payload: unknown): string | undefined => {
  const user = isRecord(payload) ? payload["user"] : undefined;
  return typeof user === "string" ? user.toLowerCase() : undefined;
};

/* `CustomEvent<never>` params accept every `CustomEvent<T>` listener — the SDK's subscription
   functions only ever read `e.detail` — so listener storage needs no cast. */
type Listener = (event: CustomEvent<never>) => void;

type Entry = {
  readonly channel: string;
  readonly payload: unknown;
  readonly listeners: Set<Listener>;
  resolve: (subscription: ISubscription) => void;
  reject: (error: Error) => void;
  readonly onError?: (error: TransportError) => void;
  /** Gates dispatch — cleared on resubscribe until the echo returns. */
  confirmed: boolean;
  /** Whether the subscribe promise already resolved — decides `reject` vs `onError` on fail. */
  resolved: boolean;
  timer?: (() => void) | undefined;
};

export function createHyperliquidSocket(options: HyperliquidSocketOptions): HyperliquidSocket {
  const url = HYPERLIQUID_WS[options.network];
  const entries = new Map<string, Entry>();
  const statusListeners = new Set<(status: HyperliquidSocketStatus) => void>();
  const confirmedListeners = new Set<(channel: string, payload: unknown) => void>();
  let socket: AppSocket | undefined;
  let status: HyperliquidSocketStatus = "closed";
  let closedByUser = false;
  let attempts = 0;
  let pingCancel: (() => void) | undefined;
  let pongCancel: (() => void) | undefined;
  let stableCancel: (() => void) | undefined;
  let reconnectCancel: (() => void) | undefined;

  const delay = (ms: number, fn: () => void): (() => void) => options.setTimer(ms, fn);
  const jittered = (ms: number): number =>
    ms + Math.floor(((options.random(1)[0] ?? 0) / 256) * ms);

  const setStatus = (next: HyperliquidSocketStatus): void => {
    if (status !== next) {
      status = next;
      for (const listener of statusListeners) {
        listener(next);
      }
    }
  };

  const send = (method: "subscribe" | "unsubscribe", payload: unknown): void => {
    socket?.send(JSON.stringify({ method, subscription: payload }));
  };

  /** Each caller's unsubscribe drops its own listener; the wire frame goes when the last leaves. */
  const unsubscribe = (id: string, listener: Listener): ISubscription => ({
    unsubscribe: async () => {
      const entry = entries.get(id);
      entry?.listeners.delete(listener);
      if (
        entry !== undefined &&
        entry.listeners.size === 0 &&
        entries.delete(id) &&
        socket?.readyState === OPEN
      ) {
        send("unsubscribe", entry.payload);
      }
      await Promise.resolve();
    },
  });

  const stopHeartbeat = (): void => {
    pingCancel?.();
    pingCancel = undefined;
    pongCancel?.();
    pongCancel = undefined;
  };

  const fail = (id: string, error: TransportError): void => {
    const entry = entries.get(id);
    if (entry === undefined) {
      return;
    }
    entry.timer?.();
    entries.delete(id);
    if (entry.resolved) {
      entry.onError?.(error);
    } else {
      entry.reject(error);
    }
  };

  /* Reconnect: every non-user close/error retries — `close()` is the only way out. */
  const scheduleReconnect = (): void => {
    if (closedByUser || reconnectCancel !== undefined) {
      return;
    }
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempts);
    attempts += 1;
    reconnectCancel = delay(jittered(backoff), () => {
      reconnectCancel = undefined;
      connect();
    });
  };

  const armPing = (): void => {
    pingCancel = delay(PING_MS, () => {
      socket?.send(JSON.stringify({ method: "ping" }));
      /* No pong within the window: the connection is dead — drop it and reconnect. */
      pongCancel = delay(PONG_MS, () => socket?.close());
      armPing();
    });
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    armPing();
  };

  const resubscribe = (): void => {
    for (const entry of entries.values()) {
      entry.confirmed = false;
      send("subscribe", entry.payload);
    }
  };

  const onOpen = (): void => {
    setStatus("open");
    stableCancel?.();
    stableCancel = delay(STABLE_MS, () => {
      attempts = 0;
    });
    startHeartbeat();
    resubscribe();
  };

  const onClose = (): void => {
    stopHeartbeat();
    stableCancel?.();
    stableCancel = undefined;
    setStatus("closed");
    socket = undefined;
    if (!closedByUser) {
      scheduleReconnect();
    }
  };

  const onMessage = (event: { readonly data: unknown }): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    if (!isRecord(frame)) {
      return;
    }
    const { channel } = frame;
    const { data } = frame;
    if (channel === "pong") {
      pongCancel?.();
      pongCancel = undefined;
      return;
    }
    if (channel === "subscriptionResponse") {
      /* The echo names the subscription; the most specific pending payload contained in it
         wins (mirrors _dispatcher.js). */
      const echo = isRecord(data) ? data["subscription"] : undefined;
      const [winner] = [...entries.entries()]
        .filter(([, entry]) => !entry.confirmed && isSubset(entry.payload, echo))
        .sort(([, a], [, b]) => specificity(b.payload) - specificity(a.payload));
      if (winner !== undefined) {
        const [id, entry] = winner;
        entry.timer?.();
        entry.timer = undefined;
        entry.confirmed = true;
        entry.resolved = true;
        const [first] = entry.listeners;
        entry.resolve(unsubscribe(id, first ?? (() => undefined)));
        for (const listener of confirmedListeners) {
          listener(entry.channel, entry.payload);
        }
      }
      return;
    }
    if (channel === "error") {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const [target] =
        [...entries.entries()].find(
          ([id, entry]) =>
            !entry.confirmed &&
            (text.includes("Already subscribed") ||
              text.includes("Invalid subscription") ||
              text.includes(idOf(entry.payload)) ||
              text.includes(id)),
        ) ?? [];
      if (target !== undefined) {
        fail(target, new TransportError(text));
      }
      return;
    }
    /* Data frames carry the subscription's channel name; several payloads can share one
       channel (the SDK's listeners filter, e.g. `e.detail.coin === coin`). */
    for (const entry of entries.values()) {
      if (entry.channel === channel && entry.confirmed) {
        // The SDK's listeners only read `e.detail` (api/subscription/_methods) — a plain
        // object stands in for the DOM CustomEvent class the type names.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const event = { detail: data } as CustomEvent<never>;
        for (const listener of entry.listeners) {
          listener(event);
        }
      }
    }
  };

  const connect = (): void => {
    if (closedByUser || socket !== undefined) {
      return;
    }
    setStatus("connecting");
    const next = options.socket(url);
    socket = next;
    /* oxlint-disable unicorn/prefer-add-event-listener -- AppSocket is the property-handler subset */
    next.onopen = onOpen;
    next.onmessage = onMessage;
    next.onclose = onClose;
    next.onerror = () => next.close();
    /* oxlint-enable unicorn/prefer-add-event-listener */
  };

  return {
    isTestnet: options.network === "Testnet",
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onConfirmed: (listener) => {
      confirmedListeners.add(listener);
      return () => {
        confirmedListeners.delete(listener);
      };
    },
    subscribe: async <T>(
      channel: string,
      payload: unknown,
      listener: (data: CustomEvent<T>) => void,
      callOptions?: { signal?: AbortSignal; onError?: (error: TransportError) => void },
    ): Promise<ISubscription> => {
      if (closedByUser) {
        throw new TransportError("the socket is closed");
      }
      const id = `${channel}:${idOf(payload)}`;
      const existing = entries.get(id);
      if (existing !== undefined) {
        /* Identical payloads share one server subscription — the listener rides along and
           resolves (or rejects) with the same pending request. */
        const own: Listener = listener;
        existing.listeners.add(own);
        if (existing.confirmed) {
          return unsubscribe(id, own);
        }
        return new Promise<ISubscription>((resolve, reject) => {
          const { resolve: outerResolve, reject: outerReject } = existing;
          existing.resolve = (sub) => {
            outerResolve(sub);
            resolve(unsubscribe(id, own));
          };
          existing.reject = (error) => {
            outerReject(error);
            reject(error);
          };
        });
      }
      /* Client-side limits: ≤ 1000 subscriptions, ≤ 10 distinct users (docs rate-limits). */
      const users = new Set(
        [...entries.values()]
          .map((entry) => userOf(entry.payload))
          .filter((user): user is string => user !== undefined),
      );
      const user = userOf(payload);
      if (user !== undefined) {
        users.add(user);
      }
      if (entries.size >= MAX_SUBSCRIPTIONS) {
        throw new TransportError("the 1000-subscription limit is reached");
      }
      if (users.size > MAX_USERS) {
        throw new TransportError("the 10-user subscription limit is reached");
      }
      const entry: Entry = {
        channel,
        payload,
        listeners: new Set<Listener>([listener]),
        resolve: () => undefined,
        reject: () => undefined,
        ...(callOptions?.onError === undefined ? {} : { onError: callOptions.onError }),
        confirmed: false,
        resolved: false,
      };
      const promise = new Promise<ISubscription>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.timer = delay(CONFIRM_MS, () => {
        fail(id, new TransportError("the subscription was not confirmed within 10 s"));
      });
      callOptions?.signal?.addEventListener("abort", () => {
        fail(id, new TransportError("the subscription was aborted"));
      });
      entries.set(id, entry);
      connect();
      if (socket?.readyState === OPEN) {
        send("subscribe", payload);
      }
      return promise;
    },
    close: () => {
      closedByUser = true;
      reconnectCancel?.();
      reconnectCancel = undefined;
      for (const id of entries.keys()) {
        fail(id, new TransportError("the socket was closed"));
      }
      socket?.close();
      socket = undefined;
      setStatus("closed");
    },
  };
}
