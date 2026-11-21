# @qntx/gateway

The wallet gateway: a Cloudflare Worker (Hono) that forwards allow-listed JSON-RPC and Esplora
requests to upstream providers with failover. Private, never published. It holds provider and
quote API keys — never wallet secrets — and signs — wallet data from it is for display and for reads the engine cross-checks.

| Route                            | Behavior                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                 | `{ "status": "ok" }`; needs no client id                                                                                                                                                                                        |
| `POST /v1/rpc/:caip2`            | EVM and Solana JSON-RPC 2.0, single or batch (max 20); read-only methods plus `eth_sendRawTransaction`/`sendTransaction`                                                                                                        |
| ↳ `eth_getLogs`                  | Bounded: one block by `blockHash`, a numbered range of at most 500 blocks, or tags that match or both name the head (`latest`/`pending`); at most 20 addresses and 20 alternatives per topic                                    |
| `GET\|POST /v1/esplora/:caip2/*` | Bitcoin Esplora: the engine's read paths plus `POST /tx`; bodies and content types pass through                                                                                                                                 |
| `GET /v1/networks`               | The served network ids, in configured order                                                                                                                                                                                     |
| `GET /v1/eligibility`            | Per-app availability for the caller's edge-resolved jurisdiction (`{ country, region, apps: { hyperliquid, polymarket } }` — `available`/`close-only`/`blocked`); `private, no-store`                                           |
| `POST /v1/history/:caip2`        | EVM transfers in and out of `{address}` (body), newest first, `cursor` pages backwards, `truncated` marks a page that dropped transfers it could not fit; Alchemy Transfers; `503 unavailable` on networks without it (staging) |
| `GET /v1/risk/lists/phishing`    | The hashed phishing list: a snapshot, a net diff since `?since=<version>`, or `current`; `503 unavailable` before the first build                                                                                               |
| `POST /v1/prices`                | Spot price and 24 h change of up to 100 CAIP-19 assets in one fiat currency; display-only (see "Prices")                                                                                                                        |
| `GET /v1/quotes/swap`            | EVM swap quote through 0x; `503 unavailable` without `ZEROX_API_KEY`                                                                                                                                                            |
| `GET /v1/quotes/swap/solana`     | Solana swap quote through Jupiter (keyless; `JUPITER_API_KEY` only sets the upstream header)                                                                                                                                    |
| `GET /v1/quotes/bridge`          | Across bridge quote between two networks (keyless)                                                                                                                                                                              |

Every other `/v1` request needs `x-client-id` (32 lowercase hex characters). Responses carry
`x-gateway-providers` with the provider that served them. Errors are `{ "error": <code> }`:
`400 invalid-request`, `404 unknown-network`/`not-found`, `429 rate-limited` and `503 unavailable`
(both with `Retry-After`), `502 outcome-unknown`, `500 internal`.

