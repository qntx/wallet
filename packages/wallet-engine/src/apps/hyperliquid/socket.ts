/**
 * An `ISubscriptionTransport` over the shared apps socket core (`../socket.ts`): subscribe/
 * unsubscribe frames, confirmation matching by "payload ⊆ echo" (most specific pending wins),
 * `{"method":"ping"}` heartbeats answered by `{channel:"pong"}`, and the server-side limits
 * enforced client-side. Matching mirrors `@nktkas/hyperliquid` `transport/websocket/_id.js`
 * (`isSubset`/`specificity`/`requestToId`) and `transport/websocket/_dispatcher.js` (queue +
 * response handling); the SDK's subscription functions consume `{ detail }` events only
 * (`api/subscription/_methods/l2Book.js` etc.).
 */
import { TransportError } from "@nktkas/hyperliquid";
import type { ISubscription, ISubscriptionTransport } from "@nktkas/hyperliquid";

import type { HyperliquidNetwork } from "@qntx/wallet/protocol";

import type { SetTimer } from "../../timer.ts";
import { createAppSocketCore } from "../socket.ts";
import type { AppSocket, AppSocketStatus } from "../socket.ts";

/* AppSocket moved to the shared core — re-exported for the paths tests and apps/index.ts import. */
export type { AppSocket } from "../socket.ts";

export type HyperliquidSocketOptions = {
  readonly network: HyperliquidNetwork;
  /** The socket factory, e.g. `(url) => new WebSocket(url)`. */
  readonly socket: (url: string) => AppSocket;
  readonly setTimer: SetTimer;
  /** Jitter source — one byte scaled to [0,1) of the backoff. */
  readonly random: (length: number) => Uint8Array;
};

export type HyperliquidSocketStatus = AppSocketStatus;

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
    /* `Object.fromEntries` makes a `__proto__` key an own property — assigning it
       (`out[key] = …`) would set the output's prototype and drop the key from the canonical
       JSON, collapsing distinct payloads onto one subscription id. */
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, normalize(item)]),
    );
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

/** `{channel:"pong"}` answers `{"method":"ping"}` — checked before the dispatcher sees the frame. */
const isPong = (raw: string): boolean => {
  try {
    const frame: unknown = JSON.parse(raw);
    return isRecord(frame) && frame["channel"] === "pong";
  } catch {
    return false;
  }
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
  const entries = new Map<string, Entry>();
  const confirmedListeners = new Set<(channel: string, payload: unknown) => void>();

  const send = (method: "subscribe" | "unsubscribe", payload: unknown): void => {
    core.send(JSON.stringify({ method, subscription: payload }));
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
        core.readyState() === OPEN
      ) {
        send("unsubscribe", entry.payload);
      }
      await Promise.resolve();
    },
  });

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

  const resubscribe = (): void => {
    for (const entry of entries.values()) {
      entry.confirmed = false;
      send("subscribe", entry.payload);
    }
  };

  const onMessage = (raw: string): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(frame)) {
      return;
    }
    const { channel } = frame;
    const { data } = frame;
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

  const core = createAppSocketCore({
    url: HYPERLIQUID_WS[options.network],
    socket: options.socket,
    setTimer: options.setTimer,
    random: options.random,
    heartbeat: {
      intervalMs: PING_MS,
      pongTimeoutMs: PONG_MS,
      ping: JSON.stringify({ method: "ping" }),
      isPong,
    },
    onOpen: resubscribe,
    onMessage,
    onUserClose: () => {
      for (const id of entries.keys()) {
        fail(id, new TransportError("the socket was closed"));
      }
    },
  });

  return {
    isTestnet: options.network === "Testnet",
    status: core.status,
    onStatus: core.onStatus,
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
      if (core.closedByUser()) {
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
      entry.timer = options.setTimer(CONFIRM_MS, () => {
        fail(id, new TransportError("the subscription was not confirmed within 10 s"));
      });
      callOptions?.signal?.addEventListener("abort", () => {
        fail(id, new TransportError("the subscription was aborted"));
      });
      entries.set(id, entry);
      core.connect();
      if (core.readyState() === OPEN) {
        send("subscribe", payload);
      }
      return promise;
    },
    close: core.close,
  };
}
