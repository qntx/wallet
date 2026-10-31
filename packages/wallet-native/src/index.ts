import { WalletError } from "@qntx/wallet";
import type { AutoLockPolicy, PasskeyConfig, Wallet } from "@qntx/wallet";
import type { PasskeyCeremony, SetTimer } from "@qntx/wallet/host";
/**
 * `@qntx/wallet-native`: the RN host entry. `createNativeWallet` adapts a `KernelHost` (Nitro
 * hybrid from W2b, or any object with the same shape) to the wallet `connectKernel` entry — the
 * returned `Wallet` is the same type as the web/node host.
 */
import { connectKernel } from "@qntx/wallet/host";

import { spawnFromHost } from "./host.ts";
import type { KernelHostLike } from "./host.ts";
import type { KernelHost } from "./specs/kernel-host.nitro.ts";

export type NativeWalletOptions = {
  readonly passkey: PasskeyConfig;
  readonly autoLock: AutoLockPolicy;
  /**
   * The Nitro `KernelHost` hybrid object (or a like-shaped fake for tests). Defaults to
   * `NitroModules.createHybridObject("KernelHost")` — the only Nitro-registered object.
   */
  readonly host?: KernelHostLike;
  readonly ceremony?: PasskeyCeremony;
};

const setTimer: SetTimer = (delayMs, fn) => {
  const id = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(id);
  };
};

async function defaultHost(): Promise<KernelHostLike> {
  const { NitroModules } = await import("react-native-nitro-modules");
  return NitroModules.createHybridObject<KernelHost>("KernelHost");
}

export async function createNativeWallet(options: NativeWalletOptions): Promise<Wallet> {
  const { autoLock } = options;
  const host = options.host ?? (await defaultHost());
  if (autoLock.platform !== "native") {
    throw new WalletError(
      "invalid-input",
      "createNativeWallet accepts only the native autoLock policy",
    );
  }
  // The native host owns the auto-lock signal: the platform layer calls host.lock() on
  // background expiry — the kernel never sees a presence source here.
  return connectKernel({
    spawn: () => spawnFromHost(host, autoLock.backgroundSeconds),
    factors: "hardware",
    passkey: options.passkey,
    ceremony: options.ceremony,
    setTimer,
  });
}

export { spawnFromHost, type KernelHostLike, type KernelExitReason } from "./host.ts";
export {
  encodeFrame,
  decodeFrame,
  CborError,
  FRAME_MAX_BYTES,
  type CborErrorCode,
} from "./cbor.ts";
