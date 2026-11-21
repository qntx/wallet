/**
 * User views follow the vault: `watchLock` registers every view it wraps and closes them all on
 * lock, while `close()` only flips the status — it keeps `data`. So after a lock the wallet's fills
 * are still readable (stale), a user view opened while locked is shut before it ever goes live, and
 * a market view — never registered — streams straight through the lock.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { createHyperliquidLive } from "../../src/apps/hyperliquid/live.ts";
import { createHyperliquidSocket } from "../../src/apps/hyperliquid/socket.ts";
import type { AppSocket } from "../../src/apps/hyperliquid/socket.ts";

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
  const time = 0;
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
    setTimer: (ms, fn) => {
      const entry = { at: time + ms, fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
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
  return { live, sockets, confirm, lock };
};

/** A macrotask flushes every queued microtask — owner resolution, SDK chains, snapshot fetches. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
};

describe("hyperliquid views across a vault lock", () => {
  it("a locked wallet's user views report stale but keep serving their data", async () => {
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
    // The lock closes the stream, not the data: the last fills stay readable.
    expect(view.getState().data).toStrictEqual([{ tid: 1 }]);
    s.push({
      channel: "userFills",
      data: { user: OWNER, fills: [{ tid: 7 }] },
    });
    expect(view.getState().data!.map((f) => f.tid)).toStrictEqual([1]);
  });

  it("a user view opened while locked is shut before it can go live", async () => {
    const { live, sockets, confirm, lock } = rig();
    lock();
    const view = live.fills(GROUP);
    await tick();
    // The lock-close is already queued; it lands once the subscribe is carried and confirmed.
    sockets[0]!.open();
    confirm(sockets[0]!, sockets[0]!.frames("subscribe")[0]);
    await tick();
    await tick();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().data).toBeUndefined();
    await view.close();
  });

  it("market views are not registered with the lock — they keep streaming", async () => {
    const { live, sockets, confirm, lock } = rig();
    const book = live.book("BTC");
    await tick();
    const s = sockets[0]!;
    s.open();
    confirm(s, s.frames("subscribe")[0]);
    const level = { coin: "BTC", levels: [[{ px: "100", sz: "1", n: 1 }], []], time: 1 };
    s.push({ channel: "l2Book", data: level });
    expect(book.getState().status).toBe("live");

    lock();
    await tick();
    // The book was never added to the lock's view set — it is still live and still updates.
    expect(book.getState().status).toBe("live");
    s.push({ channel: "l2Book", data: { ...level, time: 2 } });
    expect(book.getState().data).toMatchObject({ time: 2 });
    await book.close();
  });

  it("closed user views stay registered — a second lock is a harmless no-op on them", async () => {
    const { live, sockets, confirm, lock } = rig();
    const views = [live.fills(GROUP), live.fills(GROUP), live.fills(GROUP)];
    await tick();
    const s = sockets[0]!;
    s.open();
    for (const [index, view] of views.entries()) {
      confirm(s, s.frames("subscribe")[index]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential confirmations
      await tick();
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential closes
      await view.close();
      expect(view.getState().status).toBe("stale");
    }
    // All three remain in the registered set; a lock closes them again — each close no-ops.
    lock();
    await tick();
    for (const view of views) {
      expect(view.getState().status).toBe("stale");
    }
  });
});
