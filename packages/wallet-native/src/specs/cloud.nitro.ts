import type { HybridObject } from "react-native-nitro-modules";

/**
 * IOS CloudKit key-value transport for encrypted backup envelopes. Everything crossing this
 * boundary is ciphertext: the native side only ever sees names, texts and a container identifier —
 * no secrets, and a failure rejects with a message containing `[qntx-cloud:<code>]` where code is
 * `unavailable | auth-required | quota | failed`, plus a detail that never names an account or
 * carries file contents.
 */
export interface CloudKitStore extends HybridObject<{ ios: "swift" }> {
  list(container: string): Promise<string[]>;
  read(container: string, name: string): Promise<string | undefined>;
  write(container: string, name: string, text: string): Promise<void>;
  remove(container: string, name: string): Promise<void>;
  setAccountListener(listener: () => void): void;
}

/**
 * Android Google sign-in for drive.appdata access tokens. `accessToken(false)` must be silent — it
 * rejects `auth-required` when consent is still missing; `accessToken(true)` may run the consent
 * flow on the foreground activity. `clearToken` drops a token the API rejected.
 */
export interface GoogleDriveAuth extends HybridObject<{ android: "kotlin" }> {
  accessToken(interactive: boolean): Promise<string>;
  clearToken(token: string): Promise<void>;
}
