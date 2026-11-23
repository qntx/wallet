# @qntx/gateway

The wallet gateway: a Cloudflare Worker (Hono) that forwards allow-listed JSON-RPC and Esplora
requests to upstream providers with failover. Private, never published. It holds provider and
quote API keys — never wallet secrets — and signs — wallet data from it is for display and for reads the engine cross-checks.

| Route                            | Behavior                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`                 | `{ "status": "ok" }`; needs no client id                                                                                                                                                                                                                                 |
| `POST /v1/rpc/:caip2`            | EVM and Solana JSON-RPC 2.0, single or batch (max 20); read-only methods plus `eth_sendRawTransaction`/`sendTransaction`                                                                                                                                                 |
| ↳ `eth_getLogs`                  | Bounded: one block by `blockHash`, a numbered range of at most 500 blocks, or tags that match or both name the head (`latest`/`pending`); at most 20 addresses and 20 alternatives per topic                                                                             |
| `GET\|POST /v1/esplora/:caip2/*` | Bitcoin Esplora: the engine's read paths plus `POST /tx`; bodies and content types pass through                                                                                                                                                                          |
| `POST /v1/tron/:caip2/*`         | TRON node API: an allow-list of `/wallet/*` and `/walletsolidity/*` paths plus the TronGrid `/v1/accounts` indexer feeds (TronGrid providers only); request bodies are schema-checked, `broadcasthex` follows the broadcast rule below                                   |
| `GET /v1/networks`               | The served network ids, in configured order                                                                                                                                                                                                                              |
| `GET /v1/eligibility`            | Per-app availability for the caller's edge-resolved jurisdiction (`{ country, region, apps: { hyperliquid, polymarket } }` — `available`/`close-only`/`blocked`); `private, no-store`                                                                                    |
| `POST /v1/history/:caip2`        | EVM transfers in and out of `{address}` (body), newest first, `cursor` pages backwards, `truncated` marks a page that dropped transfers it could not fit; Alchemy Transfers; `404 unsupported` on served networks without it                                             |
| `POST /v1/approvals/:caip2`      | EVM approval candidates for `{address}` (body): token, spender and block keys from the owner's Approval/ApprovalForAll and Permit2 events — display-only, the engine confirms each on chain; Alchemy `eth_getLogs`; `404 unsupported` on chains with a bounded log range |
| `GET /v1/tokens/:caip2`          | The published token list for the network, ETag + `if-none-match`; `404 unsupported` when no configured source covers it, `503 unavailable` until the first build lands                                                                                                   |
| `GET /v1/risk/lists/phishing`    | The hashed phishing list: a snapshot, a net diff since `?since=<version>`, or `current`; `503 unavailable` before the first build                                                                                                                                        |
| `POST /v1/prices`                | Spot price and 24 h change of up to 100 CAIP-19 assets in one fiat currency; display-only (see "Prices")                                                                                                                                                                 |
| `GET /v1/quotes/swap`            | EVM swap quote through 0x; `503 unavailable` without `ZEROX_API_KEY`                                                                                                                                                                                                     |
| `GET /v1/quotes/swap/solana`     | Solana swap quote through Jupiter (keyless; `JUPITER_API_KEY` only sets the upstream header)                                                                                                                                                                             |
| `GET /v1/quotes/bridge`          | Across bridge quote between two networks (keyless)                                                                                                                                                                                                                       |

Every other `/v1` request needs `x-client-id` (32 lowercase hex characters). Responses carry
`x-gateway-providers` with the provider that served them. Errors are `{ "error": <code> }`:
`400 invalid-request`, `404 unknown-network`/`not-found`/`unsupported`, `429 rate-limited` and
`503 unavailable` (both with `Retry-After`), `502 outcome-unknown`, `500 internal`.
`unsupported` is permanent — the gateway has no coverage for that resource on the network or
asset named, so a client must not retry: a served EVM network no history or approvals provider
covers, a network no configured token-list source builds for, and (in the prices body) assets no
price provider maps.

Providers are tried in the order of `src/config/networks.ts`. Every route reaches its upstreams
through one forwarder (`src/providers/forward.ts`), the only holder of `fetch`, and the breaker
counts only what the forwarder itself observes and no client input can provoke: a transport error,
a 5xx, a failed auth lookup, or an attempt timeout (10 s) whose _probe_ also fails — a provider
without a probe never counts a timeout, and one that answers its probe (any status below 500 other
than 429) disproved it. Probes are cheap per-family calls (`eth_chainId` on EVM, `getHealth` on
Solana, `/blocks/tip/height` on Esplora, `/ping` on CoinGecko), single-flight per provider with the
verdict reused for 10 s, paid from the account budget but never the client share. Five consecutive
outages open that provider's breaker for 30 s. A 429 is not an outage: the provider answered, so it
is alive — it parks its _account_ (Alchemy throttles per account, across networks) for
`min(Retry-After, 30)` seconds, 5 s when the header is missing, and every provider of that account
is skipped without a call until the cool-down expires. Any other failed answer — a 401/403
refusal, another 4xx, a malformed body, an upstream JSON-RPC error on history — moves on to the
next provider without counting. A JSON-RPC error object on the RPC route is a valid answer and is
returned as-is. An upstream 400, 413 or 422 on a JSON-RPC route, and an answer over the route's
response cap, were provoked by the request itself: they are answered 400 `invalid-request` without
failover. Request schemas refuse up front what an upstream would reject (a history cursor above
int64, a quote amount wider than the chain's amount type). `tests/breaker.test.ts` enumerates every
registered route and holds each one to this accounting.

A request that relays a signed transaction (`eth_sendRawTransaction`, Solana `sendTransaction`,
Esplora `POST /tx`, TRON `/wallet/broadcasthex`) fails over only when the failed attempt provably never reached the provider —
an open breaker, a 401/403/429 refusal, or a rejected auth lookup. Any other failure (timeout,
transport error, 5xx, malformed body) is ambiguous: the provider may have relayed the transaction,
so the request is answered 502 `outcome-unknown` rather than retried on a provider that could
double-broadcast it.

`POST /v1/approvals/:caip2` reports approval _candidates_ — the keys of every approval-shaped
event `{address}` emitted (`Approval` on ERC-20/721, `ApprovalForAll`, and Permit2's `Approval`
and `Permit` on the canonical deployment), deduped to the latest block per key and capped at 500.
It never reports an amount or a live flag: the engine confirms each candidate on chain. One
request costs one `eth_blockNumber` plus four `eth_getLogs` at 60 CU each, served only on chains
where Alchemy accepts an unbounded log range (`src/providers/approvals-alchemy.ts`); anywhere else
the scan could silently truncate, so the route answers `404 unsupported` without an upstream call.

## Rate limiting

Three kinds of limiting guard the shared provider accounts. The **flood limiters** — three Workers
bindings counting requests per 60 s window (`IP_LIMITER` 3000, `RPC_LIMITER` 1500,
`DEFAULT_LIMITER` 400; values in `wrangler.jsonc`, `Retry-After: 60`) — answer
`429 rate-limited`: every IP key first (an IPv4 /24; for IPv6 both its /64 and its /48, so subnet
rotation inside a /48 cannot hide and one /64 is not billed for its neighbours), then `x-client-id`

- the most specific key on either the RPC limiter (transport routes) or the default one. Every
  request pays one unit up front; an RPC batch pays one more unit for each of its remaining calls.
  The numbers are sized at roughly 3 × the measured volley of one fresh all-family wallet cold start
  (461 IP units, 200 on the RPC limiter's busiest `bitcoin:` key, 98 on the default limiter's
  `service:` key), so the RPC binding also admits a used wallet's 1,451-call EVM refresh once.

The **share limiter** (`SHARE_LIMITER`, 1000 units per 60 s) bills every upstream call at the
provider's own price — compute units on Alchemy and dRPC (`src/budget/costs.ts` lists a row for
every allow-listed method, plus `alchemy_getAssetTransfers`), one credit per call on request-priced
endpoints. Before `send` fires, the forwarder charges
`ceil(units × SHARE_LIMIT / (clientShare × perMinute))` on every `account:` + IP key, where
`perMinute` is the account's tightest minute-scale (≤ 60 s) budget window — day and month windows
stay out of the per-prefix price and are enforced only by the global budget below. Each account's
`clientShare` (in `src/config/accounts.ts`, with the arithmetic in its comment) is the fraction of
that per-minute capacity one prefix may spend; a high share is safe where the upstream call count
cannot be multiplied per prefix — CoinGecko and DefiLlama serve through the gateway's shared price
cache, so one prefix buys at most the distinct-asset misses, not a copy per request. A refused
charge never reaches the upstream: the walk moves on to the route's next provider, and the client
sees `429 rate-limited` only when every provider's share charge refuses (a single delta over the
whole 1000-unit window on every provider is `413 too-costly` without touching the limiter).

The **account budget** (`PROVIDER_BUDGET`, one Durable Object per provider account) is the global
bound the share limiter cannot express: the Workers rate-limit binding counts per Cloudflare
location, so only a Durable Object can hold one account's worldwide quota (the binding
documentation's "Strict limits" section prescribes exactly this). Each object keeps a multi-window
token bucket in its SQLite storage covering every window in the account's `budget` list — the
sub-minute burst depth, the per-minute rate, and the day/month caps alike. Each isolate holds a
one-second adaptive lease from it (sized by what it actually spent, capped at 1 % of the account's
tightest window) so the object sees seconds, not requests — a Durable Object's ~1,000 rps soft
limit and its round trip are amortised away. A spent account refuses with its own wait time; the
request fails over — never a breaker outage — and when every provider is spent or cooling, the 503
`unavailable` carries the shortest announced wait. Operator note: the budgets in
`src/config/accounts.ts` assume the provider plans listed in each row's comment — review them when
a plan changes.

TRON providers are request-priced like Esplora: every allow-listed `/v1/tron` path is one bounded
upstream call billed one request credit on the provider's account (`trongrid`, `tatum`).

The global budgets are sized for ≥ 20 concurrently active all-family wallets each
foreground-refreshing once per minute, plus 10 fresh all-family cold starts per minute (numbers
from `packages/wallet-engine/tests/gateway-capacity.test.ts`): Alchemy 20 × 1,570 + 10 × 7,150 =
102,900 CU/min ≤ the 480,000 CU/min budget; Blockstream 20 × 81 + 10 × 200 = 3,620 calls/min ≤ the
4,000/min budget. CoinGecko and DefiLlama cold starts cost upstream calls only on a cold per-colo
price cache (≈ 81 calls per colo per cache lifetime, well under the 400/min and 450/min budgets).
TRON is the known exception: a fresh wallet costs 3 calls, but a used wallet's history fetches
`getassetissuebyid` once per TRC-10 row — ≈ 50 calls per refresh — which exceeds the free-tier
TronGrid/Tatum POLICY budgets (144/min each); raising them waits on the operator's keyed-QPS
confirmation and an engine-side history cache (outside this change).

## Prices

`POST /v1/prices` takes `{ currency, assets }` — up to 100 distinct CAIP-19 ids in their canonical
spelling (`<caip2>/slip44:<n>`, `eip155:<n>/erc20:<lowercase address>`,
`solana:<ref>/token:<mint>`) — and answers `{ currency, prices, missing, unsupported }`: every
asset is either priced (`price` as a decimal string, `change24h` in percent or `null`, `updatedAt`
in Unix ms), `missing` (no provider had a price now — a later request may) or `unsupported` (no
price provider maps the asset — permanent, never asked upstream, never cached). The asset set describes a portfolio, so it travels in the body and the answer is
`no-store`. Each upstream call its cache misses fan out to (one per CoinGecko token platform and one
for the native coins, two for DefiLlama) is billed to the request's share of the source's account.

Each asset is looked up in a per-asset Cache API entry (30 s, keyed by currency and asset, never by
client), then asked of CoinGecko's Pro API (`COINGECKO_API_KEY`, sent as `x-cg-pro-api-key`), then
of DefiLlama's keyless coins API for whatever is still unpriced (USD only; it reaches the long tail
such as HyperEVM tokens, but prices major coins from CoinGecko itself, so it covers an outage, not a
wrong answer). Provider numbers are turned into decimal strings from their shortest round-trip
spelling and checked: positive, below 10^12, truncated to 18 decimals, updated at most 5 minutes
ahead and at most a day ago; a 24 h change below -100 % or with more than six integer digits becomes
`null`; DefiLlama quotes below confidence 0.9 are dropped. A refused charge makes that source
unavailable — the request's own budget is spent, not the provider's — so answers already paid for
are kept and the source's pending assets answer `missing`. An asset is cached as `missing` only when
every provider answered — a failed or uncharged source might know it. When no asset could be priced
and a provider failed, the route answers 503; when the only failures were refused charges, it
rethrows the 429. Without a CoinGecko key (staging by default) only DefiLlama serves, so non-USD
requests come back `missing`.

## Eligibility

`GET /v1/eligibility` answers per-app availability for the caller's IP jurisdiction — the edge
resolves `cf.country`/`cf.regionCode`; subdivision codes (`CA-ON`, `UA-43`) are checked before
the bare country, and `blocked` always wins over `close-only`. A missing country, `XX` (unknown)
or `T1` (Tor) blocks every app: a jurisdiction gate fails closed.

- **Hyperliquid** is `blocked` in the United States and its territories (PR/GU/VI/AS/MP/UM — a
  conservative reading of "United States" in Terms §1.6(a)), Ontario (§1.6(a)), and the
  comprehensively-sanctioned jurisdictions (§1.6(b) — IR, SY, CU, KP, Crimea/Donetsk/Luhansk as
  UA-43/14/09, the set Polymarket publishes since the terms do not enumerate it). No
  close-only tier.
- **Polymarket** is `blocked` in the sanctioned set, and `close-only` in its published
  restricted list — the frontend-only tier (IE, JP, MT, NL, KR) counts because the wallet is a
  frontend; MT ("sports only") is treated as close-only conservatively.

Sources are recorded per entry in `src/config/eligibility.ts`. The answer guides the UI only —
the platforms enforce their own restrictions; this endpoint is not a security boundary.

## Phishing list

`buildPhishingList` (the `scheduled` handler) fetches every source, keeps
the entries `phishingKey` accepts, hashes them to 8 bytes, and — only when the merged deny or allow
set changed — writes `phishing:snapshot` and then `phishing:journal` to the `RISK` KV namespace. The
journal keeps 7 days and at most 168 entries; a request with `since` inside it gets one folded diff.

Allow and deny interact per source, never across sources: a source's allow cancels only its own
exact deny keys (a same-source subdomain exemption still publishes), while another source's deny of
any of an allow key's page candidates drops that allow. Two guards bound a compromised source:
`phishing:sources` in KV records each source's effective deny count at the last published build —
a source falling below half its own stored count skips the build (`deny-shrank`, logged with the
source id) — and a published allow gaining more than 50 keys in one build skips it (`allow-grew`).
A failing source skips the build too; every skip logs one JSON line. Both environments run the
build hourly (`"0 * * * *"`). KV namespaces:
`wallet-gateway-staging-risk` (staging), `wallet-gateway-risk` (production).

| Source                                                                                            | License                                                                                                                 | Used                                         |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [MetaMask eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect) `src/config.json` | [DBAD 1.2](https://github.com/MetaMask/eth-phishing-detect/blob/main/LICENSE): attribution required, no verbatim resale | `blacklist` and `whitelist`; not `fuzzylist` |
| [Polkadot phishing](https://github.com/polkadot-js/phishing) `all.json`                           | Apache-2.0                                                                                                              | `deny` and `allow`; not `denySub`            |

The list is derived data: entries are normalized and truncated to 8-byte hashes, and the original
lists are not redistributed. Attribution: phishing data from MetaMask eth-phishing-detect and
polkadot-js/phishing.

## Observability

All log lines are JSON. Besides the per-request line, the forwarder logs
`{"event":"upstream-failure","provider","upstream","reason"}` per failed attempt (reason:
`status-<n>`, `cooling-down`, `budget`, `probe`, `malformed`, `rpc-error`, `auth`, `timeout`,
`breaker-open`, `rejected`, `too-large`, `transport`, `error`),
`{"event":"upstream-throttled","account","retryAfter"}` once when a 429 parks an account,
`{"event":"breaker","provider","upstream","state"}` on every open/half-open/closed transition, and
`{"event":"all-providers-failed","providers":[…]}` once when every provider of a route is down —
the alert condition. `mapError` logs `{"event":"internal-error","name"}` (the error class name
only) for unexpected 500s. Log lines never carry params, bodies, addresses, client ids, IPs, error
messages or upstream bodies. Alerting is configured on Workers Logs queries against these events;
there is no alerting code in the worker.

## Layering

`src/` imports exactly one workspace package: `@qntx/wallet-engine/gateway/contract` (schemas, the
method and path allow-lists, the network registry). `scripts/check-boundaries.ts` (part of
`bun run lint`) resolves every import and rejects any other `@qntx/*` package or any path into
another workspace package, so the gateway never depends on engine runtime code. Contract
changes go in `packages/wallet-engine/src/gateway/contract/` first.

`createGateway({ fetch, networks, limiters, corsOrigins })` in `src/app.ts` builds the Hono app; all
upstream I/O goes through the injected `fetch`. `src/index.ts` is the Workers entry that wires `env`
into it.

## Develop

```bash
bun install
bun run --cwd packages/wallet-engine build   # the gateway imports the engine's built contract
bun run --cwd apps/gateway test              # vitest through app.request(), fake fetch and limiters
bun run --cwd apps/gateway typecheck
bun run --cwd apps/gateway dev               # wrangler dev --env staging, http://127.0.0.1:8787
```

Smoke against the real public providers while `dev` is running:

```bash
ID=0123456789abcdef0123456789abcdef
curl -s -H "x-client-id: $ID" -H content-type:application/json \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  http://127.0.0.1:8787/v1/rpc/eip155:11155111
curl -s -H "x-client-id: $ID" \
  http://127.0.0.1:8787/v1/esplora/bip122:00000008819873e925422c1ff0f99f7c/block-height/0
```

After changing `wrangler.jsonc`, regenerate the committed runtime types:
`bun run --cwd apps/gateway types`.

## Deploy staging

Staging serves testnets only (every built-in EVM testnet, Solana devnet, Bitcoin signet and
testnet4, and TRON Nile through TronGrid Nile and NileEx) through keyless public endpoints — two per network, listed in `src/config/networks.ts`, at `https://wallet-gateway-staging.qntx.org`.

```bash
bunx wrangler login                     # once; the staging account (env.staging.account_id)
bun run --cwd apps/gateway deploy:staging
```

Roll back with `bunx wrangler rollback --env staging`.

## Production

Production serves mainnets only at `https://gateway.meowl.xyz` on account
`9241dfd75bea0009a3870173f7e1acd2` (`env.production.account_id`): every built-in EVM mainnet (the order and the list are
`src/config/networks.ts`; a test keeps it equal to the engine registry) plus Solana — through Alchemy first and
dRPC second where Alchemy serves the chain, dRPC then Ankr otherwise (provider accounts must have every one of these networks enabled) (keys in request headers, never URLs — `Authorization: Bearer`, `Drpc-Key` and `x-api-key`),
TRON mainnet through TronGrid first and Tatum second (`TRON-PRO-API-KEY` and `x-api-key`
headers), and
Bitcoin mainnet through Blockstream Enterprise's Esplora (client-credentials token, cached per
isolate). The RN app sends no `Origin`, so `CORS_ORIGINS` is empty.

Required secrets — set them **before** the first deploy, `wrangler deploy` refuses otherwise:

```bash
for NAME in ZEROX_API_KEY JUPITER_API_KEY ALCHEMY_API_KEY DRPC_API_KEY ANKR_API_KEY BLOCKSTREAM_CLIENT_ID BLOCKSTREAM_CLIENT_SECRET COINGECKO_API_KEY TRONGRID_API_KEY TATUM_API_KEY; do
  bunx wrangler secret put "$NAME" --env production
done
```

(`ZEROX_FEE_RECIPIENT`/`ZEROX_FEE_BPS` stay optional; staging may set `COINGECKO_API_KEY` too.)

## Deployment pipeline

`.github/workflows/gateway.yml` deploys only commits whose CI run passed:

- **staging** follows `main`: each time the CI workflow succeeds on a push to `main`, that commit
  is deployed and `scripts/smoke.ts` runs against it.
- **production** is **Gateway → Run workflow** on `main`. It deploys the dispatched commit after
  checking it has a passed CI run, and waits for a `production` reviewer other than the person who
  dispatched it.

Each job runs two checks before deploying (`scripts/deploy-check.ts`):

- **Check required secrets** — `wrangler secret list` against the env's `secrets.required` rows in
  `wrangler.jsonc`; a missing name fails the job with the exact `wrangler secret put` command, and
  an absent Worker means the first deploy is the manual operator step below.
- **Plan rollback** — reads the active deployment's `deploy <sha>` annotation (the deploy step's
  `--message`), fetches that commit and compares its `migrations` in `wrangler.jsonc` with the
  deploying commit's. A failed smoke then rolls back to the planned version id. When the plan
  finds no safe target — no previous deployment, an unannotated deployment, or differing
  Durable Object migrations — the job alerts instead of rolling back, because Cloudflare refuses
  a rollback across a DO class lifecycle change
  (<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>).

**Staging and production live in different Cloudflare accounts.** Workers Scripts Edit is
account-wide, so a staging token in the production account could replace the production Worker,
read its secrets and write its KV. Each environment pins its `account_id` in `wrangler.jsonc`, and
the staging job refuses to deploy while staging's account equals production's or while the staging
token is not refused by the production account. **Staging still shares production's account today
and stays blocked by design until it has its own account**: create a separate account holding the
staging zone, create its RISK KV namespace, and update `env.staging.account_id` and the KV ids in
`wrangler.jsonc`.

Both environments accept deployments from `main` only.
`.github/rulesets/apply.sh <reviewer> <reviewer> [...]` creates them with those rules (two or more
reviewers, self-review prevented) and fails while a repository or organization secret named
`CLOUDFLARE_API_TOKEN` exists. Each environment's `CLOUDFLARE_API_TOKEN` is an **environment**
secret — an account token with **Account › Workers Scripts › Edit** on that environment's account
and **Zone › Workers Routes › Edit** on its zone (custom domains are created through the zone's
Workers Routes permission). The workflow stays off until the repository variable `GATEWAY_DEPLOY`
is `true`.

Roll back by hand with `bunx wrangler rollback --env production`.

## Operator runbook — first production deploy

1. Prerequisites: the production Cloudflare account (`env.production.account_id`) holds the
   `gateway.meowl.xyz` zone; a GitHub `production` environment with required reviewers and secret
   `CLOUDFLARE_API_TOKEN` scoped to that account only, with the permissions `wrangler deploy`
   needs for Workers scripts, KV, Durable Objects and custom domains.
2. The production `RISK` KV namespace exists and its id matches `wrangler.jsonc` (else
   `bunx wrangler kv namespace create RISK --env production` and update the id in a PR).
3. Confirm every operator assumption in `src/config/accounts.ts` against the provider consoles
   and adjust rows in a PR if they differ: Alchemy PAYG (10,000 CUPS); dRPC PAYG created after
   2026-10-19 (100 RPS); Ankr plan and rate; TronGrid key's QPS and daily quota (console); Tatum
   plan ≥ Starter with auto-upgrade turned off; CoinGecko Analyst (500/min, 500k/month); Jupiter
   keyed plan; 0x plan; Blockstream Enterprise credentials, credit balance, the per-call credit
   cost of plain Esplora calls and an acceptable rate/day cap; DefiLlama and Across keyless use.
4. Verify Ankr header auth with the real key:

   ```bash
   curl -s -H "x-api-key: $ANKR_API_KEY" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
     https://rpc.ankr.com/arbitrumnova   # must return 0xa4ba
   ```

5. Write the ten `secrets.required` values to a file outside the repository (mode 600).
6. From a clean checkout of a `main` commit whose CI passed:
   `bun install --frozen-lockfile && bunx vp run @qntx/wallet-engine#build`, then in
   `apps/gateway`
   `bunx wrangler deploy --env production --secrets-file <file> --message "deploy <sha>"`
   (this applies Durable Object migration v1); delete the file.
7. `bun scripts/smoke.ts https://gateway.meowl.xyz production`. This first deploy has no
   automatic rollback: there is no earlier version, and Cloudflare refuses a rollback across
   migration v1 — fix forward, or detach the custom domain to withdraw the gateway.
8. Set the repository variable `GATEWAY_DEPLOY=true`; later production deploys are the workflow's
   manual dispatch on `main`.
9. Watch `bunx wrangler tail --env production` for `budget-error`, `upstream-throttled` and
   `all-providers-failed` during the first hours.
10. Staging stays blocked until: a separate Cloudflare account holds the
    `wallet-gateway-staging.qntx.org` zone and a `RISK` KV namespace; `env.staging.account_id`
    and the KV ids are updated in `wrangler.jsonc`; the GitHub `staging` environment's
    `CLOUDFLARE_API_TOKEN` is scoped to that account only; its first deploy is the same manual
    `--secrets-file` step (with `ZEROX_API_KEY`).
