# Gateway data-provider evaluation — qntx/wallet

Audit date: **2026-11-18** ("read 2026-11-18" applies to every citation below unless noted).
Scope: backend data services for a non-custodial consumer wallet on **10 mainnets**:
Ethereum (1), Base (8453), Arbitrum One (42161), OP Mainnet (10), Polygon PoS (137),
BNB Smart Chain (56), HyperEVM (999), Avalanche C-Chain (43114), Solana, Bitcoin.

Capabilities:
- **A** Balances + fungible-token discovery (multi-chain in one call)
- **B** Prices: current + 24 h change + historical charts
- **C** Normalized transaction history incl. *incoming* transfers and EVM internal/trace transfers
- **D** NFT ownership + metadata + spam flags (EVM 721/1155; Solana Metaplex incl. compressed via DAS)
- **E** Address-activity webhooks / streams
- **F** Transaction simulation with asset changes
- **G** Address/contract/token risk & spam scoring

"Not verified" = could not be confirmed from a primary source on 2026-11-18. No API keys were used; all probes are keyless (`probes/`).

---

## 1. Alchemy — <https://www.alchemy.com>

**Product set reviewed:** Portfolio APIs (`tokens/by-address`, `nft/by-address`, `transfers/by-address`),
Transfers API (`alchemy_getAssetTransfers`), NFT API, Prices API, Notify/webhooks, Simulation APIs.

| Field | Evidence |
|---|---|
| Chain coverage | Docs "Chains" page lists Ethereum, BNB, Avalanche, Arbitrum, OP Mainnet, Base, Polygon, Solana, Bitcoin, and Hyperliquid support. **Per-product coverage varies sharply.** `transfers/by-address` supports 17 EVM networks — the enum **excludes HyperEVM, Avalanche, Bitcoin and Solana**; the `internal` transfer category is only supported on Ethereum, Base, Polygon, Arc, Robinhood Chain, Elysium. Address-Activity webhooks: 30+ EVM chains + Solana; internal-transfer webhook support lists ETH/Polygon/Arbitrum/Optimism/Base/BNB/Avalanche — **HyperEVM not listed**. Source: <https://docs.alchemy.com/reference/get-transfers-by-address>, <https://docs.alchemy.com/reference/address-activity-webhook>, <https://www.alchemy.com/docs/reference/feature-support-by-chain.md> (read 2026-11-18). Per-product HyperEVM support is **not verified** for most APIs — Alchemy lists Hyperliquid chain support for Node RPC, but the Portfolio/Transfer API enums exclude it. |
| Pricing | Free: **30M CU/mo, 15 req/s**, 5 apps, 5 webhooks. Pay-as-you-go: **$0.52 / 1M CU**, ≥300 req/s, 30 apps, 100 webhooks. Enterprise ≥1,000 req/s, custom. Extra throughput $160 per 5,000 CU/s block. Source: <https://www.alchemy.com/pricing> (read 2026-11-18). |
| Endpoint unit costs | `alchemy_getAssetTransfers` 120 CU; Portfolio `transfers/by-address` 480 CU (dynamic pricing); `alchemy_simulateAssetChanges` / `alchemy_simulateExecution` 2,500 CU each, bundle variants 4,500 CU; `getTokenAccountsByOwner` 10 CU; DAS `getAssetsByOwner` 480 CU / `getAsset` 80 CU; webhooks 0.04 CU/byte (≈40 CU per 1 kB event). Source: <https://docs.alchemy.com/reference/compute-unit-costs> (read 2026-11-18). |
| Rate limits | Free 15 req/s; PAYG 300 req/s; Enterprise 1,000+ req/s (source: pricing page above). |
| ToS / licence | Terms of Service §2.1: use "**solely for your internal business purposes**". §2.2(v) prohibits: "frame, mirror, sell, resell, rent or lease use of the Services to any other Third Party, or otherwise allow any Third Party to use the Services for any purpose other than for your benefit … unless otherwise agreed in writing by Alchemy." Alchemy defines an "End User" (third-party individuals using apps built on the Services) and has separate End User terms, but the general clause makes consumer-wallet backend use **legally sensitive — requires written agreement**. Source: <https://legal.alchemy.com/> Terms of Service (read 2026-11-18). |
| Privacy | Privacy Notice: automatic collection "may include IP address, user settings, MAC address, cookie identifiers, mobile carrier, device/browser information, approximate location derived from IP, ISP, pages visited, links clicked, frequency, duration and usage activity." Note: page shows mixed "effective November 12th 2026" / "Last Updated June 27, 2025" labels. Source: <https://legal.alchemy.com/> Privacy Notice (read 2026-11-18). |
| Data quality | Transfers API returns native + ERC-20 + ERC-721 + ERC-1155 + internal transfers; incoming transfers supported (`toAddress` filter). Internal transfers **exclude** zero-value calls, `delegatecall`, miner rewards. Pagination capped at 1,000 results/page; page-key TTL 10 min. `tokens/by-address` max **2 addresses × 5 networks** per request; `transfers/by-address` max 5 networks/request. NFT endpoint includes spam classification fields. Source: <https://docs.alchemy.com/reference/transfers-api-quickstart>, <https://docs.alchemy.com/reference/get-tokens-by-address> (read 2026-11-18). |
| Self-hostable | No (SaaS). |
| Webhook limits | Max 100,000 tracked addresses per Address-Activity webhook. Source: <https://docs.alchemy.com/reference/address-activity-webhook> (read 2026-11-18). |

