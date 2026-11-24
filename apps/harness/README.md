# V1 Harness

## Social smoke (default on launch)

The app now boots into the W2b social smoke through `createNativeWallet` (Nitro
`KernelHost` → real kernel + file-backed vault): first launch creates a 12-word
mnemonic vault with the quiz ceremony, Nostr-signs and verifies an event, then
locks; **relaunch the app** and it unlocks the persisted vault through the
system verification — a cancelled prompt refuses (`unlock-cancelled`), an
approved one unlocks (`unlock-persisted`). Each step prints a machine-readable `SMOKE_RESULT
<name> <ok|fail> <detail>` line to the console (Metro / logcat), ending with
`SMOKE_RESULT done ok`.

Run the V1 probe suite instead with `EXPO_PUBLIC_V1_PROBES=1` at bundle time.

The passkey steps (`smoke-passkey-*`) run the native WebAuthn ceremony on both
platforms. iOS needs the paid Apple team (`RU84U75XZM` in `app.config.ts`) so
the `webcredentials:wallet-harness.qntx.org` associated domain provisions; the
AASA and asset-links files are served by `apps/harness/relying-party`, which
also hosts the built playground on the same rpId for Web↔iOS comparison.

Expo/React Native harness app that runs the V1 gate measurements for the isolated
Hermes kernel runtime (`modules/v1-probe` (probe entry) + `packages/wallet-native` (kernel runtime)). It bundles the wallet kernel and a set
of probe scripts into `cpp/generated/probes.hpp`, drives them from a Nitro
`HybridObject` (`V1Probe`), and prints one `V1_RESULT` JSON line per measurement —
with provenance (commit, build config, OS/device, Nitro version + patch hash,
hermesc version) — to stderr (iOS) or logcat tag `V1Probe` (Android).

## Prerequisites

- bun, Xcode + CocoaPods (`ios/Pods` must be installed — run `pod install` in
  `ios/` after a `expo prebuild` or when C++ sources change)
- Android SDK + NDK and a Java runtime (Android Studio's JBR works via
  `JAVA_HOME`/`ANDROID_HOME`)

## Setup

```bash
bun install
```

`bun install` applies `patches/react-native-nitro-modules@0.37.1.patch` through
`patchedDependencies`. The patch serializes Nitro's process-wide JSI caches —
they race when a second jsi::Runtime is created on a kernel thread while the
main runtime is alive (observed as a SIGSEGV inside `unordered_map::emplace`
during `nitro::install`). Drop the patch once upstream fixes the cache races.

After changing `modules/v1-probe/src/specs/v1-probe.nitro.ts` regenerate the
committed bindings:

```bash
cd modules/v1-probe && bun run codegen
```

After changing `probes/*.ts` regenerate the embedded scripts + provenance
constants (at the repo root):

```bash
bun run harness:bundles
```

`expo prebuild` regenerates the gitignored `ios/` and `android/` dirs; run
`pod install` inside `ios/` afterwards.

The harness links `@qntx/wallet-native`, `@qntx/wallet`, `@qntx/wallet-chains` and
`@qntx/v1-probe` via `link:` deps — `node_modules/@qntx/*` are symlinks to the
live `packages/*` trees, so Metro resolution and native autolinking always see
the current source. `file:` deps are copied at install time, which made the
copies go stale whenever a package's `dist/` was rebuilt after install; `link:`
removes that class of bug. After changing a package just rebuild its `dist/`
before building the app — no reinstall or copy refresh is needed:

```bash
bun run --cwd packages/wallet build    # repo root, as needed
```

## Running

Build the app normally (`expo run:ios` / `expo run:android`, or xcodebuild /
Gradle release builds). The probe suite starts on launch and takes a few
minutes. On Android, capture results with:

```bash
adb logcat -s V1Probe
```

