/**
 * The Fiat24 app definition: `fiat24()` returns the `AppDefinition` `createApps` builds over the
 * shared `AppContext` — the account read over the cross-checked Arbitrum One client, the visible-
 * and-unlocked live view, and the enablement record machine. `enableWhen` allows `close-only`: a
 * restricted jurisdiction may still need the read surface to wind positions down.
 */
import type { AppContext, AppDefinition, AppGroup } from "../spi.ts";
import { createFiat24Account } from "./account.ts";
import type { Fiat24AccountState } from "./account.ts";
import { createFiat24Enable } from "./enable.ts";
import { createFiat24Live } from "./live.ts";
import type { Fiat24LiveView } from "./live.ts";
import { createFiat24Owner } from "./owner.ts";
import { createFiat24Client } from "./rpc.ts";

/** The Fiat24 surface `createApps` returns under `fiat24`. */
export type Fiat24App = {
  /** The group's Fiat24 account — the SDK view over the pinned, corroborated deployment. */
  readonly account: (group: AppGroup) => Promise<Fiat24AccountState>;
  /** A 15 s account view — polls only while `setVisible(true)` and the vault is unlocked. */
  readonly live: (group: AppGroup) => Fiat24LiveView;
  /** The host's visibility signal — polling runs only while visible and unlocked. */
  readonly setVisible: (visible: boolean) => void;
};

export function fiat24(): AppDefinition<"fiat24", Fiat24App> {
  return {
    id: "fiat24",
    /* `close-only` enables too — a restricted jurisdiction still reads and winds down. */
    enableWhen: ["available", "close-only"],
    create: (context: AppContext) => {
      const account = createFiat24Account({
        owner: createFiat24Owner(context.wallet),
        client: createFiat24Client(context.networks),
      });
      const live = createFiat24Live({
        account,
        wallet: context.wallet,
        setTimer: context.setTimer,
        now: context.now,
      });
      const api: Fiat24App = {
        account,
        live: live.view,
        setVisible: live.setVisible,
      };
      return {
        api,
        provider: createFiat24Enable({ storage: context.storage }),
        unlock: live.unlock,
        lock: live.lock,
        close: live.close,
      };
    },
  };
}
