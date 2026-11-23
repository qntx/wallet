import type { Fiat24ErrorCode } from "@qntx/fiat24";
/**
 * Live Fiat24 account views: one poller per open view re-reads `account(group)` every
 * {@link FIAT24_POLL_MS} on the injected one-shot timer — the next run arms only after the read
 * settles, so runs never overlap. Polling happens only while the host holds `setVisible(true)` AND
 * the vault is unlocked (the `setVisible` convention of the prices/assets controllers); a vault
 * lock — the app instance's `lock` hook — stops every view and clears its data (a locked vault
 * holds no account data, same rule as the hyperliquid account views), `unlock` resumes whatever is
 * still visible. A failed read keeps the last data and reports `stale` + the mapped error;
 * `close()` on a view or on the app stops it for good and drops the data.
 */
import type { Wallet } from "@qntx/wallet";

import type { AppGroup, SetTimer } from "../spi.ts";
import type { Fiat24AccountRead, Fiat24AccountState } from "./account.ts";
import { fromSdk } from "./errors.ts";
import type { Fiat24AppErrorCategory } from "./errors.ts";

/** The pacing the SDK README gives for advancing an in-flight flow — reused for account polls. */
export const FIAT24_POLL_MS = 15_000;

/** What a live view reports — `data` is kept while `stale`, never past a lock or a close. */
export type Fiat24LiveState = {
  readonly status: "loading" | "live" | "stale";
  readonly data: Fiat24AccountState | undefined;
  readonly updatedAt: number | undefined;
  /** The last read failure, mapped — `protocol` carries the SDK's closed `code`. */
  readonly error?:
    | {
        readonly category: Fiat24AppErrorCategory;
        readonly code?: Fiat24ErrorCode | undefined;
      }
    | undefined;
};

export type Fiat24LiveView = {
  readonly getState: () => Fiat24LiveState;
  /** Listener on every state change; returns an unsubscribe. */
  readonly subscribe: (listener: (state: Fiat24LiveState) => void) => () => void;
  /** Stops this view's polling — account data does not outlive the view. */
  readonly close: () => Promise<void>;
};

type View = {
  readonly group: AppGroup;
  state: Fiat24LiveState;
  listeners: Set<(state: Fiat24LiveState) => void>;
  closed: boolean;
  cancel: (() => void) | undefined;
  polling: boolean;
};

const CLEARED: Fiat24LiveState = {
  status: "stale",
  data: undefined,
  updatedAt: undefined,
};

export function createFiat24Live(options: {
  readonly account: Fiat24AccountRead;
  readonly wallet: Wallet;
  readonly setTimer: SetTimer;
  readonly now: () => number;
}): {
  readonly view: (group: AppGroup) => Fiat24LiveView;
  readonly setVisible: (visible: boolean) => void;
  readonly unlock: () => Promise<void>;
  readonly lock: () => void;
  readonly close: () => void;
} {
  const views = new Set<View>();
  let visible = false;
  let locked = false;
  let closedAll = false;

  const emit = (view: View): void => {
    for (const listener of view.listeners) {
      listener(view.state);
    }
  };

  const set = (view: View, next: Fiat24LiveState): void => {
    view.state = next;
    emit(view);
  };

  const active = (view: View): boolean =>
    !closedAll &&
    !view.closed &&
    visible &&
    !locked &&
    options.wallet.getSnapshot().vault === "unlocked";

  const arm = (view: View): void => {
    if (view.cancel !== undefined || !active(view)) {
      return;
    }
    view.cancel = options.setTimer(FIAT24_POLL_MS, () => {
      view.cancel = undefined;
      void poll(view);
    });
  };

  const poll = async (view: View): Promise<void> => {
    if (view.polling || !active(view)) {
      return;
    }
    view.polling = true;
    try {
      const data = await options.account(view.group);
      /* A hide or a lock that landed mid-read already marked the view — the answer is dropped,
         not applied over the cleared state. */
      if (active(view)) {
        set(view, { status: "live", data, updatedAt: options.now(), error: undefined });
      }
    } catch (error) {
      if (active(view)) {
        const mapped = fromSdk(error);
        set(view, {
          status: "stale",
          data: view.state.data,
          updatedAt: view.state.updatedAt,
          error: { category: mapped.category, code: mapped.code },
        });
      }
    } finally {
      view.polling = false;
      arm(view);
    }
  };

  /** Cancel the pending tick and drop the account data — lock and close share this. */
  const clearView = (view: View): void => {
    view.cancel?.();
    view.cancel = undefined;
    set(view, CLEARED);
  };

  return {
    view: (group) => {
      const view: View = {
        group,
        state: { status: "loading", data: undefined, updatedAt: undefined },
        listeners: new Set(),
        closed: false,
        cancel: undefined,
        polling: false,
      };
      views.add(view);
      void poll(view);
      return {
        getState: () => view.state,
        subscribe: (listener) => {
          view.listeners.add(listener);
          return () => {
            view.listeners.delete(listener);
          };
        },
        close: async () => {
          if (view.closed) {
            return;
          }
          view.closed = true;
          views.delete(view);
          clearView(view);
          await Promise.resolve();
        },
      };
    },
    setVisible: (next) => {
      if (next === visible) {
        return;
      }
      visible = next;
      for (const view of views) {
        if (visible) {
          void poll(view);
        } else {
          view.cancel?.();
          view.cancel = undefined;
          /* The view stops refreshing — its data is kept but can no longer be called live. */
          set(view, { ...view.state, status: "stale" });
        }
      }
    },
    unlock: async () => {
      locked = false;
      for (const view of views) {
        void poll(view);
      }
      await Promise.resolve();
    },
    lock: () => {
      locked = true;
      for (const view of views) {
        clearView(view);
      }
    },
    close: () => {
      closedAll = true;
      for (const view of views) {
        view.closed = true;
        clearView(view);
      }
      views.clear();
    },
  };
}