logd truncates messages at ~1 KiB, so long `V1_RESULT` lines are emitted as
`V1_RESULT <json-prefix>` followed by `V1_CONT <continuation>` chunks and a
`V1_END` terminator — concatenate the chunk payloads in order to reassemble one
JSON record per line (see `results/` for jsonl captures).

## Host tests

The kernel runtime is also exercised directly on macOS (no device/simulator):

```bash
bun run native:host-test        # repo root
```

Builds ASan/UBSan, TSan and -O2 variants of `tests/host/RuntimeHostTest.cpp`
against the Pods hermes-engine macOS slice and runs every case in a fresh
process. Requires `pod install` in `ios/` first.

## Gate note

Simulator/emulator runs are smoke verification. The required gate measurement
is a release run on the iPhone Air (physical device); the pass budgets are
defined for that device.

## Card surfaces

`EXPO_PUBLIC_CARD_SURFACES=1` swaps the probe suite for the trusted-card page:
a plain decoy `TextInput` next to the native `SecureInput`, driven by the
`card-surfaces` kernel probe. The kernel owns every access-code/short-ID
request, the sheet prompt and all APDUs; the page only sees
`idle | empty | filled | submitted`.

Run the scripted flow and check for leaks:

```bash
bun scripts/card-surfaces-run.ts android   # Metro + emulator, adb-driven
```

The driver waits on `CARD_STEP` markers, types through the OS, and captures
only the app process log. `src/leak-recorder.ts` (installed in `index.ts`
before any Nitro object exists) tees every `console.*` call, every hybrid
method argument/result, `onStateChange` payloads and React state into
`CARD_LEAK_RECORD` lines; `scripts/card-leak-check.ts` then fails if the
access code or short ID appears anywhere in the capture — plain, hex,
base64/base64url, UTF-16LE hex or decimal byte lists — while requiring the
decoy (positive control), `match:true` results, the cancel path, both fake-reader
taps, the device-reader result, and the kernel prompt on the native
`CARD_SHEET_OPEN` channel but never in `CARD_LEAK_RECORD`.

On iOS use the booted simulator (`idb ui text`/`idb ui key` types into the
trusted field) and capture with `xcrun simctl spawn booted log stream
--predicate 'process == "V1Harness"'`, then run the same checker.

## Cloud store

`EXPO_PUBLIC_CLOUD_STORE=1` swaps the probe suite for the encrypted-backup
transport page — the real-device checklist runner from
`n9/cloud-store/owner-setup.md`. It builds the platform store
(`createICloudStore` on iOS, `createGoogleDriveStore` on Android from
`@qntx/wallet-native/cloud`), probes with `list()`, then runs a
conformance-lite pass (write→read, overwrite, list-once, delete,
delete-missing, read-missing, invalid name) over unique
`qntx-harness-<random>-<step>` names. Each step prints one
`CLOUD_RESULT <step> ok|fail <detail>` line and the run ends with
`CLOUD_DONE`. A failed probe prints `CLOUD_RESULT probe <code> <detail>`
with the typed `CloudStoreError` code (`unavailable` on iOS without an
iCloud account, `auth-required`/`failed` on Android without consent or an
OAuth client) and skips the rest. iOS account changes print
`CLOUD_RESULT account-change`; on Android an "Authorize" button calls
`store.authorize()` for the interactive consent and reruns.

The iOS CloudKit entitlements come from
`EXPO_PUBLIC_ICLOUD_CONTAINER` at prebuild time — `app.config.ts` adds
`com.apple.developer.icloud-services: [CloudKit]` and the container
identifier only when it is set, so the default build is unchanged:

```bash
EXPO_PUBLIC_CLOUD_STORE=1 \
EXPO_PUBLIC_ICLOUD_CONTAINER=iCloud.org.qntx.wallet.harness.ios \
bunx expo prebuild --clean
```

Expected without accounts: iOS `unavailable`, Android `auth-required` or
`failed` — record the exact SDK detail; a crash or untyped error is a bug.
