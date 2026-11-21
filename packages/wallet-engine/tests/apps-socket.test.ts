import { describe, expect, it } from "vite-plus/test";

/**
 * The protocol-agnostic app socket core (src/apps/socket.ts): lazy connect, jittered backoff,
 * heartbeat ping/pong via an injected `isPong`, status listeners, and user close. Hyperliquid's
 * socket tests exercise it through the subscription layer; these cover the core's own branches
 * (double-close, close ordering, no-op paths) with a plain-text PING/PONG heartbeat.
 */
import { BACKOFF_MIN_MS, createAppSocketCore } from "../src/apps/socket.ts";
import type { AppSocket } from "../src/apps/socket.ts";
import { manualTimers } from "./support/timers.ts";

const URL = "wss://socket.test/ws";
const PING = "PING";
const PONG = "PONG";

const fakeSocket = (): AppSocket & { sent: string[]; closed: boolean } => {
  const state = { sent: [] as string[], closed: false };
  return {
    readyState: 0,
    get sent() {
      return state.sent;
    },
    get closed() {
      return state.closed;
    },
    send: (data) => {
      state.sent.push(data);
    },
    close: () => {
      state.closed = true;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
};

const core = (
  socket: AppSocket & { sent: string[]; closed: boolean },
  extras?: {
    onOpen?: () => void;
    onMessage?: (raw: string) => void;
    onUserClose?: () => void;
    random?: (length: number) => Uint8Array;
    heartbeatMs?: number;
  },
) => {
  const timers = manualTimers();
  return {
    timers,
    core: createAppSocketCore({
      url: URL,
      socket: () => socket,
      setTimer: timers.setTimer,
      random: extras?.random ?? (() => new Uint8Array([0])),
      heartbeat: {
        intervalMs: extras?.heartbeatMs ?? 1000,
        pongTimeoutMs: 200,
        ping: PING,
        isPong: (raw) => raw === PONG,
      },
      ...(extras?.onOpen === undefined ? {} : { onOpen: extras.onOpen }),
      ...(extras?.onMessage === undefined ? {} : { onMessage: extras.onMessage }),
      ...(extras?.onUserClose === undefined ? {} : { onUserClose: extras.onUserClose }),
    }),
  };
};

describe("app socket core", () => {
  it("opens lazily and runs the heartbeat on a text protocol", async () => {
    const socket = fakeSocket();
    const messages: string[] = [];
    const { core: c, timers } = core(socket, { onMessage: (raw) => messages.push(raw) });
    expect(c.status()).toBe("closed");
    c.send(PING);
    expect(socket.sent).toHaveLength(0); // no socket yet — a silent no-op
    c.connect();
    expect(c.status()).toBe("connecting");
    c.connect(); // no-op while a socket exists
    socket.onopen?.();
    expect(c.status()).toBe("open");
    expect(c.readyState()).toBe(0);

    await timers.fire(1000);
    expect(socket.sent).toStrictEqual([PING]);
    expect(timers.armed(200)).toBe(1); // pong wait armed
    socket.onmessage?.({ data: PONG });
    expect(timers.armed(200)).toBe(0); // pong cleared the wait
    expect(messages).toHaveLength(0); // pongs never reach the protocol layer

    socket.onmessage?.({ data: "hello" });
    expect(messages).toStrictEqual(["hello"]);
    socket.onmessage?.({ data: 42 }); // non-string frames read as ""
    expect(messages).toStrictEqual(["hello", ""]);
  });

  it("drops the socket and reconnects when the pong never comes", async () => {
    const socket = fakeSocket();
    const { core: c, timers } = core(socket);
    c.connect();
    socket.onopen?.();
    await timers.fire(1000);
    await timers.fire(200);
    expect(socket.closed).toBe(true);
    socket.onclose?.();
    expect(c.status()).toBe("closed");
    expect(timers.armed()).toBe(1); // a single reconnect is armed
  });

  it("a double onclose arms only one reconnect", () => {
    const socket = fakeSocket();
    const { core: c, timers } = core(socket);
    c.connect();
    socket.onopen?.();
    socket.onclose?.();
    socket.onclose?.();
    expect(timers.armed()).toBe(1);
  });

  it("close() marks closedByUser before onUserClose and ends reconnects", () => {
    const socket = fakeSocket();
    let seenClosed = false;
    let sawLiveSocket = false;
    const { core: c, timers } = core(socket, {
      onUserClose: () => {
        seenClosed = c.closedByUser();
        /* The socket is still live inside the hook — a last frame can go out. */
        c.send("bye");
        sawLiveSocket = socket.sent.includes("bye");
        c.connect(); // reentrant connects are refused
      },
    });
    c.connect();
    socket.onopen?.();
    c.close();
    expect(seenClosed).toBe(true);
    expect(sawLiveSocket).toBe(true);
    expect(socket.closed).toBe(true);
    expect(c.status()).toBe("closed");
    socket.onclose?.();
    expect(timers.armed()).toBe(0); // no reconnect is armed
  });

  it("caps reconnect backoff at BACKOFF_MAX_MS", async () => {
    const socket = fakeSocket();
    /* Zero jitter and a heartbeat that never lands inside the backoff schedule. */
    const { core: c, timers } = core(socket, { heartbeatMs: 999_999 });
    c.connect();
    socket.onopen?.();
    const backoffs = [0, 1, 2, 3, 4, 5].map((i) => BACKOFF_MIN_MS * 2 ** i);
    for (const ms of backoffs) {
      socket.onclose?.();
      expect(timers.armed(ms)).toBe(1);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each failure is driven in order
      await timers.fire(ms);
    }
    socket.onclose?.();
    /* The 7th failure would back off 32 s — the cap clamps it to 30 s. */
    expect(timers.armed(32_000)).toBe(0);
    expect(timers.armed(30_000)).toBe(1);
  });

  it("close() before connect refuses a later connect", () => {
    const socket = fakeSocket();
    const { core: c, timers } = core(socket);
    c.close();
    c.connect();
    expect(c.status()).toBe("closed");
    expect(c.readyState()).toBeUndefined();
    socket.onclose?.();
    expect(timers.armed()).toBe(0);
  });

  it("reports transitions to status listeners and unsubscribes", () => {
    const socket = fakeSocket();
    const { core: c } = core(socket);
    const seen: string[] = [];
    const off = c.onStatus((status) => seen.push(status));
    c.connect();
    socket.onopen?.();
    off();
    socket.onclose?.();
    expect(seen).toStrictEqual(["connecting", "open"]);
  });
});
