/**
 * The Fiat24 `AppProvider`: enablement is one storage record per group — `enabled` holding the
 * bytes of `{}`. There is no server-side enrollment to run and no request is ever opened:
 * `enable`/`renew` need the terms flag, write the record and settle `enabled`; `disable` deletes
 * it; `reconcile` derives the status from the record alone. The `revoke` option of `disable` has
 * nothing to reach — a group account's server-side state is the user's KYC relationship with the
 * issuer, not an app credential, so revoke is a no-op.
 */
import type { Client } from "viem";

import { getAllowances } from "@qntx/fiat24/chain";
import type { Currency } from "@qntx/fiat24/core";
import { arbitrum } from "@qntx/fiat24/deployments";

import { EngineStoreError } from "../spi.ts";
import type { AppAuthority, AppFlow, AppGroup, AppProvider, AppStorage } from "../spi.ts";
import type { Fiat24AccountRead } from "./account.ts";
import { Fiat24AppError } from "./errors.ts";
import { fromSdk } from "./errors.ts";
import type { Fiat24Owner } from "./owner.ts";

/** The group's enablement record — presence IS the fact; the payload is deliberately empty. */
const RECORD = "enabled";
const ENABLED_BYTES = new TextEncoder().encode("{}");

const errorOf = (error: unknown): { category: string; message: string } =>
  error instanceof Fiat24AppError
    ? { category: error.category, message: error.message }
    : { category: "unavailable", message: "the fiat24 enablement write failed" };

/** Run `body`; a stale flow stops writing but a thrown error still surfaces to the caller. */
const guard = async (flow: AppFlow, body: () => Promise<void>): Promise<void> => {
  try {
    await body();
  } catch (error) {
    if (!flow.stale()) {
      flow.write({ error: errorOf(error), requestId: undefined });
    }
    throw error;
  }
};

export function createFiat24Enable(options: {
  readonly storage: AppStorage;
  /** Disable cleanup — ends the group's session, drops its drafts, rejects its open requests. */
  readonly onDisable: (group: AppGroup) => void;
  /**
   * The group's reconcile pass — `reconcile` runs per group only after init opened the store, so
   * this is the earliest point persisted flows can be read.
   */
  readonly onEnabled: (group: AppGroup) => void;
  /** The group's owner EOA — the address the flows' approvals sit on. */
  readonly owner: Fiat24Owner;
  /** The corroborated Arbitrum One client every Fiat24 chain read goes through. */
  readonly client: Client;
  /** The group's account read — a `no-account` group holds no flow-granted allowance. */
  readonly account: Fiat24AccountRead;
}): AppProvider {
  const enabled = async (group: AppGroup): Promise<boolean> =>
    (await options.storage.get(group, RECORD)) !== undefined;

  const enable = async (group: AppGroup, flow: AppFlow): Promise<void> => {
    if (flow.current().status !== "enabling") {
      flow.write({ status: "enabling", error: undefined });
    }
    if (!flow.current().termsAcknowledged) {
      throw new Fiat24AppError("invalid-input", "Fiat24 terms have not been acknowledged");
    }
    await options.storage.put(group, RECORD, ENABLED_BYTES);
    flow.write({ status: "enabled", error: undefined });
  };

  return {
    error: (category, message) => new Fiat24AppError(category, message),
    groups: options.storage.groups,
    reconcile: async (group, flow) => {
      let hasRecord: boolean;
      try {
        hasRecord = await enabled(group);
      } catch (error) {
        /* A locked/closed store leaves the state untouched — the lock itself cleared it. */
        if (error instanceof EngineStoreError && error.code === "closed") {
          return;
        }
        throw error;
      }
      flow.write({ status: hasRecord ? "enabled" : "disabled", error: undefined });
      if (hasRecord) {
        options.onEnabled(group);
      }
    },
    enable: async (group, flow) => guard(flow, async () => enable(group, flow)),
    /* There is nothing to rotate — `renew` is exactly `enable`. */
    renew: async (group, flow) => guard(flow, async () => enable(group, flow)),
    disable: async (group, _options, flow) =>
      guard(flow, async () => {
        await options.storage.delete(group, RECORD);
        options.onDisable(group);
        flow.write({ status: "disabled", error: undefined });
      }),
    cancel: async (_group, flow) => {
      flow.write({ status: "disabled", error: undefined });
      await Promise.resolve();
    },
    authorities: async (group): Promise<ReadonlyArray<AppAuthority>> => {
      const state = await options.account(group);
      if (state.status === "no-account") {
        return [];
      }
      /* The §6.1 approve pairs, read live: cash×card caps, cash/USDC×deposit, F24×account —
         ordinary owner-EOA allowances the approvals inventory revokes. */
      const allowances = await getAllowances(options.client, { owner: state.owner }).catch(
        (error: unknown) => {
          throw fromSdk(error);
        },
      );
      const UINT256_MAX = 2n ** 256n - 1n;
      const rows: AppAuthority[] = [];
      const row = (holder: string, asset: string, amount: bigint): void => {
        if (amount <= 0n) {
          return;
        }
        rows.push({
          kind: "token-allowance",
          network: "eip155:42161",
          account: state.owner,
          holder,
          asset,
          ...(amount === UINT256_MAX ? {} : { limit: amount.toString() }),
          revoke: "approvals",
        });
      };
      for (const [currency, amount] of Object.entries(allowances.card)) {
        row(arbitrum.card.proxy, arbitrum.tokens[currency as Currency].proxy, amount);
      }
      for (const [asset, amount] of Object.entries(allowances.deposit)) {
        row(
          arbitrum.deposit.proxy,
          asset === "USDC" ? arbitrum.usdc : arbitrum.tokens[asset as Currency].proxy,
          amount,
        );
      }
      row(arbitrum.account.proxy, arbitrum.f24.address, allowances.account.F24);
      return rows;
    },
  };
}
