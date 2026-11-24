/**
 * The engine's one signing seam: `signingApis(wallet, devices)` returns the `chains(wallet)` api
 * with `sign` routed by the signing account's custody — vault keys sign in the kernel, a
 * hardware-custody wallet signs on its device through the host transport. Every request origin
 * (dApp, QR, internal) reaches the same dispatch, so the counterpart never learns what backs the
 * account. A device exchange starts only when `sign` runs — after the pipeline's approval — and a
 * rejected or aborted exchange fails the operation without leaving anything half-signed.
 */
import { WalletError } from "@qntx/wallet";
import type { HardwareWalletInfo, Wallet } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import type { DeviceIo } from "@qntx/wallet/hardware";
import { hardware } from "@qntx/wallet/hardware";

import type { ChainApis } from "../transactions/route.ts";

/** The host transport for one signature on a hardware wallet's device. */
export type DeviceTransport = (wallet: HardwareWalletInfo) => DeviceIo;

/**
 * `chains(wallet)` with `sign` routed by custody: vault keys sign in the kernel, a hardware wallet
 * on its device through the host transport. Members are resolved lazily — nothing calls
 * `chains(wallet)` at construction, like every other deferred chains() call in the engine.
 */
export const signingApis = (wallet: Wallet, devices: DeviceTransport | undefined): ChainApis => ({
  account: async (params) => chains(wallet).account(params),
  exportAccount: async (params) => chains(wallet).exportAccount(params),
  sign: async (params) => {
    const { account } = params.request;
    if (account.kind !== "hd") {
      // An imported key is vault material — the kernel decides.
      return chains(wallet).sign(params);
    }
    const info = wallet.getSnapshot().wallets.find((entry) => entry.walletId === account.walletId);
    if (info === undefined) {
      return chains(wallet).sign(params);
    }
    if (info.custody === "vault") {
      return chains(wallet).sign(params);
    }
    if (info.custody === "hardware") {
      if (devices === undefined) {
        throw new WalletError(
          "device-required",
          "the account signs on its hardware wallet and no device transport was given",
        );
      }
      return hardware(wallet).sign(params, devices(info));
    }
    // A custody added to WalletInfo without a dispatch row here is a compile error.
    const custody: never = info;
    throw new WalletError("unsupported", `unsupported wallet custody: ${String(custody)}`);
  },
});
