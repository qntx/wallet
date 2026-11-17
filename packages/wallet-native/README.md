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

Peer dependencies (exact `@qntx/*` pins are required — the host/kernel protocol and the bundled
kernel artifacts are built against those releases):

| package                      | range            |
| ---------------------------- | ---------------- |
| `@qntx/wallet`               | `0.4.0` (exact)  |
| `@qntx/nostr-native`         | `0.15.3` (exact) |
| `@qntx/spark-native`         | `0.5.2` (exact)  |
| `react-native`               | `~0.88.0`        |
| `react-native-nitro-modules` | `~0.37.1`        |

The package registers one Nitro hybrid object, `KernelHost`. Everything else the kernel needs —
keystore, passkey ceremonies, lifecycle, pbkdf2, the vault directory — is injected as JSI host
objects inside the kernel runtime and is never registered with Nitro. **No Nitro patch or
`nitro::install` call is needed in the consuming app.**

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

## Usage

```ts
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
  verifyEvent, // e.g. createEventVerifier(signing) from @qntx/nostr-native
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
- Upgrading from 0.13: the first successful `hardware` unlock moves the vault from format 3 to 4
  and adds the `device` factor (app lock off); until then `snapshot.appLock` is `true`.
- `vault.addFactor` / `vault.removeFactor` are `unsupported` here.
- `vault.reset` authenticates the device owner first, then erases the vault and all keystore
  keys. Devices without a lock screen return `verification-unavailable`. A `WalletError.detail`
  string carries the platform diagnostic
  (`"<domain>:<code>"`, e.g. `"LAErrorDomain:-5"` or
  `"android:KeyPermanentlyInvalidatedException"`) when the native layer can produce one.
- `chain.sign` prompts _before_ any secret derivation: the kernel normalizes and decodes the
  intent, shows the prompt, and only then touches key material.
- The kernel serializes ceremonies — two concurrent signing requests cannot race two system
  prompts.
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
