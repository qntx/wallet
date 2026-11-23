/**
 * Push notifications: the host passes a `PushKeyStore` as `EngineOptions.pushKeys` so the platform
 * notification extension reads payload keys while the app is closed; in-app code drives
 * subscriptions through `engine.notifications`.
 */
import type { EngineOptions, PushKeyStore, WalletEngine } from "@qntx/wallet-engine";
import { openPush } from "@qntx/wallet-engine/push";

/** A shared keychain the extension can read (iOS App Group, Android app-private storage). */
type SharedKeychain = {
  readonly set: (name: string, value: Uint8Array) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
};

/** The `pushKeys` option: one item per subscription id. */
export const pushKeysOf = (keychain: SharedKeychain): PushKeyStore => ({
  put: async (id, key) => keychain.set(`qntx-push.${id}`, key),
  delete: async (id) => keychain.remove(`qntx-push.${id}`),
});

export const withPush = (options: EngineOptions, keychain: SharedKeychain): EngineOptions => ({
  ...options,
  pushKeys: pushKeysOf(keychain),
});

/** Register the provider token whenever the platform hands one out, then opt a wallet in. */
export async function registerNotifications(
  engine: WalletEngine,
  apnsToken: string,
  walletId: string,
): Promise<void> {
  await engine.notifications.setToken("apns", apnsToken);
  await engine.notifications.enable(walletId);
}

/** In-app delivery: a display hint only — history and balances reload themselves. */
export async function onPushMessage(
  engine: WalletEngine,
  message: unknown,
): Promise<string | undefined> {
  const event = await engine.notifications.receive(message);
  return event === undefined ? undefined : `${event.kind} on ${event.network}`;
}

/**
 * The extension side (iOS Notification Service Extension, Android FCM service): the keys stored
 * through `pushKeysOf` open the same envelope standalone; `undefined` keeps the fallback text.
 */
export function openInExtension(
  message: unknown,
  keys: ReadonlyArray<Uint8Array>,
): string | undefined {
  return openPush(message, keys)?.event.k;
}
