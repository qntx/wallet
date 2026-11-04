import type { SignedEvent } from "./protocol/nostr.ts";
import type { AutoLockPolicy, PasskeyConfig } from "./types.ts";

export type WalletOptions = {
  readonly passkey: PasskeyConfig;
  readonly autoLock: AutoLockPolicy;
  /**
   * Verifies the signature of every event the kernel signs, before the wallet hands it back.
   * Required, with no default: `@qntx/nostr`'s own `verifyEvent` is bound to the pure-JS noble
   * backend, which costs tens of milliseconds per event on Hermes. Pass the verifier your app
   * already uses for relay events (for example `createEventVerifier(nativeBackend)`), so an event
   * is verified once, natively, and the wallet shares its cache.
   */
  readonly verifyEvent: (event: SignedEvent) => boolean;
};
