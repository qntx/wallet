/**
 * The transport-agnostic apps socket: one lazily-opened WebSocket with status transitions,
 * exponential-backoff reconnects with jitter (reset once a connection stays up `STABLE_MS`), a
 * configurable heartbeat (the ping frame text and an `isPong` predicate checked before the message
 * hook), and user close that ends reconnects. All I/O is injected (`socket` factory, `setTimer`,
 * `random`) — no ambient I/O.
 *
 * Protocol layers build on `onOpen` (resubscribe) and `onMessage` (raw frames that are not pongs);
 * the core never interprets payloads.
 */

import type { SetTimer } from "../timer.ts";

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

/** Connection lifecycle the live layers watch. */
export type AppSocketStatus = "connecting" | "open" | "closed";

/** Reconnect backoff bounds and the uptime that resets the attempt count. */
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
export const STABLE_MS = 30_000;

export type AppSocketHeartbeat = {
  /** How often the ping frame goes out. */
  readonly intervalMs: number;
  /** How long after a ping a missing pong closes the socket and reconnects. */
  readonly pongTimeoutMs: number;
  /** The frame text sent every interval — `{"method":"ping"}` or a plain `PING`. */
  readonly ping: string;
  /**
   * Checked against the raw frame text before `onMessage`: a pong clears the pending pong wait
   * and is never delivered to the protocol layer.
   */
  readonly isPong: (raw: string) => boolean;
};

export type AppSocketCoreOptions = {
  readonly url: string;
  /** The socket factory, e.g. `(url) => new WebSocket(url)`. */
  readonly socket: (url: string) => AppSocket;
  readonly setTimer: SetTimer;
  /** Jitter source — one byte scaled to [0,1) of the backoff. */
  readonly random: (length: number) => Uint8Array;
  readonly heartbeat: AppSocketHeartbeat;
  /** Runs after `open` and the heartbeat start — the protocol's resubscribe hook. */
  readonly onOpen?: () => void;
  /** Raw text frames that are not pongs — the protocol's dispatcher. */
  readonly onMessage?: (raw: string) => void;
  /**
   * Runs inside `close()` once the user-close flag and reconnect cancellation are in place but
   * before the socket drops — the protocol fails its pendings here so a reentrant call still
   * sees `closedByUser() === true` and the live socket.
   */
  readonly onUserClose?: () => void;
};

/** The connection handle a protocol layer (subscriptions, frames) builds its protocol on. */
export type AppSocketCore = {
  /** Current connection status. */
  readonly status: () => AppSocketStatus;
  /** Subscribe to status transitions; returns an unsubscribe. */
  readonly onStatus: (listener: (status: AppSocketStatus) => void) => () => void;
  /** Lazily open the socket — no-op once user-closed or while a socket exists. */
  readonly connect: () => void;
  /** The live socket's readyState, or undefined when there is no live socket. */
  readonly readyState: () => number | undefined;
  /** `socket?.send(data)` — a no-op while there is no live socket. */
  readonly send: (data: string) => void;
  /** Whether `close()` ran — guards subscribe/connect entry points. */
  readonly closedByUser: () => boolean;
  /** Ends the connection and prevents reconnects. */
  readonly close: () => void;
};

export function createAppSocketCore(options: AppSocketCoreOptions): AppSocketCore {
  const statusListeners = new Set<(status: AppSocketStatus) => void>();
  let socket: AppSocket | undefined;
  let status: AppSocketStatus = "closed";
  let closedByUser = false;
  let attempts = 0;
  let pingCancel: (() => void) | undefined;
  let pongCancel: (() => void) | undefined;
  let stableCancel: (() => void) | undefined;
  let reconnectCancel: (() => void) | undefined;

  const delay = (ms: number, fn: () => void): (() => void) => options.setTimer(ms, fn);
  const jittered = (ms: number): number =>
    ms + Math.floor(((options.random(1)[0] ?? 0) / 256) * ms);

  const setStatus = (next: AppSocketStatus): void => {
    if (status !== next) {
      status = next;
      for (const listener of statusListeners) {
        listener(next);
      }
    }
  };

  const stopHeartbeat = (): void => {
    pingCancel?.();
    pingCancel = undefined;
    pongCancel?.();
    pongCancel = undefined;
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
    pingCancel = delay(options.heartbeat.intervalMs, () => {
      socket?.send(options.heartbeat.ping);
      /* No pong within the window: the connection is dead — drop it and reconnect. */
      pongCancel = delay(options.heartbeat.pongTimeoutMs, () => socket?.close());
      armPing();
    });
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    armPing();
  };

  const onOpen = (): void => {
    setStatus("open");
    stableCancel?.();
    stableCancel = delay(STABLE_MS, () => {
      attempts = 0;
    });
    startHeartbeat();
    options.onOpen?.();
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
    const raw = typeof event.data === "string" ? event.data : "";
    if (options.heartbeat.isPong(raw)) {
      pongCancel?.();
      pongCancel = undefined;
      return;
    }
    options.onMessage?.(raw);
  };

  const connect = (): void => {
    if (closedByUser || socket !== undefined) {
      return;
    }
    setStatus("connecting");
    const next = options.socket(options.url);
    socket = next;
    /* oxlint-disable unicorn/prefer-add-event-listener -- AppSocket is the property-handler subset */
    next.onopen = onOpen;
    next.onmessage = onMessage;
    next.onclose = onClose;
    next.onerror = () => next.close();
    /* oxlint-enable unicorn/prefer-add-event-listener */
  };

  return {
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    connect,
    readyState: () => socket?.readyState,
    send: (data) => {
      socket?.send(data);
    },
    closedByUser: () => closedByUser,
    close: () => {
      closedByUser = true;
      reconnectCancel?.();
      reconnectCancel = undefined;
      options.onUserClose?.();
      socket?.close();
      socket = undefined;
      setStatus("closed");
    },
  };
}
