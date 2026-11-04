# @qntx/wallet-native

React Native host for [`@qntx/wallet`](https://www.npmjs.com/package/@qntx/wallet): runs the
wallet kernel on its own Hermes runtime on a separate thread (the Nitro `KernelHost` object
shuttles CBOR messages to it across JSI), keeps the
encrypted vault under the platform's never-backed-up directory, and makes the platform keystore
(Secure Enclave on iOS, Android Keystore) the vault factor — every unlock and every signing
request is gated by a system user-presence prompt rendered with kernel-owned text.

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
    rpId: "example.com",
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
- `autoLock` — must be `{ platform: "native", backgroundSeconds }`. The native host owns the
  signal: it calls `host.lock()` when the app has spent `backgroundSeconds` in the background.
- `createHost` — optional factory for the `KernelHost` (a like-shaped fake in tests). A host serves one
  kernel runtime: after a lock, a wallet deletion or a crash it is spent, and the wallet calls the
  factory again for the next unlock.
  A platform authentication prompt on screen does **not** count as background time.
- `verifyEvent` — required. Checks every event the kernel signs before it is returned. There is no
  default: `@qntx/nostr`'s own verifier is the pure-JS noble backend, slow on Hermes. Pass the
  verifier the app already uses for relay events, e.g. `createEventVerifier(signing)` with
  `signing` from `@qntx/nostr-native`.

## Passkey domains

Passkey wallets need the platform's domain association:

- **iOS** — `webcredentials:<rpId>` associated domain (requires a paid developer account; free
  signing cannot hold the entitlement). **Native iOS passkeys are not implemented yet** — the
  ceremony returns `factor-unavailable`, so `createWithPasskey`/`restoreWithPasskey` cannot be
  offered on iOS; ship mnemonic restore.
- **Android** — Credential Manager resolves the RP against
  `https://<rpId>/.well-known/assetlinks.json` with
  `delegate_permission/common.get_login_creds` naming the app's package and SHA-256 signing
  certificate. Android passkeys are implemented via `androidx.credentials`.

## Vault storage and backup

- **iOS** — the vault image lives under `Application Support/qntx-wallet/`, created with
  `NSFileProtectionComplete` and `NSURLIsExcludedFromBackupKey`. Device-to-device migration and
  iCloud backups must not carry the vault: it is bound to this device's hardware factor, which
  cannot leave the Secure Enclave.
- **Android** — the vault image lives under `noBackupFilesDir/qntx-wallet`, excluded from
  Auto Backup by construction.

## Security notes

- The hardware vault factor is the only factor kind on this platform. Unlock, vault creation,
  mnemonic/key export, wallet deletion, cloud-backup enable, reset and every `chain.sign` /
  `spark.approve` request open a platform authentication ceremony with kernel-owned prompt text
  (Simplified Chinese under a `zh*` locale, English otherwise).
- `vault.reset` authenticates the device owner first, then erases the vault and all hardware
  keys. Devices without a lock screen return `factor-unavailable` — the host should send the
  user to set one up.
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
