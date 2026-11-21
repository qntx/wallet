// # n3-review workerd budget harness
//
// Local-only `wrangler dev` harness that runs the real gateway budget path in workerd: the real
// `ProviderBudgetObject` Durable Object (`src/budget/durable.ts`), the real `durableBudget` lease
// layer (`src/budget/leased.ts`), and real rate-limit bindings (staging numbers from
// `apps/gateway/wrangler.jsonc`). All upstream provider traffic is answered by an in-worker stub —
// nothing leaves the loopback interface, no Cloudflare login is needed.
//
// ## Files
//
// - `entry.ts` — Worker entry. Exports `ProviderBudgetObject`; lazily builds one gateway per
//   isolate via `createGateway` with `PRODUCTION_NETWORKS`, no-op upstream auth, and a counting
//   wrapper around the `PROVIDER_BUDGET` namespace that records per-account lease RPCs, granted
//   units, and refusals. `x-test-ip` is copied to `cf-connecting-ip` (`x-test-ip: none` removes it).
//   Bypass routes: `GET /__stats`, `POST /__reset`.
// - `wrangler.json` — worker `n3-budget-a`, owns the DOs.
// - `wrangler.peer.json` — worker `n3-budget-b`, same entry; `PROVIDER_BUDGET` is bound with
//   `script_name: "n3-budget-a"`, so B is a second isolate sharing A's objects through the local
//   dev registry.
// - `drive.ts` — bun driver for scenarios S1–S7; prints a result table to stdout (redirect it to
//   the evidence directory).
//
// ## Vars
//
// - `SCALE`: `production` (default, `PRODUCTION_ACCOUNTS`), `small` (alchemy `[{400,5s}]`, all
//   other accounts `[{10,5s}]` — exhaustion in seconds), `s3slow` (3600 s windows — refill is ~0
//   during a restart so DO persistence is observable; blockstream gets 1200 units, the smallest
//   capacity that keeps the per-IP share delta inside the 1000-unit share window).
// - `UPSTREAM_DELAY_MS`: artificial latency added to every stubbed upstream call (default 0).
//
// ## Commands
//
// Run everything from this directory. `WRANGLER` is
// `../../../node_modules/.bin/wrangler` (wrangler 4.160.0).
//
// ```bash
// # A alone, production accounts (S1, S5, S6, S7)
// $WRANGLER dev -c wrangler.json --port 8801 --persist-to /tmp/n3-persist-a
//
// # A + B, small accounts (S2 cross-isolate); B is a second isolate sharing A's DOs
// $WRANGLER dev -c wrangler.json --port 8801 --persist-to /tmp/n3-persist-a --var "SCALE:small"
// $WRANGLER dev -c wrangler.peer.json --port 8802 --persist-to /tmp/n3-persist-b --var "SCALE:small"
//
// # B alone (S4: script_name target A missing ⇒ DO unavailable)
// $WRANGLER dev -c wrangler.peer.json --port 8802 --persist-to /tmp/n3-persist-b --var "SCALE:small"
//
// # A, s3slow accounts (S3 restart persistence): drain blockstream via Esplora,
// # kill the process, restart with the same --persist-to dir, then probe.
// $WRANGLER dev -c wrangler.json --port 8801 --persist-to /tmp/n3-persist-s3 --var "SCALE:s3slow"
// bun drive.ts s3t http://localhost:8801          # drain (1201×200 then 503)
// # kill the wrangler process, restart the same command, then:
// bun drive.ts s3probe http://localhost:8801 - esplora   # persisted ⇒ ~200×3 then 503s
// # control: restart with a fresh --persist-to dir and probe ⇒ 200×40
// ```
//
// ## Scenarios (`bun drive.ts <scenario> <url-a> [url-b] [target]`)
//
// | scenario  | servers | SCALE      | what it does                                                                                      |
// | --------- | ------- | ---------- | ------------------------------------------------------------------------------------------------- |
// | `s1`      | A       | production | 200 sequential + 200 concurrent `eth_call`, unique IPs; lease RPCs vs upstream calls, p50/p95/max |
// | `s2`      | A+B     | small      | 15 s concurrent drive on both isolates; aggregate upstream CU vs `400 + 80×elapsed`               |
// | `s3`      | A       | small      | drain alchemy/dRPC via EVM until non-200 (masked by share 413 — see s3t)                          |
// | `s3t`     | A       | s3slow     | drain blockstream via Esplora with rotating /24 IPs until 503                                     |
// | `s3probe` | A       | s3slow     | `bun drive.ts s3probe <a> - esplora`: 40 rotating-IP requests after a restart                     |
// | `s4`      | B       | small      | 20 `eth_call` + 10 TRON with A stopped; statuses + B upstream counters; `budget-error` in B's log |
// | `s5`      | A       | production | TRON 1/s×70, prices eur/usd, Jupiter 1/5s×15, Esplora ×30 burst — one IP                          |
// | `s6`      | A       | production | IP keying: `::ffff:` mapped-v4 pair, `none` pair, IPv6 same-/48 pair                              |
// | `s7`      | A       | production | 100 concurrent `eth_call` from 100 IPs; wall time + DO lease RPC count                            |
//
// Save raw output per scenario:
//
// ```bash
// bun drive.ts s1 http://localhost:8801 > "$EVIDENCE/workerd/S1.txt"
// ```
//
// with `EVIDENCE=/Users/xu/Desktop/qntx/wallet-audit/n3/review-gateway/evidence`.
//
// ## Validation
//
// ```bash
// # lint + format + type-aware rules for the harness files
// bunx vp check apps/gateway/tests/n3-review/
// # gateway typecheck
// cd apps/gateway && bunx tsc --noEmit
// ```
//
// These are driver/harness files, not tests: `apps/gateway/vite.config.ts` only includes
// `tests/**/*.test.ts`, so `bun run test` never executes them.

// check-boundaries admits only .ts payloads under governed trees, so this file documents the
// harness; the reproduction walkthrough is in the comments above.
export const README = "local-only wrangler dev budget harness";
