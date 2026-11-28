# Contributing

## Prerequisites

- **Bun** — package scripts, tests, and tooling. The version is pinned once in the root
  `packageManager` field of `package.json`; CI reads it from there (`bun-version-file`).
- **Node >= 20.19** — the Node test host for the kernel.
- **Playwright Chromium** — `bunx playwright install chromium`; needed by the
  `@qntx/wallet-worker` web tests and its coverage gate.
- **macOS + Xcode** — the native host tests build the harness app with
  `expo prebuild`/`pod install` and run under `xcodebuild` (see
  `.github/workflows/native.yml`).

## Repository layout

```text
packages/wallet/         @qntx/wallet — self-custodial wallet SDK:
                         Wallet host entry, protocol and types
packages/wallet-chains/  @qntx/wallet-chains — SignRequest codecs, display
                         decoding, verifiability and signing for EVM, Solana
                         and Bitcoin
packages/wallet-engine/  @qntx/wallet-engine — controllers, events and
                         encrypted engine storage
packages/wallet-kernel/  @qntx/wallet-kernel — private kernel package
                         (secret, seed, derive, vault); only bundled by the
                         host packages, never published
packages/wallet-native/  @qntx/wallet-native — React Native kernel runtime
                         host: CBOR transport, KernelHost adapter and
                         createNativeWallet
packages/wallet-worker/  @qntx/wallet-worker — Web Worker and
                         worker_threads hosts for @qntx/wallet
apps/gateway/            @qntx/gateway — private Cloudflare Worker that
                         forwards allow-listed JSON-RPC and Esplora reads
                         with failover, and serves quotes and risk lists
apps/harness/            @qntx/wallet-harness — Expo app driving the native
                         host tests
apps/playground/         @qntx/playground — web app exercising the wallet
                         and engine
vectors/                 fixed test vectors (see vectors/README.md)
scripts/                 repo tooling (check-version, vectors/)
```

## Local gate

Run before opening a pull request:

```bash
bun run lint && bun run typecheck && bun run test
```

## Hyperliquid testnet e2e

`packages/wallet-engine/tests/hyperliquid-testnet.test.ts` drives the real Hyperliquid path (vault,
request pipeline, kernel decode, `hyperliquid-l1-agent` session) against
`api.hyperliquid-testnet.xyz`. It is skipped unless `HYPERLIQUID_E2E_MNEMONIC_FILE` names a file
holding the mnemonic of a funded testnet account, and it has no CI workflow (CI holds no funded
secret). The suite refuses to sign unless the mnemonic derives the expected test address hardcoded
in the file; edit `OWNER_EXPECTED` for another account. Every request goes through the testnet
guard (`tests/support/hyperliquid-testnet.ts`), which refuses mainnet and value-out actions. Run it
locally after building the kernel bundle:

```bash
bunx vp run @qntx/wallet-worker#build
cd packages/wallet-engine
HYPERLIQUID_E2E_MNEMONIC_FILE=~/.qntx-e2e-mnemonic \
HYPERLIQUID_E2E_LOG=/tmp/hl-e2e.jsonl \
bunx vp test tests/hyperliquid-testnet.test.ts
```

`HYPERLIQUID_E2E_LOG` (optional) receives one JSON line per step and per `/exchange` post (action,
nonce, response; never signatures). The run takes about three minutes, needs a few hundred USDC
of perp collateral for margin, costs a few cents in fees, and leaves the account flat with the
agent revoked.

## Working across repositories

To try an unreleased `qntx/nostr` or `qntx/spark` change, `bun link` it into the
package that consumes it, and undo the link before you test or open a pull
request:

```bash
bun install --force
```

`bun install --frozen-lockfile` keeps such links, so `bun run check:pkg` (which
CI runs) fails while any `node_modules/@qntx/*` entry resolves outside this
checkout. A dependency change itself lands as a released, pinned version.

## Commits

English Conventional Commits: `type(scope): subject` (`feat`, `fix`, `docs`,
`style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`), subject
in imperative mood, no period, ≤ 50 chars; `BREAKING CHANGE:` footer for
breaking changes.

## Versioning and release

All packages under `packages/` share one lockstep version; `release` runs
`bumpp` (see `bump.config.ts`), which pushes a `release/vX.Y.Z` branch and
opens the release pull request via `gh`. After the release PR merges, tag the
merge commit and push the tag:

```sh
git tag -a vX.Y.Z <merge-sha> -m vX.Y.Z && git push origin vX.Y.Z
```

`scripts/check-version.ts` fails the lint gate when internal `@qntx/*` ranges
or `bun.lock` workspace entries drift from the manifests.

## License

Contributions are dual-licensed under MIT OR Apache-2.0.
