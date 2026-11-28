/**
 * `createFiat24Live`: polling only while visible and unlocked, the 15 s cadence on the injected
 * timer, serialized runs (a slow read never overlaps the next), `stale` with retained data on a
 * failed refresh, the lock hook clearing data and stopping polling, `unlock` resuming, and `close`
 * ending a view (or the module's `close` ending all of them) for good.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { Fiat24AccountState } from "../src/apps/fiat24/account.ts";
import { createFiat24Live, FIAT24_POLL_MS } from "../src/apps/fiat24/live.ts";
import type { AppGroup } from "../src/apps/types.ts";
import { manualTimer } from "./apps-helpers.ts";

const GROUP: AppGroup = { walletId: "w1", groupIndex: 0 };
const OWNER = "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A";

const ACCOUNT: Fiat24AccountState = {
  status: "no-account",
  owner: OWNER,
};

/** An account read that fails while `box.fail` — the flag lives outside the test's closure. */
const flaky = (box: { fail: boolean }) => async (): Promise<Fiat24AccountState> => {
  await Promise.resolve();
  if (box.fail) {
    throw new Error("endpoint down");
  }
  return ACCOUNT;
};

const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve);
  });
};

const rig = (options?: {
  readonly vault?: "unlocked" | "locked";
  readonly account?: () => Promise<Fiat24AccountState>;
}) => {
  const timers = manualTimer(1000);
  const snapshot = { vault: options?.vault ?? "unlocked" };
  const wallet = {
    getSnapshot: () => ({ vault: { status: snapshot.vault } }),
  } as unknown as Wallet;
  let reads = 0;
  const live = createFiat24Live({
    account:
      options?.account ??
      (async () => {
        reads += 1;
        await Promise.resolve();
        return ACCOUNT;
      }),
    wallet,
    setTimer: timers.setTimer,
    now: timers.now,
  });
  return {
    live,
    timers,
    snapshot,
    reads: () => reads,
  };
};

