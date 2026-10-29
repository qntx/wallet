# V1 Harness

## Social smoke (default on launch)

The app now boots into the W2b social smoke through `createNativeWallet` (Nitro
`KernelHost` → real kernel + file-backed vault): first launch creates a 12-word
mnemonic vault with the quiz ceremony, Nostr-signs and verifies an event, then
locks; **relaunch the app** and it unlocks the persisted vault with the password
and rejects a wrong one. Each step prints a machine-readable `SMOKE_RESULT
<name> <ok|fail> <detail>` line to the console (Metro / logcat), ending with
`SMOKE_RESULT done ok`.

Run the V1 probe suite instead with `EXPO_PUBLIC_V1_PROBES=1` at bundle time.


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
