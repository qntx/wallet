import { TransportError } from "@nktkas/hyperliquid";
/**
 * The reconnecting `ISubscriptionTransport` over a fake socket: frames are recorded, the test
 * opens/closes/pushes messages, timers are manual and jitter is a seeded byte.
 */
import { describe, expect, it } from "vite-plus/test";

import { createHyperliquidSocket } from "../src/apps/hyperliquid/socket.ts";
import type { AppSocket } from "../src/apps/hyperliquid/socket.ts";

class FakeSocket implements AppSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  last(): { method?: string; subscription?: unknown } {
    const raw = this.sent.at(-1);
    if (raw === undefined) {
      throw new Error("no frame sent");
    }
    return JSON.parse(raw) as { method?: string; subscription?: unknown };
  }
  count(method: string): number {
    return this.sent.filter((f) => (JSON.parse(f) as { method?: string }).method === method).length;
  }
}

const rig = (randomByte = 0) => {
  let time = 0;
  const queue: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const sockets: FakeSocket[] = [];
  const socket = createHyperliquidSocket({
    network: "Mainnet",
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: (ms, fn) => {
      const entry = { at: time + ms, fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    random: (length) => new Uint8Array(length).fill(randomByte),
  });
  /** Earliest pending delay relative to now — asserts the exact scheduled backoff. */
  const pending = (): number[] =>
    queue
      .filter((e) => !e.cancelled)
      .map((e) => e.at - time)
      .toSorted((a, b) => a - b);
  const advance = (ms: number): void => {
    time += ms;
    for (const entry of queue.filter((e) => !e.cancelled && e.at <= time)) {
      entry.cancelled = true;
      entry.fn();
    }
  };
  const runNext = (): void => {
    const [next] = queue.filter((e) => !e.cancelled).toSorted((a, b) => a.at - b.at);
    if (next !== undefined) {
      advance(next.at - time);
    }
  };
  return { socket, sockets, pending, advance, runNext, now: () => time };
};

const PAYLOAD = { type: "l2Book", coin: "BTC" };

const confirm = (s: FakeSocket, payload: unknown = PAYLOAD): void => {
  s.push({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: payload } });
};

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("hyperliquid socket", () => {
  it("connects lazily on the first subscribe and resolves on the echo", async () => {
    const { socket, sockets } = rig();
    expect(sockets).toHaveLength(0);
    const pending = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    expect(socket.status()).toBe("connecting");
    expect(sockets).toHaveLength(1);
    const s = sockets[0]!;
    s.open();
    expect(socket.status()).toBe("open");
    expect(s.last()).toStrictEqual({ method: "subscribe", subscription: PAYLOAD });
    confirm(s, { type: "l2Book", coin: "BTC" });
    await pending;
    const events: unknown[] = [];
    const eth = socket.subscribe("l2Book", { type: "l2Book", coin: "ETH" }, (e) =>
      events.push(e.detail),
    );
    confirm(s, { type: "l2Book", coin: "ETH" });
    await eth;
    await tick();
    s.push({ channel: "l2Book", data: { coin: "ETH", time: 1, levels: [[], []] } });
    expect(events).toHaveLength(1);
    socket.close();
  });

  it("matches the echo by payload-subset, hex case-insensitively", async () => {
    const { socket, sockets } = rig();
    const payload = { type: "userFills", user: "0xABCDabcdabcdabcdabcdabcdabcdabcdabcdabcd" };
    const pending = socket.subscribe("userFills", payload, () => undefined);
    const s = sockets[0]!;
    s.open();
    confirm(s, { type: "userFills", user: "0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd" });
    await expect(pending).resolves.toBeDefined(); // resolved — the hex echo lowercases
    socket.close();
  });

  it("rejects a subscribe when the confirmation times out", async () => {
    const { socket, advance } = rig();
    const pending = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    advance(10_000);
    await expect(pending).rejects.toThrow(TransportError);
    socket.close();
  });

  it("rejects the pending subscribe on an error frame naming it", async () => {
    const { socket, sockets } = rig();
    const pending = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    const s = sockets[0]!;
    s.open();
    s.push({ channel: "error", data: 'Invalid subscription: {"type":"l2Book","coin":"BTC"}' });
    await expect(pending).rejects.toThrow("Invalid subscription");
    socket.close();
  });

  it("reconnects with exact exponential backoff and seeded jitter", () => {
    const { socket, sockets, pending, runNext } = rig(0);
    void socket.subscribe("l2Book", PAYLOAD, () => undefined).catch(() => undefined);
    sockets[0]!.open();
    sockets[0]!.close();
    /* The unconfirmed subscription's 10 s confirm timer shares the queue — assert the min. */
    expect(Math.min(...pending())).toBe(500);
    runNext();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.close();
    expect(Math.min(...pending())).toBe(1000);
    runNext();
    sockets[2]!.open();
    sockets[2]!.close();
    expect(Math.min(...pending())).toBe(2000);
    socket.close();
  });

  it("keeps each backoff within [ms, 2·ms) under jitter", () => {
    const { socket, sockets, pending } = rig(255);
    void socket.subscribe("l2Book", PAYLOAD, () => undefined).catch(() => undefined);
    sockets[0]!.open();
    sockets[0]!.close();
    const [delay] = pending();
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThan(1000);
    socket.close();
  });

  it("resets the backoff after the connection stays open 30 s", () => {
    const { socket, sockets, pending, advance, runNext } = rig(0);
    void socket.subscribe("l2Book", PAYLOAD, () => undefined).catch(() => undefined);
    sockets[0]!.open();
    sockets[0]!.close(); // attempts = 1
    runNext();
    sockets[1]!.open();
    advance(30_000); // stable period elapses → attempts reset
    sockets[1]!.close();
    /* The heartbeat timer shares the queue — the reconnect is the 500 entry. */
    expect(pending()).toContain(500);
    socket.close();
  });

  it("pings every 30 s and reconnects when the pong does not come", () => {
    const { socket, sockets, advance, runNext, pending } = rig(0);
    void socket.subscribe("l2Book", PAYLOAD, () => undefined).catch(() => undefined);
    const s = sockets[0]!;
    s.open();
    advance(30_000);
    expect(s.last().method).toBe("ping");
    s.push({ channel: "pong" }); // pong in time → still one socket
    advance(30_000);
    expect(s.last().method).toBe("ping");
    advance(10_000); // no pong → dead connection is dropped
    expect(pending()).toContain(500); // backoff armed
    runNext();
    expect(sockets).toHaveLength(2);
    socket.close();
  });

  it("resubscribes every subscription after a reconnect", async () => {
    const { socket, sockets, runNext } = rig();
    const sub = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    const s1 = sockets[0]!;
    s1.open();
    confirm(s1);
    await sub;
    s1.close();
    runNext();
    const s2 = sockets[1]!;
    s2.open();
    expect(s2.last()).toStrictEqual({ method: "subscribe", subscription: PAYLOAD });
    socket.close();
  });

  it("reports a refused resubscription through that subscription's onError", async () => {
    const { socket, sockets, runNext } = rig();
    let failed: unknown;
    const sub = socket.subscribe("l2Book", PAYLOAD, () => undefined, {
      onError: (e) => {
        failed = e;
      },
    });
    const s1 = sockets[0]!;
    s1.open();
    confirm(s1);
    await sub;
    s1.close();
    runNext();
    const s2 = sockets[1]!;
    s2.open();
    s2.push({ channel: "error", data: 'Already subscribed: {"type":"l2Book","coin":"BTC"}' });
    expect(failed).toBeInstanceOf(TransportError);
    socket.close();
  });

  it("shares one server subscription and unsubscribes when the last listener leaves", async () => {
    const { socket, sockets } = rig();
    const a = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    const b = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    const s = sockets[0]!;
    s.open();
    expect(s.count("subscribe")).toBe(1);
    confirm(s);
    const subA = await a;
    const subB = await b;
    await subA.unsubscribe();
    expect(s.count("unsubscribe")).toBe(0);
    await subB.unsubscribe();
    expect(s.count("unsubscribe")).toBe(1);
    expect(s.last()).toStrictEqual({ method: "unsubscribe", subscription: PAYLOAD });
    socket.close();
  });

  it("enforces the 10-user limit", async () => {
    const { socket } = rig();
    for (let i = 0; i < 10; i += 1) {
      const user = `0x${String(i).padStart(40, "0")}`;
      void socket
        .subscribe("userFills", { type: "userFills", user }, () => undefined)
        .catch(() => undefined);
    }
    await expect(
      socket.subscribe(
        "userFills",
        { type: "userFills", user: `0x${"f".repeat(40)}` },
        () => undefined,
      ),
    ).rejects.toThrow("10-user");
    socket.close();
  });

  it("close() ends everything: pending reject, confirmed fail, no reconnect", async () => {
    const { socket, sockets, runNext } = rig();
    const dangling = socket.subscribe("l2Book", PAYLOAD, () => undefined);
    const s = sockets[0]!;
    s.open();
    let failed = false;
    void socket.subscribe("trades", { type: "trades", coin: "BTC" }, () => undefined, {
      onError: () => {
        failed = true;
      },
    });
    confirm(s, { type: "trades", coin: "BTC" });
    await tick();
    socket.close();
    await expect(dangling).rejects.toThrow(TransportError);
    expect(failed).toBe(true);
    runNext();
    expect(sockets).toHaveLength(1); // no reconnect was scheduled
    await expect(socket.subscribe("l2Book", PAYLOAD, () => undefined)).rejects.toThrow("closed");
  });

  it("exposes connection status transitions", () => {
    const { socket, sockets } = rig();
    const seen: string[] = [];
    socket.onStatus((s) => seen.push(s));
    void socket.subscribe("l2Book", PAYLOAD, () => undefined).catch(() => undefined);
    sockets[0]!.open();
    socket.close();
    expect(seen).toStrictEqual(["connecting", "open", "closed"]);
  });
});
