# @qntx/gateway

The wallet gateway: a Cloudflare Worker (Hono) that forwards allow-listed JSON-RPC and Esplora
requests to upstream providers with failover. Private, never published. It holds provider and
quote API keys — never wallet secrets — and signs — wallet data from it is for display and for reads the engine cross-checks.

| Route                             | Behavior                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`                  | `{ "status": "ok" }`; needs no client id                                                                                                                                                                                                                                 |
| `POST /v1/rpc/:caip2`             | EVM and Solana JSON-RPC 2.0, single or batch (max 20); read-only methods plus `eth_sendRawTransaction`/`sendTransaction`                                                                                                                                                 |
| ↳ `eth_getLogs`                   | Bounded: one block by `blockHash`, a numbered range of at most 500 blocks, or tags that match or both name the head (`latest`/`pending`); at most 20 addresses and 20 alternatives per topic                                                                             |
| `GET\|POST /v1/esplora/:caip2/*`  | Bitcoin Esplora: the engine's read paths plus `POST /tx`; bodies and content types pass through                                                                                                                                                                          |
| `POST /v1/tron/:caip2/*`          | TRON node API: an allow-list of `/wallet/*` and `/walletsolidity/*` paths plus the TronGrid `/v1/accounts` indexer feeds (TronGrid providers only); request bodies are schema-checked, `broadcasthex` follows the broadcast rule below                                   |
| `GET /v1/networks`                | The served network ids, in configured order                                                                                                                                                                                                                              |
| `GET /v1/eligibility`             | Per-app availability for the caller's edge-resolved jurisdiction (`{ country, region, apps: { hyperliquid, polymarket } }` — `available`/`close-only`/`blocked`); `private, no-store`                                                                                    |
| `POST /v1/history/:caip2`         | EVM transfers in and out of `{address}` (body), newest first, `cursor` pages backwards, `truncated` marks a page that dropped transfers it could not fit; Alchemy Transfers; `404 unsupported` on served networks without it                                             |
| `POST /v1/approvals/:caip2`       | EVM approval candidates for `{address}` (body): token, spender and block keys from the owner's Approval/ApprovalForAll and Permit2 events — display-only, the engine confirms each on chain; Alchemy `eth_getLogs`; `404 unsupported` on chains with a bounded log range |
| `POST /v1/nfts/items/:caip2`      | NFTs owned by `{owner}` (body), `cursor` pages forward; Alchemy NFT API on EVM, DAS `getAssetsByOwner` on Solana; display-only; `404 unsupported` on uncovered networks                                                                                                  |
| `POST /v1/nfts/item/:caip2`       | One NFT's detail `{contract, tokenId?}` (tokenId on EVM only — a Solana asset is its own id); Alchemy `getNFTMetadata` / DAS `getAsset`; `404 not-found` when DAS reports the asset missing                                                                              |
| `POST /v1/nfts/collection/:caip2` | Collection descriptor `{collection}`; Alchemy `getContractMetadata` on EVM, `getAsset` on Solana                                                                                                                                                                         |
| `POST /v1/nfts/floor/:caip2`      | Marketplace floor quotes `{collection}`; Alchemy `getFloorPrice`, EVM only and on the chains it serves — every other network answers `404 unsupported`                                                                                                                   |
| `GET /v1/tokens/:caip2`           | The published token list for the network, ETag + `if-none-match`; `404 unsupported` when no configured source covers it, `503 unavailable` until the first build lands                                                                                                   |
| `GET /v1/risk/lists/phishing`     | The hashed phishing list: a snapshot, a net diff since `?since=<version>`, or `current`; `503 unavailable` before the first build                                                                                                                                        |
| `POST /v1/prices/:family`         | Spot price and 24 h change of up to 100 CAIP-19 assets of one chain family in one fiat currency; display-only (see "Prices")                                                                                                                                             |
| `GET /v1/quotes/swap`             | EVM swap quote through 0x; `503 unavailable` without `ZEROX_API_KEY`                                                                                                                                                                                                     |
| `GET /v1/quotes/swap/solana`      | Solana swap quote through Jupiter (keyless; `JUPITER_API_KEY` only sets the upstream header)                                                                                                                                                                             |
| `GET /v1/quotes/bridge`           | Across bridge quote between two networks (keyless)                                                                                                                                                                                                                       |

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
documentation's "Strict limits" section prescribes exactly this). Each object keeps two kinds of
limit in its SQLite storage. **Rate windows** (the account's `rate` list) are token buckets of at
most 60 s — our share of the provider's own throttle, sized by the rule c + r·T ≤ L: depth c plus
refill r over the window T never exceeds the provider's published limit L. **Spend caps** (the
account's `cap`) are hard sliding quotas in the provider's own billing unit — 24 h (the current
hour slot plus the previous 24) and 31 days — enforced by the same Durable Object and kept across
deploys, so a redeploy that re-sizes a rate window never refills a spent cap. Exceeding a cap
means that provider is spent: the request fails over — never a breaker outage, never an unbilled
call — and when every provider is spent or cooling the 503 `unavailable` carries the shortest
announced wait. Each isolate holds a two-second adaptive lease from the object (sized by what it
actually spent, capped at 5 % of the account's tightest rate window) so the object sees seconds,
not requests — a Durable Object's ~1,000 rps soft limit and its round trip are amortised away.
Operator note: the plan table lives in `src/config/accounts.ts`, each row's comment carrying the
published inputs, their source URL and the derivation — review it when a plan changes.

TRON providers are priced in TronGrid Credits per path (`TRONGRID_COSTS` in `src/budget/costs.ts`,
transcribed from trongrid.io's credit-cost table — 80 credits for most node paths, 200 for the
dearest indexer rows); Tatum has no published credit schedule, so its POLICY price is 5 credits a
call.

The global budgets are sized for ≥ 20 concurrently active all-family wallets each
foreground-refreshing once per minute, plus 10 fresh all-family cold starts per minute (numbers
from `packages/wallet-engine/tests/gateway-capacity.test.ts`): Alchemy 20 × 1,570 + 10 × 7,150 =
102,900 CU/min ≤ the 360,000 CU/min rate; Blockstream 20 × 81 + 10 × 200 = 3,620 calls/min ≤ the
4,000/min rate; CoinGecko's whole minute is 210 calls. Alchemy units are the maximum of billed CU
and throughput CU, so one meter never under-counts the bill (the caps) nor the throughput (the
rate). The day caps are the money bound: Alchemy's $10/day ceiling is ≈ 19.0M CU ≈ 185 minutes a
day at the 102,900 CU/min design peak — beyond it the provider is spent and traffic fails over
rather than billing overage.
TRON is the known exception: a fresh wallet costs 3 calls, but a used wallet's history fetches
`getassetissuebyid` once per TRC-10 row — ≈ 50 calls per refresh, ≈ 4,000 TronGrid credits —
which bursts past TronGrid's 250 credits/s share; Tatum absorbs the rest, and raising the depth
waits on an engine-side history cache (outside this change).

The hourly token-list build pays from the same account budgets (one CoinGecko or Jupiter unit per
source fetch) and skips a source whose budget refuses rather than billing it. Alchemy's webhook
deliveries — billed 0.04 CU/byte by Alchemy — are push traffic the gateway cannot meter and stay
outside the caps.

## Prices

`POST /v1/prices/:family` takes `{ currency, assets }` — up to 100 distinct CAIP-19 ids in their
canonical spelling (`<caip2>/slip44:<n>`, `eip155:<n>/erc20:0x<lowercase address>`,
`solana:<ref>/token:<mint>`) — and answers `{ currency, prices, missing, unsupported }`: every
asset is either priced (`price` as a decimal string, `change24h` in percent or `null`, `updatedAt`
in Unix ms), `missing` (no provider had a price now — a later request may) or `unsupported` (no
price provider maps the asset — permanent, never asked upstream, never cached).

Price requests are partitioned by chain family (`evm`, `solana`, `bitcoin`, `tron`): the engine
sends one request per family scope, the route rejects a body naming another family's assets, and
each request travels under that family's own client id — the engine's per-scope ids are
unlinkable, so a cross-family portfolio never appears in one request and the asset set links no
scopes beyond what each scope's own traffic already shows. What stays linkable is what all
gateway traffic shares: the client IP and the timing of the per-family requests; hiding those
needs an OHTTP-style relay, which the route layout does not preclude.

The asset set describes a portfolio, so it travels in the body and the answer is `no-store`. Each
upstream call a request's cache misses fans out to (one per CoinGecko token platform and one for
the native coins, two for DefiLlama) is billed to the request's share of the source's account.

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

## Push notifications

The gateway delivers transaction-state pushes (`received`, `sent`, `failed`, `reverted`) built so
the push providers see nothing about the user: the APNs/FCM payload is only an opaque event id and
an AES-256-GCM blob the wallet opens with a key the gateway never stores in clear. What the
providers do see — a device token inside their own protocol envelope — is unavoidable; everything
else (address, hash, network, amount, symbol) stays out of provider requests and log lines.

Routes: `GET /v1/push` (capabilities), `PUT|DELETE /v1/push/:family/subscription` (Bearer is the
32-byte push secret, base64url — the subscription id is its derived hash), and
`POST /v1/push/:family/transactions` (register an outgoing hash to watch). The Alchemy watcher
calls `POST /hooks/alchemy` — outside `/v1`, so no client id or client limiter; the
`X-Alchemy-Signature` HMAC over the raw body authenticates it.

Storage lives in a SQLite Durable Object per family (`PUSH`): sealed subscription targets (device
token + payload key under `PUSH_SEAL_KEY`), watched (network, address) pairs, transaction records
and an outbox. Subscriptions expire after `PUSH_TTL_MS` of no renewal, records after 24 h, outbox
deliveries after 1 h; the alarm — re-derived from the store after every mutation — sweeps
expirations, checks pending records against receipts in one JSON-RPC batch per network (billed to
the provider account budget, never a client share), delivers due outbox rows, and reconciles the
watcher's address set against the `synced` table. Only EVM is watched (Alchemy Address Activity
webhooks); Solana, Bitcoin and TRON answer `404 unsupported`.

Environment (all optional — an incomplete set disables push rather than failing the deploy):
`PUSH_SEAL_KEY` (32 bytes base64); `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (the
`.p8` provider key, staging builds target `api.sandbox.push.apple.com`);
`FCM_SERVICE_ACCOUNT` (the service-account JSON); `ALCHEMY_NOTIFY_TOKEN` and `ALCHEMY_WEBHOOKS`
(`{"<caip2>": {"id": "<webhook id>", "signingKey": "<key>"}}`, one entry per watched EVM network —
both vars must be set together).

Operations:

- Create one Alchemy Address Activity webhook per watched EVM network pointed at
  `https://<host>/hooks/alchemy`, then set `ALCHEMY_WEBHOOKS` to each network's webhook id and
  signing key and `ALCHEMY_NOTIFY_TOKEN` to the dashboard auth token. The object keeps the
  webhook's address list in sync — it PATCHes `update-webhook-addresses` in ≤ 500-address batches
  as subscriptions change.
- APNs needs the deployed Worker's HTTP/2 egress: local `wrangler dev` cannot reach Apple
  (cloudflare/workerd#4841), so end-to-end APNs verification happens post-deploy — e.g. subscribe
  an all-zero device token and expect a `BadDeviceToken` in Workers Logs.
- Adding the `PushObject` migration makes a deploy non-rollbackable — check `deploy-check` output
  before shipping it.

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
there is no alerting code in the worker. [OPERATIONS.md](OPERATIONS.md) drafts the alert
definitions, SLO targets, the on-call runbook and the per-account capacity table.

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
bunx wrangler login                     # once; the one account (env.staging.account_id)
bun run --cwd apps/gateway deploy:staging
```

A deploy from a laptop skips the pipeline's gate ("Deployment pipeline"); keep it for the first
deploy and for a pipeline outage. Roll back with `bunx wrangler rollback --env staging`.

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
  waits for a `staging` reviewer, is deployed, and `scripts/smoke.ts` runs against it.
- **production** is **Gateway → Run workflow** on `main`. It deploys the dispatched commit after
  checking it has a passed CI run, and waits for a `production` reviewer.

With one reviewer the approver is the person who merged or dispatched: the approval is a deliberate
second step, not a second person (`.github/rulesets/README.md` "Single maintainer").

The `gate` job runs first, outside any environment, and stops both deploy jobs when either check
fails:

- **Refuse a shared token** — a job outside an environment sees only repository and organization
  secrets, so any `CLOUDFLARE_API_TOKEN` it can read is one every job can read.
- **Same reviewer gate, no shared state** — `scripts/deploy-check.ts environments` reads both
  GitHub environments and fails unless each exists, has a required reviewer, refuses administrator
  bypass and deploys from branch `main` only, and both name the same reviewers with the same
  self-review rule; it also fails when the deploying commit's `wrangler.jsonc` lets staging share
  state with production (`sharedState`, below).

Each deploy job then runs three checks before deploying (`scripts/deploy-check.ts`):

- **Token** — `token <env>`: the environment's `CLOUDFLARE_API_TOKEN` must be an active account API
  token of `env.<env>.account_id`; Cloudflare's `GET /accounts/{account_id}/tokens/verify` accepts
  only that account's own tokens, so the token cannot reach another account.
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

The workflow stays off until the repository variable `GATEWAY_DEPLOY` is `true`. Roll back by hand
with `bunx wrangler rollback --env production`.

### One Cloudflare account

Staging and production run in one Cloudflare account (`env.staging.account_id` equals
`env.production.account_id`). **Account › Workers Scripts › Edit** is account-wide and Cloudflare
cannot narrow it to one Worker, so the token that deploys staging can also replace the production
Worker — and through the code it deploys, read every production secret and write the production
`RISK` list. The scheme protects production by treating a staging deploy as a production deploy:

- **Same gate.** Both GitHub environments require the same reviewer, deploy from `main` only and
  refuse administrator bypass. `.github/rulesets/apply.sh <reviewer>` configures them; the `gate`
  job refuses to deploy otherwise.
- **Environment secret only.** Each environment's `CLOUDFLARE_API_TOKEN` is an environment secret;
  `apply.sh` and the `gate` job both fail while a repository or organization secret of that name
  exists. Create one account API token per environment with **Account › Workers Scripts › Edit**
  and **Zone › Workers Routes › Edit** on that environment's zone only (custom domains are created
  through the zone's Workers Routes permission). Two tokens give separate revocation and audit
  trails, not separate power.
- **No shared state.** Staging has its own Worker name — and with it its own secrets, Durable
  Object storage and deployment history — hostname, `RISK` KV namespace and rate-limit namespace
  ids, and its own provider keys (a separate 0x key). `sharedState` in `scripts/deploy-check.ts`
  lists anything the two envs share; `tests/deploy-check.test.ts` and the `gate` job fail when
  `wrangler.jsonc` shares anything.

What the workflow cannot verify:

- the token's permissions and expiry, and that the two environments hold different tokens —
  reading a token's policies needs a token-read permission a deploy token must not carry;
- that an administrator leaves the environments as the `gate` job read them, or does not approve
  their own deployment — with one maintainer that approval is the whole gate;
- that staging's provider keys differ from production's — Cloudflare never returns secret values;
- deploys outside the workflow — any other token with Workers access, the Global API Key, or a
  dashboard login of an account member can replace either Worker.

**Residual: one account is one blast radius.** Whoever holds either deploy token, approves either
deployment or has Workers access in the account controls the production gateway. That is the
compromised-gateway position of `SECURITY.md` — wrong display data and withheld broadcasts, no
signing power — reached through staging as easily as through production.

### Splitting staging into its own account

1. Create the staging Cloudflare account. In the current account, delete the staging Worker
   (`bunx wrangler delete --env staging`), its `RISK` namespace and preview namespace
   (`bunx wrangler kv namespace delete --namespace-id <id>`), and revoke the staging token.
2. Give the new account a zone for the staging hostname. A zone belongs to one account: move
   `qntx.org` there, or pick a hostname on a zone the new account holds and update
   `env.staging.routes` and the staging smoke URL in `.github/workflows/gateway.yml`.
3. Set `env.staging.account_id` to the new account, then (logged in to it)
   `bunx wrangler kv namespace create RISK --env staging` and the same with `--preview`; put the new
   `id`/`preview_id` in `wrangler.jsonc`, run `bun run --cwd apps/gateway types`, and land it in a
   PR.
4. Create an account API token in the new account (**Workers Scripts › Edit**, **Workers Routes ›
   Edit** on the staging zone) and store it with `gh secret set CLOUDFLARE_API_TOKEN --env staging`.
5. Deploy the new staging Worker once by hand with its secrets (runbook step 8). From then on the
   `token staging` check proves the staging token belongs to the new account, which no longer holds
   production.
6. Update "One Cloudflare account" above and the gateway residual in `SECURITY.md`. Whether staging
   keeps the production reviewer is then a separate choice in `.github/rulesets/apply.sh`.

## Operator runbook — first deploy

1. Prerequisites: the one Cloudflare account (`env.production.account_id`, equal to
   `env.staging.account_id`) holds the `meowl.xyz` zone (production, `gateway.meowl.xyz`) and the
   `qntx.org` zone (staging, `wallet-gateway-staging.qntx.org`); `.github/rulesets/apply.sh
   <reviewer>` has configured the GitHub `staging` and `production` environments with the same
   required reviewer; each environment holds its own `CLOUDFLARE_API_TOKEN` environment secret — an
   account API token of that account with the permissions in "One Cloudflare account".
2. The `RISK` KV namespaces exist and their ids match `wrangler.jsonc` — production's `id`,
   staging's `id` and `preview_id`, all distinct (else
   `bunx wrangler kv namespace create RISK --env <env>`, plus `--preview` for staging, and update
   the ids in a PR).
3. Confirm every operator assumption in `src/config/accounts.ts` against the provider consoles
   and adjust rows in a PR if they differ: Alchemy PAYG (10,000 CUPS); dRPC PAYG created after
   2026-10-19 (100 RPS); Ankr plan and rate; TronGrid key's quota (since TronGrid v1.12.0,
   2026-11-23, metered in Credits per day and per second — console); Tatum plan ≥ Starter with
   auto-upgrade turned off; CoinGecko Analyst (500/min, 500k/month); Jupiter keyed plan; 0x plan;
   Blockstream Explorer API credentials, credit balance, the per-call credit cost of plain Esplora
   calls and an acceptable rate/day cap; DefiLlama and Across keyless use.
4. Verify Ankr header auth with the real key:

   ```bash
   curl -s -H "x-api-key: $ANKR_API_KEY" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
     https://rpc.ankr.com/arbitrumnova   # must return 0xa4ba
   ```

5. Write the ten production `secrets.required` values to a file outside the repository (mode 600),
   and staging's (`ZEROX_API_KEY` — its own 0x key, never production's) to a second one.
6. From a clean checkout of a `main` commit whose CI passed:
   `bun install --frozen-lockfile && bunx vp run @qntx/wallet-engine#build`, then in
   `apps/gateway`
   `bunx wrangler deploy --env production --secrets-file <file> --message "deploy <sha>"`
   (this applies Durable Object migration v1); delete the file.
7. `bun scripts/smoke.ts https://gateway.meowl.xyz production`. This first deploy has no
   automatic rollback: there is no earlier version, and Cloudflare refuses a rollback across
   migration v1 — fix forward, or detach the custom domain to withdraw the gateway.
8. The same for staging from the same checkout:
   `bunx wrangler deploy --env staging --secrets-file <staging file> --message "deploy <sha>"`,
   delete the file, then `bun scripts/smoke.ts https://wallet-gateway-staging.qntx.org staging`.
9. Set the repository variable `GATEWAY_DEPLOY=true`; staging then follows `main` behind its
   reviewer, and production deploys are the workflow's manual dispatch on `main`.
10. Watch `bunx wrangler tail --env production` for `budget-error`, `upstream-throttled` and
    `all-providers-failed` during the first hours.
