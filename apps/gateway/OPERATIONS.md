# Gateway operations

DRAFT — thresholds, severities and SLO targets below are proposals; every plan,
price and capacity input is marked "owner must confirm" until reviewed. All
signal names come from the gateway source; nothing here is invented.

## Signal

Two kinds of structured output exist:

- **Request lines** — one JSON object per request from
  `src/middleware/request-log.ts:15`: `{route, status, ms, provider}` (route is
  the template, never parameters or client addresses).
- **Event lines** — `log({event: "...", ...})` calls:

| Event                                           | Source                                                                                                                                                                                                                                  | Meaning                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `upstream-failure`                              | src/providers/forward.ts:477                                                                                                                                                                                                            | an upstream provider call failed                                  |
| `upstream-throttled`                            | src/providers/forward.ts:342                                                                                                                                                                                                            | provider announced a rate limit (`account`, `retryAfter` seconds) |
| `all-providers-failed`                          | src/providers/forward.ts:434                                                                                                                                                                                                            | every configured provider failed for the request                  |
| `breaker`                                       | src/providers/forward.ts:531                                                                                                                                                                                                            | the per-provider circuit breaker changed state                    |
| `budget-error`                                  | src/budget/leased.ts:137                                                                                                                                                                                                                | the account-budget Durable Object errored                         |
| `internal-error`                                | src/middleware/errors.ts:44                                                                                                                                                                                                             | unhandled route error                                             |
| `price-cache-failure`                           | src/providers/prices.ts:151,164                                                                                                                                                                                                         | KV cache get/put failed (`op`)                                    |
| `nft-cache-failure`                             | src/routes/nft*.ts:82,97                                                                                                                                                                                                                | NFT cache failure                                                 |
| `token-list-build` / `token-list-build-skipped` | src/tokens/build.ts:140,114,175                                                                                                                                                                                                         | token list rebuilt / skipped (`reason`, `source`, `network`)      |
| `phishing-build` / `phishing-build-skipped`     | src/risk/phishing.ts:250,180                                                                                                                                                                                                            | phishing list rebuilt / skipped                                   |
| `approvals-truncated`                           | src/providers/approvals-alchemy.ts:312                                                                                                                                                                                                  | approvals listing truncated at the cap                            |
| `history-drain-truncated`                       | src/providers/history-alchemy.ts:412                                                                                                                                                                                                    | history drain hit its page cap                                    |
| `push-*`                                        | `push-*-error`, `push-sync`, `push-sweep`, `push-checks`, `push-deliver`, `push-drop`, `push-subscribe`, `push-unseal-failed`, `push-hook`, `push-alarm-error`, `push-alarm-write-error`, `push-family-mismatch`, `push-internal-error` | the push pipeline (see `src/push/`)                               |

## Draft alerts

Each alert is a Workers Logs query (`workers logs` / Logpush dataset filter)
plus a draft threshold — every number is a starting proposal, not a measured
baseline.

| Alert                | Query (fields on the JSON line)                                                                   | Draft threshold                                                 | Severity |
| -------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| Provider outage      | `event == "all-providers-failed"`                                                                 | > 0 in 5 min                                                    | page     |
| Breaker open         | `event == "breaker"`                                                                              | > 0 in 10 min, or any `open` persisting 30 min                  | page     |
| Upstream degradation | `event == "upstream-failure"` or `event == "upstream-throttled"`                                  | > 20 in 10 min (rate to baseline — to confirm)                  | warn     |
| Budget object sick   | `event == "budget-error"`                                                                         | > 0 in 15 min                                                   | warn     |
| Route error rate     | request lines `status >= 500` (optionally `event == "internal-error"`)                            | > 1 % of requests over 10 min, route-family p95 `ms` regression | warn     |
| Cache impairment     | `event == "price-cache-failure"` or `event == "nft-cache-failure"`                                | > 10 in 10 min                                                  | warn     |
| List build stalled   | no `token-list-build` or `phishing-build` in 2× their cadence, or `*-skipped` with a new `reason` | absence-based                                                   | warn     |
| Push pipeline        | `event == "push-internal-error"` or `push-alarm-error` or `push-unseal-failed`                    | > 0 in 15 min                                                   | warn     |

## SLO draft (all numbers to confirm)

- Availability per route family (`route` on request lines): 99.9 % monthly,
  `status < 500` counting as good.
- Latency: p95 `ms` per route family within 2× the upstream p95, measured from
  the same lines.

## Runbook skeleton

1. **Triage** — Workers Logs tail; bucket request lines by `route`/`status`;
   correlate with `upstream-*`/`breaker` events. Check whether the bad status
   is one provider (`provider` response header field) or all.
2. **Provider outage** — `all-providers-failed`/`breaker` events name the
   provider; verify upstream status pages, then watch `upstream-throttled`'s
   `retryAfter` for recovery.
3. **Breaker open** — the breaker is per provider account; an open breaker
   sheds load until the probe passes. If it flaps, check the provider's
   announced limit vs our `budget` share in `src/config/accounts.ts`.
4. **Rollback** — the deploy workflow records a plan per environment
   (`.github/workflows/gateway.yml`; `scripts/deploy-check.ts` annotates the
   deploy and rolls back on failed smoke). Manual:
   `bunx wrangler rollback --env production` (README "Roll back by hand").
   A `PushObject` migration makes a deploy non-rollbackable — the deploy
   check refuses it; see README "Adding the PushObject migration".
5. **Escalate** — owner confirms paging channel.

## Capacity per provider account

From `src/config/accounts.ts` (`budget` windows are our own share — usually
~80 % of the provider's published rate; the comment on each row names the
assumed plan). Concurrent-wallet figures are derived from the README's
per-active-wallet cost (README "Provider budget": one `eth_blockNumber` +
4×`eth_getLogs` ≈ 300 CU per refresh where applicable) — **every number here
is "owner must confirm"**.

| Account                                             | Assumed plan (comment in row) | Budget window (ours) | Per-active-wallet cost      | Resulting concurrent wallets |
| --------------------------------------------------- | ----------------------------- | -------------------- | --------------------------- | ---------------------------- |
| alchemy                                             | PAYG 10 000 CU/s              | 40 000 CU / 5 s      | ~300 CU / refresh (confirm) | ~130 refreshes / 5 s         |
| drpc                                                | see row                       | see `accounts.ts`    | same unit family            | to confirm                   |
| coingecko                                           | priced page in row            | see `accounts.ts`    | 1 request / refresh         | to confirm                   |
| defillama                                           | see row                       | 150 u / 20 s         | 1 u / request               | to confirm                   |
| jupiter (0x)                                        | see row                       | 8 u / 2 s            | 1 u / request               | to confirm                   |
| across                                              | see row                       | 10 u / 2 s           | 1 u / request               | to confirm                   |
| blockstream / ankr / trongrid / tatum / hyperliquid | public or keyed — see rows    | see `accounts.ts`    | —                           | to confirm                   |

Staging rows (`accounts.ts` ~line 172+) are keyless public endpoints — shared
quota, not a plan.
