#!/usr/bin/env bash
# QA-01/QA-02 PoC: writes throw-away probe files into restricted source trees, runs the repo's own
# oxlint config on them (`vp lint`), prints which AGENTS.md boundaries fire, then deletes them.
# Usage (repo root): bash audit-qa/lint-boundary-probe.sh
set -u
cd "$(git rev-parse --show-toplevel)"
declare -a FILES=()
probe() { local f=$1; shift; printf '%s\n' "$@" > "$f"; FILES+=("$f"); }
trap 'rm -f "${FILES[@]}"' EXIT

probe packages/wallet-engine/src/qa-probe.ts 'import * as s from "@qntx/wallet-chains/evm/sign";' '' 'export const x = s;'
probe packages/wallet/src/qa-probe.ts 'import * as s from "@qntx/wallet-chains/evm/sign";' '' 'export const x = s;'
probe packages/wallet/src/protocol/qa-probe.ts 'import * as s from "@qntx/wallet-chains/solana/sign";' '' 'export const x = s;'
probe packages/wallet/src/nostr/qa-probe.ts 'import * as s from "@qntx/wallet-chains/bitcoin/sign";' '' 'export const x = s;'
probe packages/wallet/src/chains/qa-probe.ts 'import * as s from "@qntx/wallet-chains/evm/sign";' '' 'export const x = s;'
probe packages/wallet-worker/src/node/qa-probe.ts 'import * as s from "@qntx/wallet-chains/evm/sign";' '' 'export const x = s;'
probe packages/wallet-worker/src/browser/qa-probe.ts 'import * as s from "@qntx/wallet-chains/evm/sign";' '' 'export const x = s;'
probe packages/wallet-native/src/qa-probe.ts 'import * as s from "@qntx/wallet-chains/evm/sign";' '' 'export const x = s;'
probe packages/wallet/src/qa-probe-kernel.ts 'import * as k from "@qntx/wallet-kernel";' '' 'export const x = k;'
probe packages/wallet-kernel/src/qa-probe.ts 'import * as w from "@qntx/spark-wasm";' '' 'export const x = w;'
probe packages/wallet-kernel/src/modules/qa-probe.ts 'import * as w from "@qntx/nostr-wasm";' '' 'export const x = w;'
probe packages/wallet-kernel/src/seed/qa-probe.ts 'export const g = [fetch, queueMicrotask, structuredClone, URL, Intl, atob, performance];'

echo "probe | no-restricted-* fired?"
OUT=$(bunx vp lint "${FILES[@]}" 2>&1)
for f in "${FILES[@]}"; do
  hits=$(printf '%s\n' "$OUT" | grep -F "$f" | grep -cE 'no-restricted-(imports|globals)')
  printf '%s | %s\n' "$f" "$([ "$hits" -gt 0 ] && echo "yes ($hits)" || echo NO)"
done
