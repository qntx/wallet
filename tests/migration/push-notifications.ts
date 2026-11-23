/**
 * Push notifications: the host injects a `PushKeyStore` so the platform notification extension
 * reads payload keys while the app is closed; in-app code drives subscriptions through
 * `engine.notifications`.
 */
import type { PushKeyStore, WalletEngine } from "@qntx/wallet-engine";
import { openPush } from "@qntx/wallet-engine/push";

/** Register the provider token once per device, then opt a wallet in. */
export async function registerNotifications(
  engine: WalletEngine,
  keys: PushKeyStore,
  apnsToken: string,
  walletId: string,
): Promise<void> {
  void keys; // passed to createWalletEngine as `pushKeys`
  await engine.notifications.setToken("apns", apnsToken);
  await engine.notifications.enable(walletId);
}

/** In-app delivery: opens the provider message into a display hint for the activity list. */
export async function onPushMessage(
  engine: WalletEngine,
  message: unknown,
): Promise<string | undefined> {
  const event = await engine.notifications.receive(message);
  return event === undefined ? undefined : `${event.kind} on ${event.network}`;
}

/**
 * The extension side (iOS Notification Service Extension, Android FCM service): reads the key the
 * controller exported under the subscription id and opens the same envelope standalone.
 */
export function openInExtension(
  message: unknown,
  keys: ReadonlyArray<Uint8Array>,
): string | undefined {
  const opened = openPush(message, keys);
  return opened?.event.n;
}
