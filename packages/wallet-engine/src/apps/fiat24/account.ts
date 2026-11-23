import type { Client } from "viem";

/**
 * The group's Fiat24 account read: `loadAccount` over the cross-checked client — `deployment` is
 * never passed, so the SDK's pinned-deployment verification stays on (`verifiedBlock` asserts the
 * EIP-1967 slots of every contract the reads touch). A `contract-changed` drift is a state, not an
 * error: writes must fail closed while the deployment disagrees with the pin. Every other SDK
 * failure maps through `fromSdk` — fixed messages, no `cause`, the closed `code` carried.
 */
import { isFiat24Error } from "@qntx/fiat24";
import type { AccountStatus } from "@qntx/fiat24";
import { loadAccount } from "@qntx/fiat24/flows";
import type { AccountView } from "@qntx/fiat24/flows";

import type { AppGroup } from "../spi.ts";
import { fromSdk } from "./errors.ts";
import type { Fiat24Owner } from "./owner.ts";

/** What a group's account read settles to — the SDK `AccountView` carried verbatim. */
export type Fiat24AccountState =
  | { readonly status: "no-account"; readonly owner: `0x${string}` }
  | {
      readonly status: AccountStatus | "stale";
      readonly owner: `0x${string}`;
      readonly view: Exclude<AccountView, { readonly step: "no-account" }>;
    }
  | {
      /** The pinned deployment drifted — every write must fail closed until it settles. */
      readonly status: "contract-changed";
      readonly owner: `0x${string}`;
    };

export type Fiat24AccountRead = (group: AppGroup) => Promise<Fiat24AccountState>;

export function createFiat24Account(options: {
  readonly owner: Fiat24Owner;
  readonly client: Client;
}): Fiat24AccountRead {
  return async (group) => {
    let owner: `0x${string}`;
    try {
      owner = await options.owner(group);
    } catch (error) {
      throw fromSdk(error);
    }
    let view: AccountView;
    try {
      view = await loadAccount({ client: options.client }, { owner });
    } catch (error) {
      if (isFiat24Error(error) && error.code === "contract-changed") {
        return { status: "contract-changed", owner };
      }
      throw fromSdk(error);
    }
    return view.step === "no-account"
      ? { status: "no-account", owner }
      : { status: view.step, owner, view };
  };
}
