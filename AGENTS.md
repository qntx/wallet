# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Architecture invariants

- qntx/wallet composes qntx/nostr, qntx/spark and its own @qntx/wallet-chains. It never
  reimplements protocol or cryptographic code that belongs to them.
- @qntx/wallet-kernel is private and only bundled by the host packages. Nothing in the
  main runtime can import it.
- Secrets (entropy, seed, private keys, DEK) exist only in the enclave (Web Worker, RN kernel
  runtime). Messages carry no signing secrets, except user exports and the data key. On RN the
  password and PRF output never leave the kernel runtime either; on the Web they necessarily pass
  through the main thread (WebAuthn is main-thread only), so the Web wallet is a hot wallet that
  does not withstand an active main-thread attacker.
- The kernel source never imports -worker or -native packages; backends (`backends.nostr`,
  the NostrBackend, and `backends.spark`, the SparkCrypto wasm/native loader) are injected
  by the host packages.
- `@qntx/wallet-chains/*/sign` is imported only by the kernel (lint-enforced); the engine
  and @qntx/wallet never import signing implementations.
- Gateway data services (portfolio, prices, history) are display-only; values
  used to build or sign transactions come from chain RPC, cross-checked against the host
  endpoints when the gateway serves them. apps/gateway imports only
  `@qntx/wallet-engine/gateway/contract`.
- Kernel code uses only the globals allowed in design/enclave.mdx; it must run in a bare
  Hermes runtime.
- Native capabilities that hold, produce or unwrap secrets (keystore, passkey, store) are
  injected into the kernel runtime as JSI host objects and are never registered with Nitro.
- Protocol library versions are pinned exactly and recorded in the kernel manifest;
  backends' abiVersion is checked at kernel start.
- Every vault, backup, template, protocol and chain signing format has fixed vectors in
  vectors/.
- packages/*/src is platform-neutral; all I/O is injected; no ambient singletons.
- Kernel code grows for an application only as (a) a protocol-family decoder in
  `@qntx/wallet-chains` with its prompt rows, or (b) a session scheme under
  `packages/wallet-kernel/src/modules/sessions/schemes/` that builds the exact signed document from
  strictly validated params. Applications add no vault record kinds and no kernel command
  namespaces; material that cannot authorise moving value (API keys, HMAC secrets, bearer tokens)
  stays out of the vault. A session scheme ships with the worst case of a stolen key argued from
  the protocol's source (it may trade or cancel, never withdraw), a strict params validator that
  is the allow-list, time-window and TTL caps, byte-exact signing vectors from the protocol's
  official SDK, and mutation tests that kill every guard. The kernel budget for the
  `hyperliquid-l1-agent` scheme is 16 384 B by owner decision of 2026-11-22.
- The application share of the native kernel bundle stays within the budgets enforced by
  `scripts/check-kernel-budget.ts` (run by `bun run lint`); raising one needs a recorded decision.
- An application signs only through the request pipeline — requests attributed to it with origin
  `{ kind: "app", id }`, approved by the user and decoded by the kernel — or through a kernel
  session scheme; it never holds a private key.

### Card wallet

- APDUs do not pass through the main runtime. The kernel hands its APDUs (already record-layer
  ciphertext) directly to the native card reader (`__qntx.cardReader`) and the responses come
  straight back to the kernel; the main runtime can neither read nor reroute them and only drives
  the tap cadence. The NFC session, its text and its end are opened, set and closed only by the
  kernel.
- The secure input view (`SecureInput`, `@qntx/wallet-native/secure-input`) may be a Nitro
  HybridView because it exposes no content: the main runtime can mount and size it and receives
  only `idle | empty | filled | submitted` — no characters, no length, no hash. Reading the code
  stays a kernel-only host object (`__qntx.secureInput`), never registered with Nitro.
- The access-code and short-ID fields are editable only while a kernel `secureInput.request` is
  pending, and take focus and raise the keyboard on that request (the most recently mounted view
  first).

`design/` is local-only and never committed.

## Commands

Local gate before a pull request:

```bash
bun run lint && bun run typecheck && bun run test
```

`vp` caches lint/typecheck/test results, so a green run can mask findings a
fresh file edit introduced. To run the gate uncached before a PR:
`bunx vp cache clean && bunx vp check && bun run lint && bun run typecheck && bun run test`
(`bunx vp check` checks every file directly; `vp cache clean` clears the
task cache so the subsequent `bun run` scripts re-evaluate).

The native kernel bundle is committed (`packages/wallet-native/kernel/generated/`). Any
change to code bundled into the kernel (kernel modules, `@qntx/wallet-chains`, kernel
dependencies) needs `bun run native:kernel` and the regenerated files in the same PR; CI's
native-host-test fails on a stale bundle.

`bun run smoke:hermes` runs the kernel, chains and card protocol bundles in a bare Hermes CLI and
needs `HERMES` pointing at that binary (it exits 1 without it). CI builds the CLI from the facebook/hermes
commit pinned as `hermes-commit` in `.github/workflows/hermes.yml`; build the same one locally
(needs cmake, ninja and ICU):

```bash
commit=$(sed -n 's/^ *hermes-commit: *\([0-9a-f]\{40\}\).*/\1/p' .github/workflows/hermes.yml)
git init ~/hermes-src && git -C ~/hermes-src fetch --depth 1 https://github.com/facebook/hermes.git "$commit"
git -C ~/hermes-src checkout FETCH_HEAD
cmake -S ~/hermes-src -B ~/hermes-build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build ~/hermes-build --target hermes
HERMES=~/hermes-build/bin/hermes bun run smoke:hermes
```

Run it whenever kernel or `@qntx/wallet-chains` code changes.

`@qntx/wallet-worker` has two Vitest projects: `node` (`bun run test`) and `web`, which runs the
Web enclave's source in Chromium (`bun run --cwd packages/wallet-worker test:web`, after
`bunx playwright install chromium`). Its coverage gate (`coverage`) counts both and runs in the
Browser workflow, not in `test:coverage`.

The root scripts build consumed workspace packages first; per-package scripts must stay
build-free — never nest `vp run …#build` inside a package's own lint/typecheck/test script.
