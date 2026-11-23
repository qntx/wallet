/**
 * The group's Fiat24 owner: its `evm.bip44` address on Arbitrum One — the address every Fiat24 read
 * and every request is scoped to (the same derivation polymarket's `signerOf` performs on Polygon).
 * A locked vault maps to `unlock-required`; every other failure collapses to a fixed `unavailable`
 * through `fromSdk` — kernel error messages never reach the host.
 */
import type { Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";

import type { AppGroup } from "../spi.ts";
import { Fiat24AppError, fromSdk } from "./errors.ts";

const isEvmAddress = (address: string): address is `0x${string}` =>
  /^0x[0-9a-fA-F]{40}$/.test(address);

export type Fiat24Owner = (group: AppGroup) => Promise<`0x${string}`>;

export function createFiat24Owner(wallet: Wallet): Fiat24Owner {
  return async (group) => {
    let resolved;
    try {
      resolved = await chains(wallet).account({
        walletId: group.walletId,
        groupIndex: group.groupIndex,
        template: "evm.bip44",
        network: "eip155:42161",
      });
    } catch (error) {
      /* A lock landing between the store read and this derivation is the same gate — the
         session close is event-ordered, so a kernel `locked` still maps to unlock-required. */
      if (error instanceof WalletError && error.code === "locked") {
        throw new Fiat24AppError("unlock-required", "the vault is locked");
      }
      throw fromSdk(error);
    }
    if (!("address" in resolved) || !isEvmAddress(resolved.address)) {
      throw new Fiat24AppError("unavailable", "the group has no EVM address");
    }
    return resolved.address;
  };
}