describe("fiat24 live view", () => {
  it("does not poll until the host says visible", async () => {
    const { live, timers, reads } = rig();
    const view = live.view(GROUP);
    expect(view.getState().status).toBe("loading");
    await tick();
    expect(reads()).toBe(0);
    timers.pump();
    timers.pump();
    await tick();
    expect(reads()).toBe(0);
  });

  it("reads immediately on setVisible and then on the poll cadence", async () => {
    const { live, timers, reads } = rig();
    const view = live.view(GROUP);
    live.setVisible(true);
    /* Repeating the same visibility is a no-op, not a second poll. */
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(1);
    expect(view.getState().status).toBe("live");
    expect(view.getState().data).toStrictEqual(ACCOUNT);
    expect(view.getState().updatedAt).toBe(1000);
    /* The armed tick sits FIAT24_POLL_MS out — the pump that lands on it fires the next read. */
    const armed = timers.time + FIAT24_POLL_MS;
    timers.pump();
    timers.pump();
    await tick();
    expect(reads()).toBe(2);
    expect(timers.time).toBeGreaterThanOrEqual(armed);
  });

  it("a view created while visible polls immediately", async () => {
    const { live, reads } = rig();
    live.setVisible(true);
    const view = live.view(GROUP);
    await tick();
    expect(reads()).toBe(1);
    expect(view.getState().status).toBe("live");
  });

  it("a locked vault never polls — the unlock hook resumes the visible views", async () => {
    const { live, snapshot, timers, reads } = rig({ vault: "locked" });
    live.lock();
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(0);
    snapshot.vault = "unlocked";
    /* The wallet unlocked without the app's unlock hook — still no read. */
    timers.pump();
    await tick();
    expect(reads()).toBe(0);
    await live.unlock();
    await tick();
    expect(reads()).toBe(1);
    expect(view.getState().status).toBe("live");
  });

  it("never overlaps runs: a slow read holds the next tick", async () => {
    const timers = manualTimer(1000);
    const wallet = {
      getSnapshot: () => ({ vault: { status: "unlocked" } }),
    } as unknown as Wallet;
    let release: (() => void) | undefined;
    let started = 0;
    const live = createFiat24Live({
      account: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ACCOUNT;
      },
      wallet,
      setTimer: timers.setTimer,
      now: timers.now,
    });
    live.setVisible(true);
    const view = live.view(GROUP);
    await tick();
    expect(started).toBe(1);
    /* Cadence time passes while the first read is still in flight — nothing re-fires. */
    timers.time += FIAT24_POLL_MS * 2;
    timers.pump();
    await tick();
    expect(started).toBe(1);
    release?.();
    await tick();
    expect(view.getState().status).toBe("live");
    /* The run armed its next tick only after settling. */
    timers.time += FIAT24_POLL_MS;
    timers.pump();
    await tick();
    expect(started).toBe(2);
  });

  it("a failed refresh keeps the last data and reports stale + the mapped error", async () => {
    const box = { fail: false };
    const { live, timers } = rig({ account: flaky(box) });
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    expect(view.getState().status).toBe("live");
    box.fail = true;
    timers.pump();
    timers.pump();
    await tick();
    const state = view.getState();
    expect(state.status).toBe("stale");
    expect(state.data).toStrictEqual(ACCOUNT);
    expect(state.updatedAt).toBe(1000);
    expect(state.error?.category).toBe("unavailable");
    /* A later success returns to live and clears the error. */
    box.fail = false;
    timers.pump();
    timers.pump();
    await tick();
    expect(view.getState().status).toBe("live");
    expect(view.getState().error).toBeUndefined();
  });

  it("hiding marks the data stale and stops polling; showing resumes it", async () => {
    const { live, timers, reads } = rig();
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(1);
    live.setVisible(false);
    expect(view.getState().status).toBe("stale");
    expect(view.getState().data).toStrictEqual(ACCOUNT);
    timers.pump();
    timers.pump();
    await tick();
    expect(reads()).toBe(1);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(2);
    expect(view.getState().status).toBe("live");
  });

  it("lock clears every view's data and stops polling; unlock resumes the visible ones", async () => {
    const { live, timers, reads } = rig();
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(1);
    live.lock();
    const cleared = view.getState();
    expect(cleared.status).toBe("stale");
    expect(cleared.data).toBeUndefined();
    expect(cleared.updatedAt).toBeUndefined();
    timers.pump();
    timers.pump();
    await tick();
    expect(reads()).toBe(1);
    /* The wallet is unlocked again — the app's unlock hook resumes the visible view. */
    await live.unlock();
    await tick();
    expect(reads()).toBe(2);
    expect(view.getState().status).toBe("live");
  });

  it("closing a view stops it; other views keep polling", async () => {
    const { live, timers, reads } = rig();
    const first = live.view(GROUP);
    const second = live.view({ walletId: "w1", groupIndex: 1 });
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(2);
    await first.close();
    /* A second close is a no-op. */
    await first.close();
    expect(first.getState().data).toBeUndefined();
    timers.pump();
    timers.pump();
    await tick();
    expect(reads()).toBe(3);
    expect(second.getState().status).toBe("live");
  });

  it("an unlock while a tick is armed keeps the pending schedule", async () => {
    const { live, timers, reads } = rig();
    live.view(GROUP);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(1);
    /* A redundant unlock re-polls immediately but must not drop or double the armed tick. */
    await live.unlock();
    await tick();
    expect(reads()).toBe(2);
    timers.time += FIAT24_POLL_MS;
    timers.pump();
    await tick();
    expect(reads()).toBe(3);
  });

  it("a hide while a read is in flight drops the arriving answer", async () => {
    const timers = manualTimer(1000);
    let release: (() => void) | undefined;
    const live = createFiat24Live({
      account: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ACCOUNT;
      },
      wallet: { getSnapshot: () => ({ vault: { status: "unlocked" } }) } as unknown as Wallet,
      setTimer: timers.setTimer,
      now: timers.now,
    });
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    live.setVisible(false);
    release?.();
    await tick();
    /* The read settled after the hide — its answer is dropped, not applied over the cleared
       state. */
    expect(view.getState().status).toBe("stale");
    expect(view.getState().data).toBeUndefined();
    expect(view.getState().error).toBeUndefined();
  });

  it("a hide while a read is in flight drops the arriving error too", async () => {
    const timers = manualTimer(1000);
    let rejectRead: ((error: unknown) => void) | undefined;
    const live = createFiat24Live({
      account: async () => {
        await new Promise<void>((_resolve, reject) => {
          rejectRead = reject;
        });
        return ACCOUNT;
      },
      wallet: { getSnapshot: () => ({ vault: { status: "unlocked" } }) } as unknown as Wallet,
      setTimer: timers.setTimer,
      now: timers.now,
    });
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    live.setVisible(false);
    rejectRead?.(new Error("endpoint down"));
    await tick();
    expect(view.getState().status).toBe("stale");
    expect(view.getState().error).toBeUndefined();
  });

  it("the app close stops every view for good", async () => {
    const { live, timers, reads } = rig();
    const view = live.view(GROUP);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(1);
    live.close();
    expect(view.getState().data).toBeUndefined();
    timers.pump();
    timers.pump();
    await tick();
    expect(reads()).toBe(1);
    /* Even a show cannot restart a closed module. */
    live.setVisible(false);
    live.setVisible(true);
    await tick();
    expect(reads()).toBe(1);
  });

  it("subscribers hear every transition and unsubscribe cleanly", async () => {
    const { live } = rig();
    const view = live.view(GROUP);
    const seen: string[] = [];
    const off = view.subscribe((state) => {
      seen.push(state.status);
    });
    live.setVisible(true);
    await tick();
    live.setVisible(false);
    off();
    live.setVisible(true);
    await tick();
    expect(seen).toStrictEqual(["live", "stale"]);
  });
});
