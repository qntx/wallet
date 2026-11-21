/**
 * Live views over the fake socket: confirm→snapshot→live ordering, stale on disconnect with
 * retained data, delta buffering/merge, snapshot replacement, and user views closing on lock.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { createHyperliquidLive } from "../src/apps/hyperliquid/live.ts";
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
  frames(method: string): unknown[] {
    return this.sent
      .map((f) => JSON.parse(f) as { method?: string; subscription?: unknown })
      .filter((f) => f.method === method)
      .map((f) => f.subscription);
  }
}

const OWNER = "0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd";
const GROUP = { walletId: "w1", groupIndex: 0 };

const rig = () => {
  let time = 0;
  const queue: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const sockets: FakeSocket[] = [];
  const http: Record<string, () => unknown> = {};
  const walletListeners = new Set<() => void>();
  const snapshot = { vault: "unlocked" as string };
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
    random: (length) => new Uint8Array(length).fill(0),
  });
  const runNext = (): void => {
    const [next] = queue.filter((e) => !e.cancelled).toSorted((a, b) => a.at - b.at);
    if (next !== undefined) {
      time = next.at;
      next.cancelled = true;
      next.fn();
    }
  };
  const transport = {
    request: async (_endpoint: string, payload: unknown): Promise<unknown> => {
      const { type } = payload as { type: string };
      const answer = http[type];
      await Promise.resolve();
      if (answer === undefined) {
        throw new Error(`no canned response for ${type}`);
      }
      return answer();
    },
  };
  const wallet = {
    getSnapshot: () => ({ vault: snapshot.vault }),
    subscribe: (listener: () => void) => {
      walletListeners.add(listener);
      return () => walletListeners.delete(listener);
    },
  } as unknown as Wallet;
  const live = createHyperliquidLive({
    socket,
    transport: transport as never,
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    ownerOf: async () => OWNER,
    now: () => time,
    wallet,
  });
  const confirm = (s: FakeSocket, payload: unknown): void => {
    s.push({
      channel: "subscriptionResponse",
      data: { method: "subscribe", subscription: payload },
    });
  };
  const lock = (): void => {
    snapshot.vault = "locked";
    for (const listener of walletListeners) {
      listener();
    }
  };
  return { live, socket, sockets, http, confirm, lock, runNext, now: () => time };
};

/** A macrotask flushes every queued microtask — owner resolution, SDK chains, snapshot fetches. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
};

const trade = (
  tid: number,
): {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  tid: number;
  hash: string;
} => ({
  coin: "BTC",
  side: "B",
  px: "100",
  sz: "1",
  time: tid,
  tid,
  hash: `0x${tid}`,
});

describe("hyperliquid live", () => {
  it("goes live only after confirmation and the first snapshot frame", async () => {
    const { live, sockets, confirm } = rig();
    const book = live.book("BTC");
    const s = sockets[0]!;
    s.open();
    expect(book.getState().status).toBe("connecting");
    confirm(s, s.frames("subscribe")[0]);
    await tick();
    expect(book.getState().status).toBe("connecting"); // confirmed but no frame yet
    const first = { coin: "BTC", time: 1, levels: [[{ px: "1", sz: "1", n: 1 }], []] };
    s.push({ channel: "l2Book", data: first });
    await tick();
    expect(book.getState()).toStrictEqual({ status: "live", data: first, updatedAt: 0 });
    const second = { coin: "BTC", time: 2, levels: [[{ px: "2", sz: "1", n: 1 }], []] };
    s.push({ channel: "l2Book", data: second });
    expect(book.getState().data).toStrictEqual(second); // full replacement
    await book.close();
  });

  it("keeps data but reports stale on disconnect, live again after a fresh snapshot", async () => {
    const { live, sockets, confirm, runNext } = rig();
    const book = live.book("BTC");
    let s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    s.push({ channel: "l2Book", data: { coin: "BTC", time: 1, levels: [[], []] } });
    expect(book.getState().status).toBe("live");
    s.close();
    expect(book.getState().status).toBe("stale");
    expect(book.getState().data).toBeDefined(); // retained, marked stale
    /* Reconnect: resubscribe fires on open; even re-confirmed the view stays stale until a
       fresh snapshot frame lands. */
    runNext();
    s = sockets[1]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    /* Re-confirmed but no fresh snapshot yet — reconnecting, still not live. */
    expect(book.getState().status).toBe("connecting");
    const fresh = { coin: "BTC", time: 2, levels: [[], []] };
    s.push({ channel: "l2Book", data: fresh });
    expect(book.getState()).toStrictEqual({
      status: "live",
      data: fresh,
      updatedAt: book.getState().updatedAt,
    });
    await book.close();
  });

  it("buffers trade deltas until the HTTP snapshot lands, then merges by tid", async () => {
    const { live, sockets, http, confirm } = rig();
    http["recentTrades"] = () => [trade(1), trade(2)];
    const view = live.trades("BTC");
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    /* A delta that arrives while the snapshot request is in flight must not be lost. */
    s.push({ channel: "trades", data: [trade(3)] });
    await tick();
    const state = view.getState();
    expect(state.status).toBe("live");
    expect(state.data!.map((t) => t.tid)).toStrictEqual([3, 1, 2]);
    s.push({ channel: "trades", data: [trade(2), trade(4)] });
    expect(view.getState().data!.map((t) => t.tid)).toStrictEqual([4, 2, 3, 1]);
    await view.close();
  });

  it("upserts candles by open time over the snapshot window", async () => {
    const { live, sockets, http, confirm } = rig();
    const candle = (t: number, c: string) => ({
      t,
      T: t + 60_000,
      s: "BTC",
      i: "1m",
      o: "1",
      c,
      h: "1",
      l: "1",
      v: "1",
      n: 1,
    });
    http["candleSnapshot"] = () => [candle(60_000, "1"), candle(120_000, "2")];
    const view = live.candles("BTC", "1m");
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    s.push({ channel: "candle", data: candle(180_000, "3") }); // buffered pre-snapshot
    await tick();
    expect(view.getState().data!.map((c) => c.t)).toStrictEqual([60_000, 120_000, 180_000]);
    s.push({ channel: "candle", data: candle(120_000, "9") }); // same open time → upsert
    expect(view.getState().data!.find((c) => c.t === 120_000)?.c).toBe("9");
    await view.close();
  });

  it("fills: isSnapshot replaces, deltas append deduplicated by tid", async () => {
    const { live, sockets, confirm } = rig();
    const view = live.fills(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    const fill = (tid: number) => ({ tid, coin: "BTC", px: "1", sz: "1" });
    s.push({ channel: "userFills", data: { user: OWNER, fills: [fill(1)], isSnapshot: true } });
    expect(view.getState().data!.map((f) => f.tid)).toStrictEqual([1]);
    s.push({ channel: "userFills", data: { user: OWNER, fills: [fill(2), fill(1)] } });
    expect(view.getState().data!.map((f) => f.tid)).toStrictEqual([2, 1]);
    /* A resubscription snapshot replaces whatever accumulated. */
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [fill(9)], isSnapshot: true },
    });
    expect(view.getState().data!.map((f) => f.tid)).toStrictEqual([9]);
    await view.close();
  });

  it("resolves the group to its owner for user views", async () => {
    const { live, sockets } = rig();
    void live.account(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    expect(s.frames("subscribe")).toStrictEqual([
      expect.objectContaining({ type: "clearinghouseState", user: OWNER }),
    ]);
  });

  it("openOrders streams full state", async () => {
    const { live, sockets, confirm } = rig();
    const view = live.openOrders(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    const orders = { dex: "", user: OWNER, orders: [{ coin: "BTC", oid: 1 }] };
    s.push({ channel: "openOrders", data: orders });
    await tick();
    expect(view.getState()).toMatchObject({ status: "live", data: orders });
    await view.close();
  });

  it("closes user views on lock", async () => {
    const { live, sockets, confirm, lock } = rig();
    const view = live.fills(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [{ tid: 1 }], isSnapshot: true },
    });
    expect(view.getState().status).toBe("live");
    lock();
    await tick();
    expect(view.getState().status).toBe("stale");
    /* A frame after the lock-close must not update the view. */
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [{ tid: 7 }] },
    });
    expect(view.getState().data!.map((f) => f.tid)).toStrictEqual([1]);
  });
});
