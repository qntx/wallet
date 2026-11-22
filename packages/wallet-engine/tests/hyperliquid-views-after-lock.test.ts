/**
 * Lock semantics for live views: a locked vault leaves no account data readable — user views report
 * `stale` with no data, never stream, and leave the lock set on close — while market views and the
 * WebSocket keep running (public data, documented as intended).
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { HyperliquidGroup } from "../src/apps/hyperliquid/agents.ts";
import { createHyperliquidLive } from "../src/apps/hyperliquid/live.ts";
import type { HyperliquidLive } from "../src/apps/hyperliquid/live.ts";
import { createHyperliquidSocket } from "../src/apps/hyperliquid/socket.ts";
import type { AppSocket } from "../src/apps/hyperliquid/socket.ts";

const OWNER = "0x000000000000000000000000000000000000dead";
const GROUP: HyperliquidGroup = { walletId: "w1", groupIndex: 0 };
const CLEARED = { status: "stale", data: undefined, updatedAt: undefined };

class FakeSocket implements AppSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
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

const trade = (tid: number) => ({
  coin: "BTC",
  side: "B",
  px: "100",
  sz: "1",
  time: tid,
  tid,
  hash: `0x${tid}`,
});

const rig = (): {
  live: HyperliquidLive;
  sockets: FakeSocket[];
  confirm: (s: FakeSocket, payload: unknown) => void;
  lock: () => void;
  unlock: () => void;
  http: Record<string, () => unknown>;
} => {
  let time = 0;
  const snapshot = { vault: "unlocked" as "locked" | "unlocked" };
  const walletListeners = new Set<() => void>();
  const sockets: FakeSocket[] = [];
  const socket = createHyperliquidSocket({
    network: "Mainnet",
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: () => () => undefined,
    random: (length) => new Uint8Array(length).fill(0),
  });
  const http: Record<string, () => unknown> = {};
  const transport = {
    request: async (_endpoint: string, payload: unknown): Promise<unknown> => {
      await Promise.resolve();
      const { type } = payload as { type: string };
      const answer = http[type];
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
    setTimer: (ms, fn) => {
      time += ms;
      void fn;
      return () => undefined;
    },
    random: (length) => new Uint8Array(length).fill(0),
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
  const unlock = (): void => {
    snapshot.vault = "unlocked";
    for (const listener of walletListeners) {
      listener();
    }
  };
  return { live, sockets, confirm, lock, unlock, http };
};

/** A macrotask flushes every queued microtask — owner resolution, SDK chains, snapshot fetches. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
};

describe("hyperliquid views after lock", () => {
  it("a live user view empties the moment the vault locks", async () => {
    const { live, sockets, confirm, lock } = rig();
    const orders = live.openOrders(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    s.push({
      channel: "openOrders",
      data: { user: OWNER, dex: "", orders: [{ coin: "BTC", oid: 1, cloid: null }] },
    });
    await tick();
    expect(orders.getState().status).toBe("live");
    lock();
    await tick();
    expect(orders.getState()).toStrictEqual(CLEARED);
    await orders.close();
  });

  it("every open user view is cleared — fills and openOrders together", async () => {
    const { live, sockets, confirm, lock } = rig();
    const fills = live.fills(GROUP);
    const orders = live.openOrders(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    for (const sub of s.frames("subscribe")) {
      confirm(s, sub);
    }
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [{ tid: 1 }], isSnapshot: true },
    });
    s.push({
      channel: "openOrders",
      data: { user: OWNER, dex: "", orders: [{ coin: "BTC", oid: 2, cloid: null }] },
    });
    await tick();
    expect(fills.getState().status).toBe("live");
    expect(orders.getState().status).toBe("live");
    lock();
    await tick();
    expect(fills.getState()).toStrictEqual(CLEARED);
    expect(orders.getState()).toStrictEqual(CLEARED);
    await fills.close();
    await orders.close();
  });

  it("a user view opened while locked serves nothing", async () => {
    const { live, sockets, confirm, lock } = rig();
    lock();
    const fills = live.fills(GROUP);
    await tick();
    /* The subscribe was already racing the close — let it resolve so the close can unwind it. */
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    await tick();
    expect(fills.getState()).toStrictEqual(CLEARED);
    await fills.close();
  });

  it("a closed user view's subscribers see the cleared state", async () => {
    const { live, sockets, confirm } = rig();
    const fills = live.fills(GROUP);
    const seen: Array<ReturnType<typeof fills.getState>> = [];
    fills.subscribe((state) => {
      seen.push(state);
    });
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [{ tid: 4 }], isSnapshot: true },
    });
    await tick();
    expect(seen.at(-1)?.data).toStrictEqual([{ tid: 4 }]);
    await fills.close();
    expect(seen.at(-1)).toStrictEqual(CLEARED);
  });

  it("closing a user view clears the account data it served", async () => {
    const { live, sockets, confirm } = rig();
    const fills = live.fills(GROUP);
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [{ tid: 3 }], isSnapshot: true },
    });
    await tick();
    expect(fills.getState().data).toStrictEqual([{ tid: 3 }]);
    await fills.close();
    expect(fills.getState()).toStrictEqual(CLEARED);
  });

  it("market data is public — market views and the socket keep running across a lock", async () => {
    const { live, sockets, confirm, lock, http } = rig();
    http["recentTrades"] = () => [trade(1)];
    const trades = live.trades("BTC");
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    await tick();
    expect(trades.getState()).toStrictEqual({
      status: "live",
      data: [trade(1)],
      updatedAt: 0,
    });
    lock();
    expect(s.readyState).toBe(1); // the WebSocket stays up — no user channel needs closing
    expect(trades.getState().status).toBe("live");
    s.push({ channel: "trades", data: [trade(2)] });
    expect(trades.getState().data).toStrictEqual([trade(2), trade(1)]);
    await trades.close();
  });
});