Providers are tried in the order of `src/config/networks.ts`. Every route reaches its upstreams
through one forwarder (`src/providers/forward.ts`), the only holder of `fetch`, and the breaker
counts only what the forwarder itself observes and no client input can provoke: a transport error,
a timeout (10 s), a 5xx, a 429 (the gateway's own account throttled) or a failed auth lookup. Five
consecutive outages open that provider's breaker for 30 s. Any other failed answer — a 401/403
refusal, another 4xx, a malformed body, an upstream JSON-RPC error on history — moves on to the next
provider without counting. A JSON-RPC error object on the RPC route is a valid answer and is
returned as-is. An upstream 400, 413 or 422 on a JSON-RPC route, and an answer over the route's
response cap, were provoked by the request itself: they are answered 400 `invalid-request` without
failover. Request schemas refuse up front what an upstream would reject (a history cursor above
int64, a quote amount wider than the chain's amount type). `tests/breaker.test.ts` enumerates every
registered route and holds each one to this accounting.

A request that relays a signed transaction (`eth_sendRawTransaction`, Solana `sendTransaction`,
Esplora `POST /tx`) fails over only when the failed attempt provably never reached the provider —
an open breaker, a 401/403/429 refusal, or a rejected auth lookup. Any other failure (timeout,
transport error, 5xx, malformed body) is ambiguous: the provider may have relayed the transaction,
so the request is answered 502 `outcome-unknown` rather than retried on a provider that could
double-broadcast it.

## Rate limiting

Three Workers limiters count weighted units per 10 s window (values in `wrangler.jsonc`): the
client IP prefix, then `x-client-id` + prefix on either the RPC limiter (transport routes) or the
default one. Every request — valid or not — pays one unit up front; an RPC request then pays the
summed cost of its calls minus the unit already charged. `RPC_COST_WEIGHTS` in the contract prices
a point read at 1, a VM run, proof or transaction relay at 3, and a scan (`eth_getLogs`,
`eth_getBlockReceipts`, `getVoteAccounts`, full-transaction blocks, programId-filtered
`getTokenAccountsByOwner`) at 10, so one `eth_chainId` still costs 1 while a batch of 20
`eth_getLogs` costs 200. Arrays the caller sizes pay per started 10 elements (`getMultipleAccounts`,
`getSignatureStatuses` at 1, `eth_getProof` storage keys at 3) and `eth_simulateV1` pays 3 per
simulated block or call, whichever is more. Esplora requests stay at one unit: every allow-listed
path is bounded. A history page pays 2 units for its two upstream calls, and a drain round 2 more,
charged before the drain is sent.

## Prices

`POST /v1/prices` takes `{ currency, assets }` — up to 100 distinct CAIP-19 ids in their canonical
spelling (`<caip2>/slip44:<n>`, `eip155:<n>/erc20:<lowercase address>`,
`solana:<ref>/token:<mint>`) — and answers `{ currency, prices, missing }`: every asset is either
priced (`price` as a decimal string, `change24h` in percent or `null`, `updatedAt` in Unix ms) or
`missing`. The asset set describes a portfolio, so it travels in the body and the answer is
`no-store`. It costs one rate-limit unit on the default limiter, plus one per upstream call its cache
misses fan out to (one per CoinGecko token platform and one for the native coins, two for DefiLlama),
charged before the calls are sent.

Each asset is looked up in a per-asset Cache API entry (30 s, keyed by currency and asset, never by
client), then asked of CoinGecko's Pro API (`COINGECKO_API_KEY`, sent as `x-cg-pro-api-key`), then
of DefiLlama's keyless coins API for whatever is still unpriced (USD only; it reaches the long tail
such as HyperEVM tokens, but prices major coins from CoinGecko itself, so it covers an outage, not a
wrong answer). Provider numbers are turned into decimal strings from their shortest round-trip
spelling and checked: positive, below 10^12, truncated to 18 decimals, updated at most 5 minutes
ahead and at most a day ago; a 24 h change below -100 % or with more than six integer digits becomes
`null`; DefiLlama quotes below confidence 0.9 are dropped. An asset is cached as `missing` only when
every provider answered; when no asset could be priced and a provider failed, the route answers 503.
Without a CoinGecko key (staging by default) only DefiLlama serves, so non-USD requests come back
`missing`.

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
`status-<n>`, `malformed`, `rpc-error`, `auth`, `timeout`, `breaker-open`, `rejected`, `too-large`,
`transport`, `error`),
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
testnet4) through keyless public endpoints — two per network, listed in `src/config/networks.ts`, at `https://wallet-gateway-staging.qntx.org`.

```bash
bunx wrangler login                     # once; the staging account (env.staging.account_id)
bun run --cwd apps/gateway deploy:staging
```

Roll back with `bunx wrangler rollback --env staging`.

## Production

Production serves mainnets only at `https://gateway.meowl.xyz` on account
`9241dfd75bea0009a3870173f7e1acd2` (`env.production.account_id`): every built-in EVM mainnet (the order and the list are
`src/config/networks.ts`; a test keeps it equal to the engine registry) plus Solana through Alchemy first and
dRPC second (both provider accounts must have every one of these networks enabled) (keys in request headers, never URLs — `Authorization: Bearer` and `Drpc-Key`), and
Bitcoin mainnet through Blockstream Enterprise's Esplora (client-credentials token, cached per
isolate). The RN app sends no `Origin`, so `CORS_ORIGINS` is empty.

Required secrets — set them **before** the first deploy, `wrangler deploy` refuses otherwise:

```bash
for NAME in ZEROX_API_KEY JUPITER_API_KEY ALCHEMY_API_KEY DRPC_API_KEY             BLOCKSTREAM_CLIENT_ID BLOCKSTREAM_CLIENT_SECRET COINGECKO_API_KEY; do
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
- A failed smoke rolls the environment back to its previous version (`wrangler rollback`).

**Staging and production live in different Cloudflare accounts.** Workers Scripts Edit is
account-wide, so a staging token in the production account could replace the production Worker,
read its secrets and write its KV. Each environment pins its `account_id` in `wrangler.jsonc`, and
the staging job refuses to deploy while staging's account equals production's or while the staging
token is not refused by the production account. Staging still shares production's account today
and stays blocked until it moves: create a separate account holding the staging zone, create its
RISK KV namespace, and update `env.staging.account_id` and the KV ids in `wrangler.jsonc`.

Both environments accept deployments from `main` only.
`.github/rulesets/apply.sh <reviewer> <reviewer> [...]` creates them with those rules (two or more
reviewers, self-review prevented) and fails while a repository or organization secret named
`CLOUDFLARE_API_TOKEN` exists. Each environment's `CLOUDFLARE_API_TOKEN` is an **environment**
secret — an account token with **Account › Workers Scripts › Edit** on that environment's account
and **Zone › Workers Routes › Edit** on its zone (custom domains are created through the zone's
Workers Routes permission). The workflow stays off until the repository variable `GATEWAY_DEPLOY`
is `true`.

Roll back by hand with `bunx wrangler rollback --env production`.
