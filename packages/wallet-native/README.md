# @qntx/wallet-native

React Native host for [`@qntx/wallet`](https://www.npmjs.com/package/@qntx/wallet): runs the
wallet kernel on its own Hermes runtime on a separate thread (the Nitro `KernelHost` object
shuttles CBOR messages to it across JSI), keeps the
encrypted vault under the platform's never-backed-up directory, and makes the platform keystore
(Secure Enclave on iOS, Android Keystore) the vault factors: a silent `device` key opens the
vault for everyday use (Nostr signing, DMs, reading state, receiving), and every guarded
operation — exports, cloud-backup enable and disable, wallet and key deletion, app-lock changes, reset and
every outgoing payment — is gated by a fresh system user-presence prompt (`hardware` key) with
kernel-owned text.

```bash
npm install @qntx/wallet-native @qntx/wallet @qntx/nostr-native @qntx/spark-native
```

Peer dependencies: `@qntx/wallet`, `@qntx/nostr-native`, `@qntx/spark-native`, `react-native`
and `react-native-nitro-modules`; `@qntx/wallet-engine` is an optional peer needed only by the
`/cloud` subpath. The exact ranges are this package's `peerDependencies` — the `@qntx/*` pins
are exact because the host/kernel protocol and the bundled kernel artifacts are built against
those releases.

The package registers four Nitro hybrid objects: `KernelHost`, `SecureInputView` (the card's
secure-input surface), `CloudKitStore` on iOS and `GoogleDriveAuth` on Android (the cloud-backup
transports below). Everything else the kernel needs — keystore, passkey ceremonies, lifecycle,
pbkdf2, the vault directory — is injected as JSI host objects inside the kernel runtime and is
never registered with Nitro. **No Nitro patch or `nitro::install` call is needed in the
consuming app.**

## Expo configuration

```ts
// app.config.ts
export default {
  ios: {
    bundleIdentifier: "com.example.app",
    infoPlist: { NSFaceIDUsageDescription: "Verify your identity to unlock your wallet" },
  },
  android: { package: "com.example.app" },
  plugins: [
    ["expo-build-properties", { ios: { useFrameworks: "static" }, android: { minSdkVersion: 30 } }],
  ],
};
```

- `ios.infoPlist.NSFaceIDUsageDescription` — required: the keystore evaluates device-owner
  presence through `LAContext`, which needs the Face ID purpose string.
- `ios.useFrameworks: "static"` is supported.
- `android.minSdkVersion: 30` — required: per-use Keystore keys that accept a biometric _or_ the
  device credential need API 30 (`setUserAuthenticationParameters` semantics).

## Card wallets

Card wallets run end to end on React Native — the kernel drives the native NFC reader and
collects the access code through `SecureInput` — but **this release pins no production card
certificate anchor, so every card answers `card-not-genuine`** until a later release ships the
anchor. Keep card UI behind a flag until then.

The library's Android manifest declares nothing: a host that offers card wallets declares the NFC
and overlay entries itself — with Expo (`android.permissions` plus a `uses-feature` manifest mod)
or in `android/app/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.NFC" />
  <uses-permission android:name="android.permission.HIDE_OVERLAY_WINDOWS" />
  <uses-feature android:name="android.hardware.nfc" android:required="false" />
</manifest>
```

On iOS the host app also needs:

- The entitlement `com.apple.developer.nfc.readersession.formats` = `["TAG"]`.
- `ios.infoPlist.NFCReaderUsageDescription` — the purpose string shown under the NFC system
  panel's prompt.
- `ios.infoPlist["com.apple.developer.nfc.readersession.iso7816.select-identifiers"]` =
  `["F0716E74780101", "D2760000850101"]` — every AID a `SELECT` may name must be declared or
  CoreNFC rejects it (the wallet applet and its NDEF applet, protocol §2).

For the secure-input field, render `SecureInput` from the `@qntx/wallet-native/secure-input`
subpath wherever the wallet asks for the card's access code or short ID:

```jsx
import { callback } from "react-native-nitro-modules";

import { SecureInput } from "@qntx/wallet-native/secure-input";

<SecureInput onStateChange={callback((state) => setState(state))} />;
```

Its `onStateChange` callback (and every Nitro view callback) must be wrapped with
`callback(...)`. The component takes no other props: the kernel decides the kind and the label;
the main runtime only observes `idle | empty | filled | submitted`. The component lives on a
subpath so importing the package root does not eagerly load the Nitro view machinery.

Card operations themselves run through `card(wallet)` from `@qntx/wallet/card`: the kernel opens
the NFC session, sets its text, exchanges the APDUs and closes it; the host never touches the
reader. `SecureInput` also collects the cloud-backup password and the iOS session-approval code
on React Native.

## Usage

```ts
import { verifyEvent } from "@qntx/nostr";
import { createNativeWallet } from "@qntx/wallet-native";

const wallet = await createNativeWallet({
  passkey: {
    rpId: "wallet.example.com",
    rpName: "Example",
    walletSalt: "example/wallet",
    vaultSalt: "example/vault",
    backupSalt: "example/backup",
  },
  autoLock: { platform: "native", backgroundSeconds: 60 },
  verifyEvent, // e.g. createEventVerifier (@qntx/nostr/core) over signing from @qntx/nostr-native
});
```

- `passkey` — relying-party config for the passkey _wallet_ flow (create/restore with a synced
  passkey). `rpId`, `walletSalt` and `vaultSalt` are permanent identifiers: changing them makes
  existing passkey factors and passkey-derived wallets unrecoverable. `backupSalt` is the PRF
  salt for the cloud-backup factor — a third, distinct permanent label.
- `autoLock` — must be `{ platform: "native", backgroundSeconds }` (0, 60, 300 or 900). The
  native host owns the signal: it calls `host.lock()` when the app has spent `backgroundSeconds`
  in the background. `createNativeWallet` returns a `NativeWallet` whose
  `setAutoLock({ platform: "native", backgroundSeconds })` changes the budget at runtime — it
  applies to the live kernel immediately and to every runtime spawned later. The vault does not
  store the value; persist it in the app and pass it to `createNativeWallet` on the next launch.
- `createHost` — optional factory for the `KernelHost` (a like-shaped fake in tests). A host serves one
  kernel runtime: after a lock, a wallet deletion or a crash it is spent, and the wallet calls the
  factory again for the next unlock.
  A platform authentication prompt on screen does **not** count as background time.
- `verifyEvent` — required. Checks every event the kernel signs before it is returned. There is no
  default: `@qntx/nostr`'s own verifier is the pure-JS noble backend, slow on Hermes. Pass the
  verifier the app already uses for relay events, e.g. `createEventVerifier(signing)` with
  `signing` from `@qntx/nostr-native`.

## Passkey domains

Passkey wallets need the platform's domain association. That association is also the wallet's
trust boundary: every app and every web origin entitled to the `rpId` can evaluate the passkey's
PRF and derive a passkey wallet's seed. Use a domain that serves only the wallet, and list only
the wallet app in its association files.

- **iOS** — `webcredentials:<rpId>` associated domain (requires a paid developer account; free
  signing cannot hold the entitlement). Without the entitlement the ceremony returns
  `passkey-not-configured`, and below iOS 18 it returns `unsupported`.
- **Android** — Credential Manager resolves the RP against
  `https://<rpId>/.well-known/assetlinks.json` with
  `delegate_permission/common.get_login_creds` naming the app's package and SHA-256 signing
  certificate. Android passkeys are implemented via `androidx.credentials`.

## Cloud backup transports

The `@qntx/wallet-native/cloud` subpath adapts the platform cloud to the engine's `CloudStore`
port. Both transports move **encrypted backup envelopes only** — every byte the kernel uploads
is ciphertext produced inside the enclave; the backup key never leaves it. `GoogleDriveAuth`
additionally returns a `drive.appdata` OAuth access token: that scope touches only the app's
own hidden Drive folder and cannot move wallet value, so neither hybrid is a secret-holding
capability and registering them with Nitro is allowed.

```ts
import { createWalletEngine } from "@qntx/wallet-engine";
import type { EngineOptions } from "@qntx/wallet-engine";
import { createICloudStore, createGoogleDriveStore } from "@qntx/wallet-native/cloud";

// `Platform` from react-native; `engineOptions` are your usual EngineOptions minus `cloud`.
declare const Platform: { readonly OS: "ios" | "android" };
declare const engineOptions: Omit<EngineOptions, "cloud">;

const cloud =
  Platform.OS === "ios"
    ? createICloudStore({ container: "iCloud.org.qntx.wallet" })
    : createGoogleDriveStore();

const engine = createWalletEngine({ ...engineOptions, cloud });
// iOS only: re-sync when the iCloud account changes under the app.
if ("onAccountChange" in cloud) {
  cloud.onAccountChange(() => engine.backup.sync());
}
```

- Both `createICloudStore` and `createGoogleDriveStore` lazily create their Nitro object on
  first use; importing the subpath alone registers nothing.
- Failures reject with `CloudStoreError`; a `auth-required` on Android means call
  `store.authorize()` from a user action to run the Google consent screen, then retry the
  operation.
- **iOS** — the app needs the iCloud capability with CloudKit enabled and the container
  identifier listed under `com.apple.developer.icloud-container-identifiers` (the harness sets
  both from `EXPO_PUBLIC_ICLOUD_CONTAINER` at prebuild). The `QntxWalletBackup` record zone and
  the `Backup` record type are created by the store; the zone's schema still needs deploying to
  production in the CloudKit console — see the cloud-store owner-setup notes (§1). **A missing
  iCloud entitlement crashes `CKContainer` at first use** — that is the platform surfacing a
  configuration error, not a store fault.
- **Android** — silent token fetch works out of the box only once the project has an OAuth
  client (Android type, matching package + signing SHA-1) in the Google Cloud project
  (owner-setup §2). Without it `accessToken` reports `failed` (`not-configured`); before user
  consent it reports `auth-required`.
- Requires `@qntx/wallet-engine` as an optional peer — only this subpath imports it, so apps
  that do not ship cloud backup do not pull the engine in for it.

## Vault storage and backup

- **iOS** — the vault image lives under `Application Support/qntx-wallet/`, created with
  `NSFileProtectionComplete` and `NSURLIsExcludedFromBackupKey`. Device-to-device migration and
  iCloud backups must not carry the vault: it is bound to this device's keystore factors, which
  cannot leave the Secure Enclave.
- **Android** — the vault image lives under `noBackupFilesDir/qntx-wallet`, excluded from
  Auto Backup by construction.

## Security notes

- Two factor kinds, both device-bound and never backed up. `device` — iOS Secure Enclave P-256
  (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `.privateKeyUsage`), Android Keystore
  AES-256-GCM without user authentication (`setUnlockedDeviceRequired` from API 35; Android 12–14
  delete or refuse such keys without a lock screen) — unlocks with no UI and can never verify.
  `hardware` — the user-presence key — is the only verifying factor. The host never chooses
  factors: creating a vault always creates `device`, plus `hardware` when the device has a lock
  screen (Android prompts once for it).
- `vault.unlock()` with no argument uses `device` while `snapshot.appLock` is false and
  `hardware` (one prompt) while it is true. After an auto-lock, one `vault.unlock()` call reopens
  the vault silently.
- Every guarded call takes `verify: { kind: "hardware" }` and opens a platform authentication
  ceremony with kernel-owned prompt text (Simplified Chinese under a `zh*` locale, English
  otherwise). `{ kind: "device" }` is rejected (`invalid-input`) by the client, the wire validator
  and the kernel. Without a `hardware` factor (no lock screen) guarded calls fail with
  `verification-unavailable` and show nothing — `snapshot.verification` says so up front; send
  the user to system settings, then call `vault.enrolVerification()`.
- A `chain.sign` prompt is rendered by the kernel from its own decode of the request: amounts,
  recipients, approvals and the fee cap of a transaction; the text, sign-in fields or typed-data
  domain of a message. Android's `BiometricPrompt` shows the title and description. iOS shows the
  description on the Touch ID and device-passcode sheets only — **the Face ID sheet shows no
  custom text**, so there the verification proves presence, not that the user read the content.
- Blind signing is off on a new vault. A request is blind only when the chain decoder marks it
  so (raw bytes, typed data too large or misformed to show, an unrecognised token function,
  calldata to the signing account's own code, a Safe delegatecall or unbounded refund) and fails
  with `blind-signing-disabled` and no prompt until
  `vault.setBlindSigning(true, { kind: "hardware" })`; described requests the wallet cannot fully
  verify sign without the setting. This is the one kernel-side control that also holds on a
  Face ID device.
- App lock is optional and off by default: `vault.setAppLock(true, { kind: "hardware" })` removes
  the `device` factor and rotates the DEK, so every unlock prompts again; `false` restores it.
  With app lock off, removing the lock screen keeps the vault usable (the dead `hardware` factor
  is dropped and `verification` becomes `unavailable`); with app lock on it makes the vault
  unrecoverable on this device, as before.
- The trade-off of app lock off, stated plainly: whoever holds the unlocked phone, and a
  compromised main runtime, can act socially as the user (sign, decrypt DMs) without a prompt,
  but cannot pay, export, back up, delete, change the app lock or reset. Code running inside the
  app process on a jailbroken/rooted device can open the `device` key and therefore the whole
  vault without any user action; app lock on restores the previous guarantee. On Android 11–14
  the `device` key stays usable while the device is locked, so do not reopen the vault from
  lock-screen background work.
- This build reads and writes vault format 6 only. A vault of any other format reports
  `vault: { status: "unsupported", reason }` and every command fails with `unsupported` — the data
  is left untouched. `reason: "older"` (a pre-1.0 format) recovers only through `vault.reset` and a
  restore; `reason: "newer"` means update the app, never reset.
- `vault.addFactor` / `vault.removeFactor` are `unsupported` here, and so is the `factor`
  option on create, import and restore — the host picks the vault's factors itself.
- `vault.reset` authenticates the device owner first, then erases the vault and all keystore
  keys. Devices without a lock screen return `verification-unavailable`. A `WalletError.detail`
  string carries the platform diagnostic
  (`"<domain>:<code>"`, e.g. `"LAErrorDomain:-5"` or
  `"android:KeyPermanentlyInvalidatedException"`) when the native layer can produce one.
- `chain.sign` makes two passes over the signing secret: it derives the key material once to
  normalize and decode the request and build the prompt, wipes it before the (possibly long)
  system verification, re-checks the session, and only then derives it again and signs.
- The kernel serializes ceremonies — two concurrent signing requests cannot race two system
  prompts.
- One kernel runtime runs per process: `createNativeWallet` throws while a previous wallet is
  still live — `wallet.destroy()` it first.
- The package provides no secure view: screens that show a mnemonic or exported private key are
  the host's to protect. On Android set `FLAG_SECURE` on the window; on iOS cover the screen with
  a privacy overlay when the app resigns active — the app-switcher snapshot is written to disk.
- `kernel/generated/kernel.manifest.json` inside the package records the kernel bundle's
  SHA-256 and every pinned protocol dependency; `scripts/compile-kernel.mjs` verifies it when
  the host is natively built and fails the build on a mismatch. At kernel start the host
  checks each backend's `abiVersion`.
- On the iOS simulator the Secure Enclave token and the `.privateKeyUsage` flag are compiled
  out, so ceremonies run on software keys through the same code path. The app must be
  code-signed (the default ad-hoc "Sign to Run Locally" identity suffices) — an unsigned
  binary fails every `SecItem` call with `errSecMissingEntitlement` (-34018), surfaced as
  `unavailable`.

## License

MIT OR Apache-2.0
