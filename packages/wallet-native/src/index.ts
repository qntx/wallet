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

export type NativeWalletOptions = {
  readonly passkey: PasskeyConfig;
  readonly autoLock: AutoLockPolicy;
  /** The Nitro `KernelHost` hybrid object (or a like-shaped fake for tests). */
  readonly host: KernelHostLike;
  readonly ceremony?: PasskeyCeremony;
};

const setTimer: SetTimer = (delayMs, fn) => {
  const id = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(id);
  };
};

export async function createNativeWallet(options: NativeWalletOptions): Promise<Wallet> {
  const { autoLock, host } = options;
  if (autoLock.platform !== "native") {
    throw new WalletError(
      "invalid-input",
      "createNativeWallet accepts only the native autoLock policy",
    );
  }
  // The native host owns the auto-lock signal: the platform layer calls host.lock() on
  // background expiry — the kernel never sees a presence source here.
  return connectKernel({
    spawn: () => spawnFromHost(host),
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