**qntx verdict:** A/C/D/E/F strong on 7-8 EVM chains; **HyperEVM missing from Portfolio/Transfer enums**, Bitcoin only via Node RPC (no normalized data), Solana supported for RPC + DAS + webhooks. ToS needs a written agreement for consumer-wallet end-user serving.

## 2. Zerion API — <https://developers.zerion.io>

**Product set:** Wallet portfolio/fungible positions, decoded transactions, NFT positions, fungible charts/prices, PnL, wallet sets (EVM+Solana combined), webhook transaction subscriptions, Kafka streaming, spam filtering.

| Field | Evidence |
|---|---|
| Chain coverage | Supported-chains page (regenerated daily from live `/chains` endpoint): **41 mainnets**. All qntx EVM chains ✓: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB (`binance-smart-chain`), Avalanche — Tokens/Txns/DeFi/NFTs all ✓. **HyperEVM: Tokens ✓, Txns ✓, DeFi ✓, NFTs –.** Solana: Tokens ✓, Txns ✓, DeFi 🔜, NFTs –. **Bitcoin not listed.** Source: <https://developers.zerion.io/supported-blockchains.md> (read 2026-11-18): "\*\*41\*\* chains \*\*23\*\* with DeFi positions \*\*20\*\* with NFTs". |
| Pricing | Developer **$0 forever: 2K req/day, 3 RPS**. Builder **$149/mo: 250K req/mo, 10 RPS**. Startup **$499/mo: 1M req/mo, 25 RPS**. Enterprise custom: 2.5M+ req/mo, custom RPS, 99.9% SLA. Note: "DeFi Positions, Wallet Portfolio Chart, and Wallet P&L endpoints are limited to 25% of every plan quota and aren't covered by overages." Also offers keyless pay-per-request via x402/MPP in USDC. Source: <https://zerion.io/api> pricing section (read 2026-11-18). |
| Rate limits | Plan-based; every response carries `RateLimit-Org-Second/Day/Month-*` headers; 429 JSON error on throttle. Exact per-plan numbers above. Source: <https://developers.zerion.io/rate-limits.md> (read 2026-11-18). |
| ToS / licence | API ToS page **not verified** (no public API-specific ToS located on 2026-11-18). Marketing page explicitly positions it as consumer-wallet infrastructure — "Zerion is the onchain data layer powering wallets, fintechs, neobanks and AI agents"; customers: MetaMask, Kraken, Base App, Privy, Uniswap Wallet, "250M+ Users served". Source: <https://zerion.io/api> (read 2026-11-18). Caching/redistribution clauses: not verified. |
| Privacy | Not verified. |
| Data quality | Built-in spam/scam token filtering with opt-in/opt-out `trust` parameter (<https://developers.zerion.io/spam-filtering.md>). Decoded transactions include incoming receives, approvals, swaps; cursor pagination; `filter[chain_ids]` for multi-chain in one call; `wallet-sets` endpoints merge EVM+Solana into one timeline. EVM internal/trace transfer inclusion in decoded history: **not verified** explicitly. |
| Self-hostable | No (SaaS); open-source agent CLI only (github.com/zeriontech/zerion-ai). |
| Webhooks | "Subscriptions to Transactions": POST `callback_url` + wallet `addresses`, optional `chain_ids` filter, spam/type/protocol/address exclusion filters; works on EVM chains + Solana; delivers failed txns for smart-contract wallets. Max addresses/subscription: not verified. Source: <https://developers.zerion.io/webhooks.md> (read 2026-11-18). |

**qntx verdict:** Closest single-vendor fit: A/B/C(partial)/D/E over 9/10 networks (Bitcoin missing; HyperEVM NFTs missing; Solana NFTs/DeFi pending). Purpose-built for consumer wallets; endorsed migration target by Dune for Sim customers.

## 3. Moralis — <https://moralis.com>

| Field | Evidence |
|---|---|
| Chain coverage | Data API supports all qntx EVM chains + **HyperEVM explicitly** (Data API, Streams and RPC all list hyperevm per docs supported-chains tables) + Solana; Bitcoin via Universal/Data APIs but **no NFTs/internal txns on BTC**. Source: <https://docs.moralis.com/get-started/supported-chains>, <https://docs.moralis.com/data-api/supported-chains>, <https://docs.moralis.com/streams/supported-chains> (read 2026-11-18). Streams row for HyperEVM extracted from supported-chains docs — verified present, exact per-event-type parity not verified. |
| Pricing | No self-serve free plan (free trial via team). Data Feeds Starter **$10/mo / 10 GB**. Starter **$149/mo: 2M CU, 40 RPS**. Pro **$249/mo: 100M CU, 80 RPS**. Business **$749/mo: 500M CU, 200 RPS**. Enterprise custom. Extra CU: $11.25/M (Starter), $5/M (Pro), $4/M (Business). Source: <https://moralis.com/pricing/> (read 2026-11-18). |
| Rate limits | 40 / 80 / 200 RPS per tier (above). |
| ToS / licence | General Terms v1.4 (Aug 2026) §1.1: "The Client may not transfer, sub-licence or in any other way provide, permit or utilise the Services for use by a third party, e.g. through time-sharing, as a service or otherwise." Plus a single-entity account clause. **Consumer-wallet backend use is contractually sensitive** — end users consuming Moralis data through qntx may fall under "provide … for use by a third party"; needs clarification/enterprise agreement. Source: <https://moralis.com> General Terms (read 2026-11-18). |
| Privacy | Terms §7: processes representatives' names, email, contact details, organization type, cookies/session data; "may produce aggregated statistics about the client application and users." Controller/processor split per GDPR DPA (§7.1–7.4). IP/request-parameter retention: not verified. |
| Data quality | Wallet token balances incl. spam indicators, decoded wallet history, internal transactions endpoint (EVM), Streams for real-time events incl. address monitoring, NFT endpoints with spam detection on supported chains. Pagination: cursor-based; max addresses per call varies by endpoint (batch endpoints exist). Exact per-endpoint numbers partially verified. |
| Self-hostable | No (SaaS). |

**qntx verdict:** Broadest nominal 10-chain claim incl. HyperEVM and Bitcoin, but third-party-use clause is a blocker to resolve contractually, and free tier is absent.

## 4. Covalent / GoldRush — <https://goldrush.dev>

| Field | Evidence |
|---|---|
| Chain coverage | "100+ chains"; qntx: all 8 EVM incl. **HyperEVM** (`hyperevm-mainnet`, chain ID 999 — 22 foundational APIs: balances, transfers, transactions, classification, logs, JSON-RPC), **Bitcoin and Solana** supported (Solana page: indexed SPL balances via REST; fuller Solana product exists). Per-capability parity on Bitcoin/Solana/HyperEVM partially verified. Source: <https://goldrush.dev/docs/networks>, <https://goldrush.dev/docs/chains/hyperevm>, <https://goldrush.dev/docs/chains/solana> (read 2026-11-18). |
| Pricing | Free trial: 25,000 credits total, 4 RPS, 14 days. Vibe Coding **$10/mo: 10,000 credits, 4 RPS**. Professional **$250/mo: 300,000 credits, 50 RPS** + autoscaling flex credits. Inner Circle custom. Credits are tiny units: token balances 1 credit/call; multichain balances 2.5; address activity 0.5; recent txns 0.1/item; token approvals 2; historical portfolio 2/30d; HyperEVM txn classification 0.05/item. Source: <https://goldrush.dev/pricing> (read 2026-11-18). |
| Rate limits | 4 RPS (trial/Vibe), 50 RPS (Pro), custom (Inner Circle). |
| ToS / licence | Current ToS URL: <https://www.covalenthq.com/terms/> (old `/legal/terms-of-use/` is 404). Consumer-wallet/caching/resale clauses **not verified** — extraction pending. |
| Privacy | Privacy policy (effective 2024-09-01): may collect "wallet address, behavioral browsing information, technical information, device information, geolocation, unique identifiers, and IP address"; public blockchain data "is not considered personal information". Subprocessors: GCP, ClickHouse, OVHCloud, Snowflake, Stripe. Source: <https://www.covalenthq.com/privacy-policy/> (read 2026-11-18). |
| Data quality | Foundational APIs: token balances w/ spam flags, decoded transaction history (classified), transfers incl. incoming, logs; pagination via page keys; batch/multi-chain endpoints. Internal-trace coverage per chain varies; HyperEVM trace parity not verified. |
| Self-hostable | No (hosted API). |

## 5. Helius — <https://www.helius.dev> (Solana-only)

| Field | Evidence |
|---|---|
| Chain coverage | **Solana only.** Covers 1/10 networks — Solana mainnet RPC, DAS (NFTs incl. compressed), enhanced/parsed transactions, webhooks, LaserStream streaming. Source: <https://www.helius.dev/pricing>, <https://www.helius.dev/docs/llms.txt> (read 2026-11-18). |
| Pricing | Free **$0: 1M credits/mo, 10 RPS**, DAS 2 RPS, archival data, webhooks incl. Developer **$49: 10M, 50 RPS, DAS 10/s**. Business **$499: 100M, 200 RPS, DAS 50/s**. Professional **$999: 200M, 500 RPS, DAS 100/s**. Dedicated nodes from $2,900/mo; LaserStream add-ons from $400/mo. Overage $5/million credits (Dev+). Source: <https://www.helius.dev/pricing> (read 2026-11-18). |
| Endpoint costs | Standard RPC 1 credit; **all DAS endpoints 10 credits**; Parsed Events (enhanced-txn successor) 10 credits/req (+1/history page on scan); webhook events 1 credit each, webhook management 100 credits/op; LaserStream WSS 2 credits/0.1 MB; Wallet API balances 100 credits. Source: <https://www.helius.dev/docs/billing/credits.md> (read 2026-11-18). |
| Rate limits | Per tier above; DAS RPS is separate (2/10/50/100). |
| ToS / licence | Not verified. Consumer-wallet use is its core market (powers Phantom, Backpack, Crossmint per site claims). |
| Privacy | Not verified. |
| Data quality | DAS is the canonical cNFT/Metaplex/SPL metadata API; enhanced txns parse 100+ txn types; `getTransactionsForAddress` paginated history w/ tokenAccount filters; webhooks up to **100,000 addresses** (<https://www.helius.dev/docs/faqs/webhooks.md>); webhook retries may duplicate events. |
| Self-hostable | No. |

## 6. SimpleHash — **defunct**

Acquired by Phantom (announced 2025-02-26); **public API shut down 2025-03-27**; site now 404s, docs behind password. Sources: <https://phantom.com/learn/blog/phantom-acquires-simplehash> ("We've acquired SimpleHash… real-time prices, accurate historical data and instant on-chain updates… Enhanced spam protection"), <https://www.alchemy.com/api/md/blog/migrating-nft-data-from-simplehash-to-alchemy> ("SimpleHash is sunsetting its services on March 27, 2025") (read 2026-11-18). **Do not evaluate further.** Successors by migration docs: Alchemy (NFTs), Zerion / GoldRush / Mobula (token data).

## 7. CoinGecko API — <https://www.coingecko.com/en/api>

| Field | Evidence |
|---|---|
| Chain coverage | Price/market data only (capability B). "360+ blockchain networks" incl. GeckoTerminal/onchain DEX data. Per-chain token-price coverage incl. HyperEVM: not verified per-chain, but contract-address endpoints support many networks; Solana supported via GeckoTerminal. Bitcoin: native BTC price ✓. |
| Pricing | Paid only beyond trial/demo: Basic **$35/mo: 100k call credits, 300/min**, 2y history; Analyst **$129/mo: 500k, 500/min**, 13y history; Lite **$499/mo: 2M, 500/min**; Pro **$999/mo: 5M, 1,000/min**; Enterprise custom incl. "Commercial redistribution license", 99.9% SLA. Source: <https://www.coingecko.com/en/api/pricing> (read 2026-11-18). |
| Rate limits | 300 / 500 / 500 / 1,000 calls-per-minute by tier. |
| ToS / licence | API ToS (v. 2025-09-05): §6 "Data Caching and Storage — We do not encourage caching or storage of Data. However, if you must cache or store Data: 1. You should refresh the cache at least every 24 hours; 2. Strong encryption and other security measures should be applied to stored Data…" §4.4 attribution: must display "**Powered by CoinGecko**" legibly, font ≥10. Redistribution beyond your product requires the Enterprise "Commercial redistribution license". Source: <https://www.coingecko.com/en/api_terms> (read 2026-11-18). |
| Privacy | Privacy policy linked from ToS; IP/request logging specifics not verified. |
| Data quality | Token price by contract, market chart ranges, 24h change, OHLC; onchain DEX data via GeckoTerminal endpoints on paid tiers. |
| Self-hostable | No. |

## 8. DefiLlama — <https://defillama.com> / coins.llama.fi

| Field | Evidence |
|---|---|
| Chain coverage | Capability B (prices) only. `coins.llama.fi` prices keyed by chain:contract; **live probes confirm** Ethereum, Base and HyperEVM (`hyperliquid` key) token prices resolve (see probes). Chain keys derived from their chain list — HyperEVM key = `hyperliquid`. |
| Pricing | Two APIs: **Free API** (`api.llama.fi`, no key, "Standard" rate limit) and **Pro API** (`pro-api.llama.fi/{KEY}`, higher limits, 38 exclusive + 31 free endpoints; single plan unlocks all). Pro price: **not verified** (pro.defillama.com checkout only). Coins API (prices/charts) is free/keyless. Source: <https://api-docs.defillama.com/llms.txt> (read 2026-11-18). |
| Rate limits | "Standard" vs "Higher" — exact numbers not published in docs (not verified). |
| ToS / licence | DefiLlama describes itself as "free, open-source DeFi analytics" (<https://api-docs.defillama.com/llms.txt>). Formal API ToS/caching clause: not verified. Frontend/aggregators open source; per-adapter licences vary (mostly MIT/GPL family — exact licence not verified here). |
| Privacy | Not verified (no dedicated API privacy page found). |
| Data quality | Current prices, historical charts (`/chart/{chain}:{addr}`), percentage change endpoint, block-timestamped prices; probe confirmed 30 daily points for ETH via `/chart/coingecko:ethereum`. |
| Self-hostable | Adapters/indexer are open source (github.com/DefiLlama); self-hosting the coins backend is possible in principle — licence per repo not verified. |

**Probe evidence (all keyless, 2026-11-18):** USDC resolved on `ethereum:0xA0b8…eB48`, `base:0x8335…2913`, `hyperliquid:0xb883…630f` (≈0.9998 USD each); WHYPE `hyperliquid:0x5555…5555` ≈ 68.10 USD; 30-day ETH chart OK. Files: `probes/defillama_usdc_eth.txt`, `defillama_usdc_base.txt`, `defillama_usdc_hyperevm.txt`, `defillama_whype_hyperevm.txt`, `defillama_eth_chart_30d.txt`, `defillama_protocols_chainlist_head.txt`.

## 9. Blockaid — <https://blockaid.io>

| Field | Evidence |
|---|---|
| Chain coverage | Capability G (risk/spam) + tx-simulation-adjacent security. Docs confirm HyperEVM + HyperCore indexed "since 2025" — "full Chain Support to protect developers, traders, and asset managers across the HyperEVM ecosystem"; Solana supported ("Real-time scanning of transactions, tokens, dApps, and addresses"); broad EVM coverage (exact chain list page is JS-rendered; qntx EVM chains individually not verified, though Blockaid powers MetaMask across its chains). Bitcoin: not verified. Sources: <https://blockaid.io/blog/blockaid-expands-protection-to-the-hyperliquid-ecosystem>, <https://blockaid.io/blog/blockaid-expands-onchain-monitoring-support-for-solana> (read 2026-11-18). |
| Pricing | Not published / not verified (sales-led). |
| Rate limits | Not verified. |
| ToS / licence | Not verified. Consumer-wallet use is its core business (MetaMask, Coinbase Wallet, Rabby integrations). |
| Privacy | Not verified. |
| Data quality | dApp/address/token risk verdicts, drainer/phishing detection, token spam/impersonator flags, tx simulation for security; "full token scanning to detect spam tokens, impersonators, and scams". |
| Self-hostable | No. |

## 10. mempool.space — <https://mempool.space> (Bitcoin only)

| Field | Evidence |
|---|---|
| Chain coverage | **Bitcoin only** (+ Liquid, not relevant). Address stats, address tx history, fee estimates, tx broadcast. Probes: `GET /api/address/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh` → funded 1,201 / spent 434 / total 1,158; `/txs` OK; `/api/v1/fees/recommended` → {fastest 4, halfHour 3, hour 3, economy 2, minimum 1} sat/vB. Files: `probes/mempool_address.txt`, `mempool_address_txs.txt`, `mempool_fees.txt` (2026-11-18). |
| Pricing | Public API free; rate-limited. "If you exceed these limits, you will get an HTTP 429 error. If you repeatedly exceed the limits, you may be banned… Consider an enterprise sponsorship if you need higher API limits." **Limits are not disclosed** — maintainer: "Our API limits aren't disclosed, basically because if you have to ask then you will hit them" (github.com/mempool/mempool discussion #752). Enterprise tiers at mempool.space/enterprise. Sources: <https://mempool.space/docs/api/rest>, GitHub discussion (read 2026-11-18). |
| Rate limits | Undisclosed; 429 + ban risk. **Not suitable for a consumer-wallet backend without Enterprise sponsorship or self-hosting.** |
| ToS / licence | ToS (updated 2024-07-10): "AS IS, AS AVAILABLE… NO WARRANTY… WE MAKE NO GUARANTEE TO THE ACCURACY OF ANY DATA"; no explicit redistribution/caching clause found. Source: <https://mempool.space/terms-of-service> (read 2026-11-18). |
| Privacy | Not verified. |
| Data quality | Full tx history per address (paginated), mempool data, fee estimates; esplora-compatible API. |
| Self-hostable | **Yes — open source** (github.com/mempool-space/mempool.space, Docker images, one-click installs on Umbrel/RaspiBlitz/StartOS/nix-bitcoin; requires an Electrum backend — electrs/Fulcrum; support for manual deployments reserved for enterprise sponsors). Repo licence: mempool project is AGPL-3.0-family — exact licence field not re-verified on 2026-11-18. Source: <https://mempool.space/docs/faq> self-hosting section (read 2026-11-18). |

## 11. Blockstream Esplora / Enterprise — <https://github.com/Blockstream/esplora>

| Field | Evidence |
|---|---|
| Chain coverage | **Bitcoin + Liquid only.** Esplora is the open-source API engine behind blockstream.info (and the mempool.space fork lineage). Address, tx, fee-estimate, broadcast endpoints — same API shape mempool.space exposes. |
| Pricing | blockstream.info public API free w/ undisclosed limits; Blockstream Enterprise offers hosted Esplora SLA — pricing not verified. |
| Rate limits | Public instance: not disclosed (not verified). |
| ToS / licence | **Open source, MIT licence** (Blockstream/esplora repo). No redistribution restrictions for self-hosting. |
| Privacy | Self-hosted: none. Hosted instance privacy policy: not verified. |
| Data quality | Address/tx history incl. incoming; no address-index gap issues when self-hosted with full txindex/electrs. |
| Self-hostable | **Yes — MIT.** Canonical self-host choice for Bitcoin reads. |

## 12. Blockscout — <https://www.blockscout.com> (open-source explorer)

| Field | Evidence |
|---|---|
| Chain coverage | Per-chain hosted instances, quality varies. Chain directory (<https://chains.blockscout.com/>) lists official instances for Ethereum (`eth.blockscout.com`), Polygon (`polygon.blockscout.com`), Base (`base.blockscout.com`), Arbitrum (`arbitrum.blockscout.com`), OP (`explorer.optimism.io`, redirect works), and a HyperEVM entry (`www.hyperscan.com`, "hosted by self") — **but live probing showed hyperscan.com redirects to `hl.eco` and exposes no working Blockscout API; other HyperEVM explorer candidates returned SSL errors/404s. HyperEVM Blockscout API: not usable / not verified.** BNB/Avalanche official instances exist but unprobed; Solana/Bitcoin N/A. |
| Pricing | Public instances free (rate-limited; Cloudflare in front — several probed instances returned "Just a moment…" challenge pages to curl). Managed/hosted offerings sales-led. |
| Rate limits | Per-instance; undisclosed; Cloudflare-challenged. Probes: ETH `/transactions` OK, `/token-balances` OK after a 524, `/internal-transactions` timed out (>60 s); Base/Arbitrum/Polygon Cloudflare-challenged; OP OK via redirect. Files: `probes/blockscout_*.txt`. |
| ToS / licence | **Open source (self-hostable)**; repo licence: GPLv3 for the elixir backend (blockscout/blockscout) — verify per-component licence before embedding; hosted data ToS not verified. |
| Privacy | Self-hosted: none. Hosted instances: not verified. |
| Data quality | Rich API v2: token balances, decoded txns, **internal transactions**, logs, tokens; pagination cursors. Strong data model, but public instances are SLO-free. |
| Self-hostable | **Yes — GPL-family, Docker images.** Viable as qntx-owned EVM indexer (incl. a self-hosted HyperEVM instance). |

## 13. Etherscan API v2 — <https://docs.etherscan.io>

| Field | Evidence |
|---|---|
| Chain coverage | One key across 50+ chains. Keyless `/v2/chainlist` probe: **free-tier available** for Ethereum(1), Polygon(137), Arbitrum(42161), **HyperEVM(999)**; **paid plan required** for Base(8453), BSC(56), OP(10), Avalanche(43114). Solana/Bitcoin N/A. File: `probes/etherscan_v2_supported_chains.txt`. |
| Pricing | Tiers: Free → Lite → Standard → Advanced → Professional → Pro Plus → Dedicated. Paid prices on etherscan.io/api/pricing (not extracted — partially verified). |
| Rate limits | Free **3 calls/s, 100k/day, selected chains only, no PRO endpoints**; Lite 5/s 100k/day; Standard 10/s 200k/day; Advanced 20/s 500k/day; Professional 30/s 1M/day; Pro Plus 30/s 1.5M/day. Overage (paid only, opt-in): **$0.00003/call = $3 per 100k calls**; effective 2026-11-03 free tier is hard-capped at daily limit. Source: <https://docs.etherscan.io/rate-limits.md> (read 2026-11-18). |
| ToS / licence | Etherscan API ToS historically restricts redistribution and requires attribution — current clause not verified. |
| Privacy | Not verified. |
| Data quality | Account/token/contract/logs endpoints incl. `account tokentx` (ERC-20 transfers incl. incoming) and `account txlistinternal` (**internal txns**) — per-chain availability varies by module; `internal` on HyperEVM free tier not verified. Multi-address balance endpoints exist (up to 20 addr on some modules). |
| Self-hostable | No. |

## 14. Sim by Dune — **sunsetting** — <https://sim.dune.com>

Dune announced 2026-05-17: "**Dune is sunsetting sim.dune.com on August 1, 2026. As of May 18, 2026, new signups are disabled.**" Migration partners named: **Zerion, Codex and Mobula**. Source: <https://dune.com/blog> "Sunsetting Sim" (read 2026-11-18). **Excluded as a candidate.**

## 15. Codex — <https://docs.codex.io>

| Field | Evidence |
|---|---|
| Chain coverage | GraphQL API for token prices/trades/liquidity/holders/wallet analytics, "100+ EVM and non-EVM networks". Networks index lists: aptos, arbitrum, arc, avalanche, base, bsc, ethereum, linea, megaeth, monad, optimism, plasma, polygon, robinhood, solana, starknet, sui, tempo, unichain. qntx: **ETH, Base, Arb, OP, Polygon, BSC, Avalanche, Solana ✓; HyperEVM NOT in the docs networks index** (only a marketing image mentions it — mark not verified); **Bitcoin absent**. Source: <https://docs.codex.io/llms-full.txt> networks index (read 2026-11-18). |
| Pricing | "Almost free": **10,000 CU / rolling 30 d, 5 req/s**; Growth from ~1M requests/mo tiers, **300 req/s**; Enterprise custom. CU metering w/ auto-scale overage. Sources: <https://docs.codex.io/concepts/rate-limits.md>, codex.io/pricing (read 2026-11-18). |
| Rate limits | 5 rps free / 300 rps Growth. Per-request limits: `getBars` max 1,500 datapoints; `getTokenPrices` batched inputs (max enforced — see docs). |
| ToS / licence | Not verified. |
| Privacy | Not verified. |
| Data quality | Strong on token prices, OHLCV, trades, holders, wallet analytics; not a balances/history/NFT gateway. |
| Self-hostable | No. |

## 16. GoPlus Security — <https://gopluslabs.io>

| Field | Evidence |
|---|---|
| Chain coverage | Capability G. Live keyless `supported_chains` probe: **Ethereum(1), BSC(56), Arbitrum(42161), Polygon(137), Base(8453), Optimism(10), Avalanche(43114), Solana ✓; HyperEVM absent (no id 999/hyperliquid); Bitcoin absent** (45 chains total, incl. Tron). Probed 2026-11-18 — `GET https://api.gopluslabs.io/api/v1/supported_chains` → HTTP 200 JSON (output above). |
| Pricing | Public free API w/ registration for higher tiers; exact pricing page numbers not verified. |
| Rate limits | Free-tier rate limits documented per endpoint class (not fully extracted — partially verified). |
| ToS / licence | Not verified. |
| Privacy | Not verified. |
| Data quality | Token security (honeypot/tax/ownership flags), address maliciousness, approval security, NFT security, dApp security — good complement for capability G on 8/10 chains. |
| Self-hostable | No. |

## 17. Additional candidates — status

| Provider | Status on 2026-11-18 |
|---|---|
| **Ankr Advanced API** | Multi-chain balances/NFTs/txns API; chain list + pricing not extracted — **not verified**. Likely no HyperEVM, no Bitcoin-normalized data. |
| **QuickNode Streams / Token & NFT API** | Streams + Token API exist; HyperEVM support is per-chain-add-on — **not verified** for our chains. |
| **Birdeye** | Price/token API strong on Solana + major EVM; HyperEVM support **not verified**; no Bitcoin. |
| **Jupiter price API** | Solana-only token prices; Jupiter deprecated `price.jup.ag` v1 in favor of Lite API (`lite-api.jup.ag`) — current endpoint/pricing **not verified**. |
| **Hiro** | Bitcoin/Stacks indexer APIs (ordinals/BRC-20/Runes + BTC via Stacks-linked endpoints); plain-BTC wallet balances **not verified**; open-source components (MIT). |
| **Tenderly** | Best-in-class EVM simulation (capability F) + node; HyperEVM chain support **not verified**; pricing sales-led for API tiers — not verified. |
| **Mobula** | Named as Sim migration partner by Dune — multi-chain wallet/portfolio API; **not evaluated** in depth this round. |

---

## Capability × provider matrix

Legend: number of qntx's 10 networks covered (verified); `partial`/`n.v.` notes follow.

| Capability | Alchemy | Zerion | Moralis | GoldRush | Helius | CoinGecko | DefiLlama | Blockaid | mempool.space | Blockstream Esplora | Blockscout | Etherscan v2 | Codex | GoPlus |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** Balances/discovery | 7–8 EVM + SOL RPC; **no HyperEVM in Portfolio enums, no BTC** | **9/10** (8 EVM incl. HyperEVM + SOL; BTC ✗) | ~10/10 claim (BTC via Universal API — depth n.v.) | ~10/10 claim (per-capability parity n.v.) | SOL only | — | — | — | BTC only | BTC only | EVM instances, incl. HyperEVM instance unusable | EVM only; free on ETH/Polygon/Arb/HyperEVM | — | — |
| **B** Prices | Prices API EVM+SOL | ✓ via fungibles charts (per supported chain) | ✓ token prices | ✓ historical portfolio | SOL token prices | ~360 networks (per-chain depth n.v.) | ✓ probes: ETH/Base/HyperEVM + BTC/SOL coingecko ids | — | — | — | — | — | 8/10 (HyperEVM n.v., BTC ✗) | — |
| **C** Tx history + incoming + internal | Transfers API: 17 EVM (no HyperEVM/AVAX); internal only on ETH/Base/Polygon+ | 9/10 decoded; internal-transfer parity n.v.; BTC ✗ | EVM + SOL ✓; BTC basic | broad; internal per-chain n.v. | SOL enhanced | — | — | — | BTC ✓ | BTC ✓ | EVM ✓ incl. internal endpoint (reliability issues probed) | EVM ✓ `txlistinternal`/`tokentx` | — | — |
| **D** NFTs + spam + cNFT | EVM 721/1155 + SOL DAS | EVM ✓ (HyperEVM ✗); SOL NFTs 🔜; spam filter ✓ | EVM + SOL; BTC ✗ | EVM; SOL n.v. | SOL DAS incl. cNFT (canonical) | — | — | spam flags via risk API | — | — | EVM metadata | EVM basic | — | — |
| **E** Webhooks/streams | EVM + SOL; HyperEVM not listed | ✓ subscriptions EVM + SOL (HyperEVM chain-level: tokens/txns ✓ so webhook coverage n.v.) | Streams: EVM + SOL + BTC; HyperEVM row present | — (poll-based; address-activity endpoint) | SOL webhooks 100k addr | — | — | — | — | self-host electrs/notifications DIY | — | — | WS price subs | — |
| **F** Simulation | `alchemy_simulate*` EVM; HyperEVM n.v. | — | EVM sim n.v. | — | — | — | — | security-sim ✓ | — | — | — | — | — | — |
| **G** Risk/spam scoring | NFT spam fields | token spam trust filter ✓ | spam indicators | spam flags | — | — | — | **specialist**: 8 EVM + HyperEVM + SOL (full list n.v.) | — | — | — | labels | — | 8/10 (HyperEVM+BTC ✗) |

**No single provider covers all 10 networks for any capability.** Closest:
- A/C/D/E: **Zerion (9/10, missing Bitcoin)** or GoldRush/Moralis (claim 10/10 but BTC is balance-only and per-capability parity unverified).
- F: Alchemy (EVM) or Tenderly (EVM, HyperEVM n.v.); Bitcoin/Solana simulation N/A generally.
- Bitcoin reads: **self-hosted Esplora/mempool** or mempool.space Enterprise.

## Not-verified list (explicit gaps)

1. Alchemy: per-product HyperEVM support beyond Node RPC; whether Portfolio/NFT/simulation reach chain 999.
2. Alchemy ToS: whether consumer-wallet serving requires negotiated End-User terms (clause §2.2(v) suggests yes — legal review needed).
3. Zerion: API ToS clauses (caching/redistribution), privacy policy contents, max addresses per webhook subscription, internal-transfer inclusion in decoded history, webhook coverage on HyperEVM.
4. Moralis: exact per-endpoint HyperEVM parity (esp. NFTs/internal txns), Streams HyperEVM event types, IP/request-param retention wording, precise scope of §1.1 third-party clause vs. end-user serving.
5. GoldRush: ToS redistribution/caching clauses, per-capability parity on Bitcoin/Solana/HyperEVM, Pro overage pricing mechanics.
6. Helius: ToS and privacy policy text.
7. CoinGecko: privacy policy specifics; whether HyperEVM contract prices resolve (GeckoTerminal coverage by network).
8. DefiLlama: exact free-tier rate limits, Pro plan price, formal ToS/licence for commercial caching.
9. Blockaid: published chain list, pricing, ToS, privacy.
10. mempool.space: exact rate-limit numbers (deliberately undisclosed), privacy policy.
11. Blockstream Enterprise: Esplora SLA pricing/terms.
12. Blockscout: per-component licence confirmation (backend GPL-3.0 assumed — verify), BNB/Avalanche official instance status, ToS for hosted data.
13. Etherscan: current API ToS clause text, paid-tier prices, HyperEVM module-level availability (e.g. `txlistinternal`) on free tier.
14. Codex: ToS/privacy; whether HyperEVM is enabled per-key despite absence from docs networks index.
15. GoPlus: pricing page numbers, ToS, privacy.
16. Ankr, QuickNode Streams, Birdeye, Jupiter Lite API, Hiro, Tenderly, Mobula: full seven-field evaluation not completed — only status notes above.
17. Solana probe caveat: public `api.mainnet-beta.solana.com` rate-limits aggressively (429 observed); success is real but public RPC is not a production dependency.

## Probe log summary (keyless, 2026-11-18)

| Probe | Result | File |
|---|---|---|
| DefiLlama USDC price ETH/Base/HyperEVM + WHYPE + ETH 30d chart | All resolve; HyperEVM key = `hyperliquid` | `probes/defillama_*.txt` |
| mempool.space address/txs/fees | 200 OK; rate limit undocumented | `probes/mempool_*.txt` |
| Solana `getTokenAccountsByOwner` (Tokenkeg, jsonParsed) | 200 OK after one 429; 2,837 accounts / 2,817 mints; duplicates per mint confirmed (USDC×14, USDT×8) | `probes/solana_getTokenAccountsByOwner.txt` |
| Blockscout ETH/Base/Arb/Polygon/OP/HyperEVM | ETH works (internal-tx endpoint timed out once); OP works via `explorer.optimism.io`; Base/Arb/Polygon Cloudflare-challenged; **no usable HyperEVM Blockscout** | `probes/blockscout_*.txt` |
| Etherscan v2 `/v2/chainlist` | Free tier: ETH, Polygon, Arb, HyperEVM; paid: Base, BSC, OP, AVAX | `probes/etherscan_v2_supported_chains.txt` |
| GoPlus `supported_chains` (live) | All qntx EVM except HyperEVM; SOL yes; BTC no | (inline output, this doc) |
