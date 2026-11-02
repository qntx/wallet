# @qntx/gateway

The wallet gateway: a Cloudflare Worker (Hono) that forwards allow-listed JSON-RPC and Esplora
requests to public providers with failover. Private, never published. It holds no secrets and signs
nothing — wallet data from it is for display and for reads the engine cross-checks.

| Route                            | Behavior                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`                 | `{ "status": "ok" }`; needs no install id                                                                                |
| `POST /v1/rpc/:caip2`            | EVM and Solana JSON-RPC 2.0, single or batch (max 20); read-only methods plus `eth_sendRawTransaction`/`sendTransaction` |
| `GET\|POST /v1/esplora/:caip2/*` | Bitcoin Esplora: the engine's read paths plus `POST /tx`; bodies and content types pass through                          |

Every other `/v1` request needs `x-install-id` (32 lowercase hex characters). Responses carry
`x-gateway-providers` with the provider that served them. Errors are `{ "error": <code> }`:
`400 invalid-request`, `404 unknown-network`/`not-found`, `429 rate-limited` and `503 unavailable`
(both with `Retry-After`), `500 internal`.

Providers are tried in the order of `src/config/networks.ts`. A transport error, timeout (10 s), 5xx
or 429, or a malformed body moves on to the next provider; five consecutive failures open that
provider's breaker for 30 s. A JSON-RPC error object is a valid answer and is returned as-is.

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
curl -s -H "x-install-id: $ID" -H content-type:application/json \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  http://127.0.0.1:8787/v1/rpc/eip155:11155111
curl -s -H "x-install-id: $ID" \
  http://127.0.0.1:8787/v1/esplora/bip122:00000008819873e925422c1ff0f99f7c/block-height/0
```

After changing `wrangler.jsonc`, regenerate the committed runtime types:
`bun run --cwd apps/gateway types`.

## Deploy staging

Staging serves testnets only (Sepolia, Base Sepolia, Solana devnet, Bitcoin signet and testnet4)
through keyless public endpoints, at `https://wallet-gateway-staging.qntx.org`. Production is not
defined yet.

```bash
bunx wrangler login                     # once; the Cloudflare account owning qntx.org
bun run --cwd apps/gateway deploy:staging
```

Roll back with `bunx wrangler rollback --env staging`.
