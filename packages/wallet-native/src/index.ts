import { WalletError } from "@qntx/wallet";
import type { NativeAutoLockPolicy, Wallet, WalletOptions } from "@qntx/wallet";
import type { SetTimer } from "@qntx/wallet/host";
/**
 * `@qntx/wallet-native`: the RN host entry. `createNativeWallet` adapts a `KernelHost` (Nitro
 * hybrid from W2b, or any object with the same shape) to the wallet `connectKernel` entry.
 * `NativeWallet` adds `setAutoLock`: changing the background lock budget applies to the live kernel
 * immediately and to every runtime spawned afterwards.
 */
import { connectKernel } from "@qntx/wallet/host";

import { spawnFromHost } from "./host.ts";
import type { KernelHostLike } from "./host.ts";
import type { KernelHost } from "./specs/kernel-host.nitro.ts";

export type NativeWallet = Wallet & {
  readonly setAutoLock: (policy: NativeAutoLockPolicy) => void;
};

export type NativeWalletOptions = WalletOptions & {
  /**
   * Creates one `KernelHost` per kernel runtime (a Nitro hybrid object, or a like-shaped fake for
   * tests). A host lives for a single runtime: after a lock or a crash it is spent, and the wallet
   * asks for a new one for the next unlock. Defaults to
   * `NitroModules.createHybridObject("KernelHost")` — the only Nitro-registered object.
   */
  readonly createHost?: () => KernelHostLike;
};

const setTimer: SetTimer = (delayMs, fn) => {
  const id = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(id);
  };
};

async function defaultHostFactory(): Promise<() => KernelHostLike> {
  const { NitroModules } = await import("react-native-nitro-modules");
  return () => NitroModules.createHybridObject<KernelHost>("KernelHost");
}

const BACKGROUND_SECONDS: ReadonlySet<number> = new Set([0, 60, 300, 900]);

export async function createNativeWallet(options: NativeWalletOptions): Promise<NativeWallet> {
  const { autoLock } = options;
  if (autoLock.platform !== "native") {
    throw new WalletError(
      "invalid-input",
      "createNativeWallet accepts only the native autoLock policy",
    );
  }
  const createHost = options.createHost ?? (await defaultHostFactory());
  let seconds: number = autoLock.backgroundSeconds;
  let live: KernelHostLike | undefined;
  // The native host owns the auto-lock signal: the platform layer calls host.lock() on
  // background expiry — the kernel never sees a presence source here.
  const wallet = await connectKernel({
    spawn: () => {
      live = createHost();
      return spawnFromHost(live, seconds);
    },
    factors: "hardware",
    passkey: options.passkey,
    verifyEvent: options.verifyEvent,
    ceremony: undefined,
    setTimer,
  });
  const setAutoLock = (policy: NativeAutoLockPolicy): void => {
    if (policy.platform !== "native" || !BACKGROUND_SECONDS.has(policy.backgroundSeconds)) {
      throw new WalletError("invalid-input", "not a native auto-lock policy");
    }
    seconds = policy.backgroundSeconds;
    live?.setBackgroundLock(policy.backgroundSeconds);
  };
  // Object.assign keeps one identity: nostr(wallet) and friends key their internals on it.
  return Object.assign(wallet, { setAutoLock });
}

export { SecureInput } from "./secure-input.ts";
export type { SecureInputProps, SecureInputState } from "./specs/secure-input.nitro.ts";
export { spawnFromHost, type KernelHostLike, type KernelExitReason } from "./host.ts";
export {
  encodeFrame,
  decodeFrame,
  CborError,
  FRAME_MAX_BYTES,
  type CborErrorCode,
} from "./cbor.ts";
