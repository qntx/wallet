# @qntx/gateway

The wallet gateway: a Cloudflare Worker (Hono) that forwards allow-listed JSON-RPC and Esplora
requests to upstream providers with failover. Private, never published. It holds provider and
quote API keys — never wallet secrets — and signs — wallet data from it is for display and for reads the engine cross-checks.

| Route                            | Behavior                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                 | `{ "status": "ok" }`; needs no client id                                                                                                                                                     |
| `POST /v1/rpc/:caip2`            | EVM and Solana JSON-RPC 2.0, single or batch (max 20); read-only methods plus `eth_sendRawTransaction`/`sendTransaction`                                                                     |
| ↳ `eth_getLogs`                  | Bounded: one block by `blockHash`, a numbered range of at most 500 blocks, or tags that match or both name the head (`latest`/`pending`); at most 20 addresses and 20 alternatives per topic |
| `GET\|POST /v1/esplora/:caip2/*` | Bitcoin Esplora: the engine's read paths plus `POST /tx`; bodies and content types pass through                                                                                              |
| `GET /v1/risk/lists/phishing`    | The hashed phishing list: a snapshot, a net diff since `?since=<version>`, or `current`; `503 unavailable` before the first build                                                            |

Every other `/v1` request needs `x-client-id` (32 lowercase hex characters). Responses carry
`x-gateway-providers` with the provider that served them. Errors are `{ "error": <code> }`:
`400 invalid-request`, `404 unknown-network`/`not-found`, `429 rate-limited` and `503 unavailable`
(both with `Retry-After`), `502 outcome-unknown`, `500 internal`.

Providers are tried in the order of `src/config/networks.ts`. A transport error, timeout (10 s), a
non-2xx upstream status, or a malformed body moves on to the next provider; five consecutive
failures open that provider's breaker for 30 s. A JSON-RPC error object is a valid answer and is
returned as-is. An upstream 400, 413 or 422 was provoked by the request itself: it is answered 400
`invalid-request` without failover and without counting against the breaker.

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
`eth_getBlockReceipts`, `getMultipleAccounts`, `getVoteAccounts`, full-transaction blocks,
programId-filtered `getTokenAccountsByOwner`) at 10, so one `eth_chainId` still costs 1 while a
batch of 20 `eth_getLogs` costs 200. Esplora requests stay at one unit: every allow-listed path is
bounded.

## Phishing list

`buildPhishingList` (the `scheduled` handler) fetches every source, keeps
the entries `phishingKey` accepts, hashes them to 8 bytes, and — only when the merged deny or allow
set changed — writes `phishing:snapshot` and then `phishing:journal` to the `RISK` KV namespace. The
journal keeps 7 days and at most 168 entries; a request with `since` inside it gets one folded diff.
A failing source, or a deny list that shrank by more than half, skips the build and logs one JSON
line. Both environments run the build hourly (`"0 * * * *"`). KV namespaces:
`wallet-gateway-staging-risk` (staging), `wallet-gateway-risk` (production).

| Source                                                                                            | License                                                                                                                 | Used                                         |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [MetaMask eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect) `src/config.json` | [DBAD 1.2](https://github.com/MetaMask/eth-phishing-detect/blob/main/LICENSE): attribution required, no verbatim resale | `blacklist` and `whitelist`; not `fuzzylist` |
| [Polkadot phishing](https://github.com/polkadot-js/phishing) `all.json`                           | Apache-2.0                                                                                                              | `deny` and `allow`; not `denySub`            |

The list is derived data: entries are normalized and truncated to 8-byte hashes, and the original
lists are not redistributed. Attribution: phishing data from MetaMask eth-phishing-detect and
polkadot-js/phishing.

## Layering

`src/` imports exactly one workspace package: `@qntx/wallet-engine/gateway/contract` (schemas, the
method and path allow-lists, the network registry). A lint rule in the root `vite.config.ts`
rejects any other `@qntx/*` import, so the gateway never depends on engine runtime code. Contract
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

Staging serves testnets only (Sepolia, Base Sepolia, Solana devnet, Bitcoin signet and testnet4)
through keyless public endpoints, at `https://wallet-gateway-staging.qntx.org`.

```bash
bunx wrangler login                     # once; the staging account (env.staging.account_id)
bun run --cwd apps/gateway deploy:staging
```

Roll back with `bunx wrangler rollback --env staging`.

## Production

Production serves mainnets only at `https://gateway.meowl.xyz` on account
`9241dfd75bea0009a3870173f7e1acd2` (`env.production.account_id`): the eight EVM mainnets plus Solana through Alchemy first and
dRPC second (keys in request headers, never URLs — `Authorization: Bearer` and `Drpc-Key`), and
Bitcoin mainnet through Blockstream Enterprise's Esplora (client-credentials token, cached per
isolate). The RN app sends no `Origin`, so `CORS_ORIGINS` is empty.

Required secrets — set them **before** the first deploy, `wrangler deploy` refuses otherwise:

```bash
for NAME in ZEROX_API_KEY JUPITER_API_KEY ALCHEMY_API_KEY DRPC_API_KEY             BLOCKSTREAM_CLIENT_ID BLOCKSTREAM_CLIENT_SECRET; do
  bunx wrangler secret put "$NAME" --env production
done
```

(`ZEROX_FEE_RECIPIENT`/`ZEROX_FEE_BPS` stay optional.)

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
