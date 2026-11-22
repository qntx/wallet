# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A `vX.Y.Z` tag runs `publish-npm.yml` (publishing `packages/wallet`, `packages/wallet-worker`, `packages/wallet-engine`, `packages/wallet-chains` and `packages/wallet-native` via npm trusted publishing / OIDC). `@qntx/wallet-kernel` is private and only bundled into the host packages.

## [Unreleased]

Hardening release: the vault structure is authenticated, the kernel signs what it can describe and
refuses what it cannot show unless the owner allows blind signing, broadcasts whose outcome is
unknown are never failed, and the cloud-backup password is stretched with Argon2id. React Native
gains a silent `device` factor and an optional app lock. The engine adds fiat prices, per-group
activity history, Bitcoin coin control and Spark tokens.

Upgrading is not data-preserving. Vaults written by 0.13.0 (format 3) are `unsupported` and must
be reset, 0.13.0 cloud-backup files can no longer be read, and the engine database is rebuilt
empty. Wallets come back only from their mnemonic, a passkey, or a cloud backup made after the
upgrade. [MIGRATION.md](MIGRATION.md) lists every change a host has to make.

### Added

- `@qntx/wallet`: React Native `device` factor (`FactorInfo` / `UnlockFactor` kind `device`): a
  device-bound keystore key without user presence (iOS Secure Enclave
  `WhenUnlockedThisDeviceOnly` + `.privateKeyUsage`; Android Keystore AES-256-GCM,
  `setUnlockedDeviceRequired` from API 35). It unlocks without UI and no verification accepts it.
  The keystore contract (`sealDevice`, `openDevice`, `probe`, `remove` alongside the presence
  `seal` / `open`) is implemented natively on iOS and Android.
- `@qntx/wallet`: `VerifyFactor` (`UnlockFactor` without `device`), the type of every `verify`
  parameter, and `NativeAutoLockPolicy`.
- `@qntx/wallet`: `WalletSnapshot` / `StatusPayload` gain `appLock` (no `device` factor: every
  unlock verifies), `verification` (`"available" | "unavailable"`: whether a factor that proves
  user presence exists) and `blindSigning`. The Web reports `appLock: true`.
- `@qntx/wallet`: `wallet.vault.enrolVerification()` registers the `hardware` factor once the
  device has a lock screen (Android prompts once) and replaces a `hardware` factor the keystore
  reports dead. `wallet.vault.setAppLock(enabled, verify)`: `true` removes the device keystore key
  first (failing `unavailable` and changing nothing when the keystore cannot remove it), then drops
  the `device` factor and rotates the DEK, so other sessions lock `invalidated`; `false` restores
  the factor.
- `@qntx/wallet`: `wallet.vault.setBlindSigning(enabled, verify)` — blind signing is a vault
  setting enforced in the kernel, off on a new vault and not part of a cloud backup. While it is
  off, a request the chain decoder marks blind fails with `blind-signing-disabled` before any
  verification prompt.
- `@qntx/wallet`: error codes `verification-unavailable` (a guarded call on React Native without a
  `hardware` factor, or a reset without a lock screen; no prompt is shown) and
  `blind-signing-disabled`.
- `@qntx/wallet/host`: `MAX_IN_FLIGHT` (32), the bound on posted-but-unanswered kernel requests.
  `@qntx/wallet/protocol`: the `verifier` validator.
- `@qntx/wallet-native`: `createNativeWallet` returns `NativeWallet`, whose
  `setAutoLock({ platform: "native", backgroundSeconds })` applies to the live kernel at once;
  `KernelHostLike.setBackgroundLock(seconds)`.
- The kernel prompt shows what is signed: the network, native amounts and fees in units, token
  amounts outside the reviewed table as unverified base units, a sanitised excerpt of a message; a
  Sign-In with Ethereum/Solana message's domain, account, network and URI; typed data's app name,
  network, verifying contract and primary type, plus a Seaport order (token ids, criteria items,
  a non-zero zone) or a Safe transaction's calls. A transaction the kernel cannot verify still
  lists the contract it calls or deploys, its function selector, native value and fee cap, and
  carries a "cannot verify" line. A Bitcoin fee the kernel cannot prove is shown as "Fee unknown";
  an outflow to an unspendable output as "Burn X BTC". Blind-signing prompts name their reason.
- `@qntx/wallet-chains`: new `./networks` entry point — the single built-in network table
  (`BUILT_IN_NETWORKS`, `NetworkMeta`, `networkMeta`, `withNativeAmountMeta`).
- `@qntx/wallet-chains`: `displayExcerpt` / `isUnsafeCodePoint` (bounded, sanitised display text),
  `messageContent`, `messageBlindReason`, `isBlindIntent`, `BlindReason`, `TypedDataLeaf`,
  `DisplayExcerpt`, `SignInClaim`; `DisplayIntent` gains `blind`, `contract` (with `selector`,
  `symbol`) and `programs` (Solana); typed-data `MessageContent` gains `fields`; `AssetFlow.burn`
  marks an outflow to a provably unspendable Bitcoin output (a script starting with `OP_RETURN` or
  over 10,000 bytes).
- `@qntx/wallet-chains/evm`: `typedDataFields`, `TYPED_FIELD_BUDGET`, `TYPED_FIELD_CODE_POINTS`.
- `@qntx/wallet-chains/bitcoin`: `bip322ToSign(scriptPubKey, message)`, `samePsbtContent` and
  `verifyLegacyBitcoinMessage`.
- `@qntx/wallet-chains/solana`: `decodeSolanaTransaction(wire, signer)` reads a serialized
  transaction for one required signer and returns the message it signs plus the signers that have
  not signed yet; `addSolanaSignature(wire, signer, signature)` writes the signer's slot and leaves
  every other byte unchanged; `mayBeTransactionMessage(bytes)`; `SolanaTransactionForSigner`. Built
  on `@solana/transactions` 8.5.0.
- `@qntx/wallet-engine`: `requiredAcknowledgement(request)`, `ApproveOptions`,
  `RequestAcknowledgement` and the request error classes `AcknowledgementRequiredError`,
  `SimulationChangedError`, `BlindSigningDisabledError`, `SignInOriginError`, `InvalidTokenError`,
  `RequestEndedError` and `OriginBusyError`, exported from the package root.
- `@qntx/wallet-engine`: `backupPasswordStrength(password)` (zxcvbn, loaded on first use);
  `BackupController.enable` refuses a password below zxcvbn's top score with category
  `weak-password` before any kernel call.
- `@qntx/wallet-engine`: `engine.prices` (`PricesController`) — spot quotes from the gateway for
  every held asset (EVM and Solana natives, built-in and added tokens, Bitcoin, Spark sats as BTC),
  fetched when a new asset appears and every `PRICES_POLL_MS` (60 s) while `setVisible(true)`;
  `setCurrency` (`FIAT_CURRENCIES`); single-flight; per-asset `unpriced` errors and a request-level
  `failure`; persisted with the currency in the engine store and cleared on lock. Display-only: a
  lint rule keeps `src/prices` out of every build and sign path.
- `@qntx/wallet-engine`: `engine.portfolio.group(group)` — exact fiat valuation (bigint
  fixed-point) of the balances already in state and the group's total, with per-holding
  staleness (`PRICE_STALE_MS`, 10 min by the provider's `updatedAt`).
- `@qntx/wallet-engine`: `engine.history` (`HistoryController`) — one newest-first activity list
  per account group, including what the wallet received: Bitcoin from Esplora over all four
  account templates, Solana from `getSignaturesForAddress` + `getTransaction` over the owner and
  its token accounts, Spark from the operators' transfer history, EVM from the gateway history
  route. `load(group)` / `loadMore(group)`; entries carry direction, counterparties, per-asset
  changes, fee, status, time, block and `verified`; locally tracked sends fold into the chain
  entry with the same hash. A gateway EVM entry is `verified` only after its receipt and
  transaction, read over RPC, match every transfer (`chain-mismatch` otherwise); entries are
  flagged `zero-value-transfer`, `lookalike-counterparty`, `token-impersonation` and
  `suspicious-token-symbol`. History counterparties never enter the address book or the
  known-recipient set. The newest 200 entries per group are cached; lock clears the state.
- `@qntx/wallet-engine`: `AssetsController.refreshBitcoinGroup({ walletId, groupIndex }, network)`
  — one Bitcoin balance over the group's bip44, bip49, bip84 and bip86 accounts, with per-template
  totals (`AccountBalances.sources`) and the UTXO list (`AccountBalances.utxos`, each marked
  `protected`; protected outputs are totalled in `AccountBalances.protected`).
  `TokenBalance.frozen`: Solana amounts in frozen token accounts.
- `@qntx/wallet-engine`: Bitcoin coin control — `engine.transactions.setUtxosFrozen(account,
  network, outpoints, frozen)` / `frozenUtxos(account, network)` persist per-account freezes;
  `inputs` on a `send` request spends exactly the named outpoints (`txid:vout`), and naming a
  protected outpoint opts into spending it. Automatic selection, speed-up extras and CPFP skip
  frozen outpoints, and a dApp PSBT signing a frozen input raises the `bitcoin-frozen-input`
  danger.
- `@qntx/wallet-engine`: Spark tokens — `SparkAccountState.tokens` balances; `pay` with
  `token: { identifier, amount }` to a Spark address, results `token` / `token-pending`;
  `engine.spark.quoteExit` (the converged cooperative-exit quote); token sends are only `pay`
  requests.
- `@qntx/wallet-engine/connect`: dApps can read event logs. `eth_getLogs` is passed through,
  bounded to one block by hash, a numbered range of at most 500 blocks, or two block tags that are
  equal or both name the head (`latest`, `pending`), with at most 20 addresses and 20
  alternatives per topic; an unbounded filter fails with `-32005`. Filter and subscription methods
  stay unsupported (viem and ethers fall back to polling `eth_getLogs`).
  `wallet_addEthereumChain` / `wallet_switchEthereumChain` now say that the network must be
  enabled in the wallet.
- `@qntx/wallet-engine/gateway/contract`: `prices` (`priceAssetId`, `nativeAssetId`,
  `tokenAssetId`, `fiatPrice`, `percentChange`, `FIAT_CURRENCIES`); `history`
  (`POST /v1/history/:caip2`, `historyRequest` / `historyResponse`, `historyPath`);
  `RPC_BROADCAST_METHODS`, `containsBroadcast` and the `outcome-unknown` error;
  an explicit params schema for every allow-listed EVM and Solana method; `jsonRpcRequestId`; the
  `eth_getLogs` bounds (`LOGS_*`, `logsFilterViolation`); Esplora `/scripthash/:h/txs/chain/:txid`.
- `@qntx/gateway`: production environment (eight EVM mainnets and Solana through Alchemy then
  dRPC, Bitcoin through Blockstream Enterprise), keyed upstream auth in headers, `scripts/smoke.ts`.
- `@qntx/gateway`: `POST /v1/prices` — spot price and 24 h change for up to 100 CAIP-19 assets in
  one fiat currency (`usd`, `eur`, `gbp`, `jpy`, `cny`, `krw`, `hkd`, `sgd`, `cad`, `aud`, `chf`);
  CoinGecko Pro primary (`COINGECKO_API_KEY`), DefiLlama fallback;
  answers cached per asset and currency for 30 s, converted to bounded decimal strings without
  float arithmetic, `no-store`.
- `@qntx/gateway`: `POST /v1/history/:caip2` — EVM transfers of an address over Alchemy
  `alchemy_getAssetTransfers` (existing `ALCHEMY_API_KEY`, breaker id `alchemy-transfers`),
  newest first, block-frontier pagination; `503 unavailable` where no Alchemy provider is
  configured.
- `@qntx/gateway`: JSON log lines for failed upstream attempts (`upstream-failure`), breaker
  transitions, `all-providers-failed` and `internal-error`; no params, bodies, addresses, client
  ids or IPs are logged.
- Fixed vectors for Solana serialized transactions (`vectors/chains/solana-wire.json`) and for
  signing classes (`vectors/chains/signing-classes.json`: class, blind reason and exact kernel
  prompt text in both locales); provenance recorded for every vector file.
- `GET /v1/tokens/:caip2` on the gateway: per-network token lists built hourly from the Uniswap Labs
  Default list (EVM mainnets), CoinGecko Pro token lists (HyperEVM, when `COINGECKO_API_KEY` is set)
  and Jupiter's verified tokens (Solana), with a strong ETag and `if-none-match` → 304. Lists are
  bounded (EVM 1500, Solana 5000 entries), versioned monotonically, and never republished when a
  source fails, shrinks by more than half or exceeds the cap. Contract: `tokenList`,
  `tokenListResponse`, `tokenListPath`, `TOKEN_LIST_MAX_ENTRIES`, `TOKEN_LIST_SOURCES`.
- Token discovery in `AssetsController`: listed ERC-20s with a non-zero balance appear automatically
  (read in the existing Multicall3 batches, re-scanned every 10 minutes), and every SPL mint the
  account holds appears, with its symbol from Token-2022 metadata or Metaplex. No address is sent
  to a data provider.
- `TokenBalance.spam` (spam reasons: `impersonation`, `suspicious-symbol`, `link-in-name`,
  `permanent-delegate`, `non-transferable`), `TokenBalance.hidden` and `TokenBalance.name`.
- `AssetsController.setTokenHidden(network, address, hidden)`: persists the user's hide/unhide
  verdict; spam-flagged tokens are hidden by default.
- `@qntx/wallet-chains`: blind reasons `typed-data-commitment` (typed data whose every leaf is a
  hash or opaque bytes, e.g. ERC-1271 wrappers such as `SafeMessage(bytes)` or
  `CoinbaseSmartWalletMessage(bytes32)`), `typed-data-variant` (typed data a decoded family claims —
  `Permit*`, `SafeTx`, `OrderComponents`/`BulkOrder` primary types, or a Permit2, Seaport or
  built-in-token verifying contract — in a shape the decoder does not recognise) and
  `core-instruction` (an undecoded System, Token, Token-2022, Stake or Associated Token instruction
  the signer signs). The recognised families and their near-miss reason are one table,
  `RECOGNISED_FAMILIES`.
- `@qntx/wallet-chains`: `isHexRendering(text)` and `isReadableText(text)` exports; `SEAPORT_ORDER_ITEMS`
  from `@qntx/wallet-chains/evm` (the most offer or consideration items a prompt shows).
- `@qntx/wallet-chains`: Solana System `CreateAccount` / `CreateAccountWithSeed` for any owner
  program (an outflow of the new account's lamports when the signer funds it),
  `AdvanceNonceAccount`, and Token / Token-2022 `InitializeAccount` and `Revoke` are decoded
  (`full`).
- Kernel prompts (en, zh-Hans): "It signs only hashes or raw bytes; the wallet cannot see what they
  commit to" and "The wallet recognises this kind of signature but not this form of it; it may
  authorise moving assets".
- `vectors/chains/signing-classes.json`: five cases for the new blind classes (20 in total).
- `@qntx/wallet-engine`: WebLN rejects with code `-32010` (JSON-RPC implementation-defined server
  error; `PAYMENT_PENDING_CODE` in `connect/errors.ts`) when a committed payment may have been
  made — its commit answer was lost, the preimage poll ran out of budget, a status read failed, or
  the payment settled without a preimage. Pages must not retry on `-32010`; `-32603 "payment
  failed"` stays reserved for terminal failures.
- `@qntx/wallet-engine/gateway/contract`: `HISTORY_CURSOR_MAX` (the largest history cursor the
  gateway forwards) and `RPC_ELEMENTS_PER_UNIT` (array elements one RPC rate-limit unit pays for).
- `@qntx/wallet-engine`: the package root exports every type a host names in the engine's
  signatures: `AccountRef`, `TrackedTransaction`, `TxState`, `TransactionControllerState`,
  `PrepareParams`, `SendParams`, `ChainRequestInput`, `ChainRequestMethod`, `SparkDepositTag`,
  `EvmFeeTier`, `SolanaFeeTier`, `RequestResult`, the Solana / Bitcoin / Nostr sign inputs,
  results and displays, `BitcoinAccount`, `BitcoinGroup`, `BitcoinPsbtInput`, `BitcoinSigHash`,
  `SolanaAccount`, `SignInFields`, `TokenWatchDisplay`, `TokenWatchResult`, `WatchAssetInput`,
  `LightningInvoiceDisplay`, `WeblnInvoiceInput`, `WeblnInvoiceResult`, `ZapInput`,
  `SimulationOutcome`, `AssetChange`, `AssetsControllerState`, `SpamReason`, `SparkTokenBalance`
  (the element of `SparkAccountState.tokens`), `HistoryGroup`, `WatchAccount`,
  `PaymentErrorCategory`, `MetaSyncErrorCategory`, `AccountTreeErrorCategory`, `ParseOptions`,
  `ResolveOptions`, `DelegationStatus`, `DisplayIntent`, `EnsResolution`, `LidoPosition`,
  `LidoWithdrawalRequest`, `StakePosition`, `StakeValidator`, `SwapQuote`, `ZeroExSwapQuote`,
  `JupiterSwapQuote`, `JupiterInstruction`, `AcrossBridgeQuote`, `AcrossBridgeStatus`,
  `ConnectionRequest`, `SessionAccounts`, `NostrPolicy`, `LightningPolicy`,
  `NetworkControllerState`, `NetworkInfo`, `SolanaRpc`, `Esplora`, the provider handlers' request,
  event and account types (`Nip07Request`, `WeblnRequest`, `SolanaRequest`, `SolanaEvent`,
  `SolanaWalletAccount`, `BitcoinRequest`, `BitcoinEvent`, `BitcoinWalletAccount`, until now only
  in `/connect`), and the facade types `HostController` and `ReadonlyStore`.
- API reports: every published entry point's declarations, including the unexported types they
  reach, are recorded in `packages/<pkg>/api/<entry>.api.md` (API Extractor); `check:pkg` fails
  when the built declarations differ (`bun ../../scripts/check-api.ts . --update` regenerates
  them).
- `@qntx/wallet-engine`: every wallet-initiated Spark payment (Spark send and invoice, Lightning,
  cooperative exit, token send) is recorded before it is sent as a `SparkPaymentRecord`
  (`submitted` | `unknown` | `settled` | `failed`), persisted while open and reconciled against
  the Spark operator after unlock, after each event-stream catch-up and on a backed-off poll.
  Records are listed in `SparkAccountState.payments` and as local Spark entries in
  `engine.history` — token sends appear in history for the first time.

- `@qntx/wallet-engine`: `TrackedTransaction.block` (`TxBlock`) records the block a `confirmed` or
  on-chain `failed` transaction is in (hash + block number on EVM, hash + height on Bitcoin, slot on
  Solana); `TrackedTransaction.final` marks it past the network's finality rule — the EVM `finalized`
  tag, six Bitcoin confirmations, the Solana `finalized` commitment.
- `@qntx/wallet-engine`: `GroupHistory.truncated` lists the networks whose history provider left
  out transfers it could not list in full; the activity list has gaps there.
- `@qntx/wallet-engine/gateway/contract`: the Esplora allow-list accepts `GET /blocks/tip/height`.

- 23 built-in EVM mainnets: Robinhood Chain, Monad, Arc, Plasma, X Layer, Pharos, Mantle, Cronos, Gnosis, Stable, Katana, Berachain, World Chain, Unichain, Sei, Linea, Celo, Sonic, ZKsync Era, Soneium, MegaETH, Kaia and ApeChain, plus 14 testnets (Robinhood Chain Testnet, Monad Testnet, Arc Testnet, X Layer Testnet, Mantle Sepolia, Gnosis Chiado, Unichain Sepolia, Sei Testnet, Linea Sepolia, Celo Sepolia, Sonic Testnet, ZKsync Sepolia, Soneium Minato, ApeChain Curtis). Each chain id is checked against the chain's documentation and live endpoints; signing chain ids still come only from the built-in table.
- EIP-7702 delegation on Robinhood Chain, Monad, Plasma, Mantle, Gnosis, Linea and Celo (delegator deployed and 7702 transactions observed on-chain).
- Built-in USDC (Circle) on Monad, Plasma, X Layer, Pharos, Cronos, World Chain, Unichain, Sei, Linea, Celo, Sonic and ZKsync Era, and USDT (Tether) on Celo and Kaia.
- Gateway: production routes (Alchemy + dRPC) for the new mainnets; staging routes for every built-in EVM testnet; prices, Uniswap token lists and Alchemy transfer history where the providers serve the network. Networks without a history provider answer `503 unavailable` without calling upstream; Celo's CELO token-duality contract is excluded from token lists.

- `@qntx/wallet-chains`: TRON as the fourth chain family. `@qntx/wallet-chains/tron` adds the three TRON networks (`tron:728126428`, `tron:2494104990` Shasta, `tron:3448148188` Nile — decimal CAIP-2 references), base58check address helpers, a strict `Transaction.raw` protobuf codec, pure `raw_data` builders (`buildTronRawData`, `trc20TransferContract`, `trc20ApproveContract`), `decodeTron` and signature recovery/verification; `@qntx/wallet-chains/tron/sign` signs `sha256(raw_data)` and signMessageV2 messages.
- TRON decoding describes TRX and TRC-10 transfers, TRC-20 calls (through the same token-standard decoder as EVM), Stake 2.0 (freeze, unfreeze, delegate, undelegate, withdraw, cancel), votes and reward claims. `AccountPermissionUpdateContract` is decoded in full but always blind (`tron-permission-update`) and its prompt leads with an account-takeover warning naming every new key; other contract types are blind (`tron-contract`) and fields the wallet cannot show are blind (`tron-field`). A contract whose `owner_address` is not the signing account is refused.
- Built-in TRC-20 table: USDT, USDD, TUSD, WTRX, JST, SUN, BTT, WIN and NFT on mainnet, USDT on Nile.
- `@qntx/wallet`: the `tron.bip44` template (`m/44'/195'/0'/0/{group}`), `chain.sign` requests `tron.transaction { rawData }` and `tron.message { message }`, and imported TRON private keys (`keys.import("tron", <64-hex without 0x>)`). Every TRON signature the kernel returns is verified against the account address.
- Vectors: `vectors/chains/tron.json` (tronweb 6.5.2, Trust Wallet and TronLink core literals) and `vectors/chains/tron-mainnet.json` (140 mainnet transactions from TronGrid).

- `@qntx/wallet-chains`: Hyperliquid user-signed actions (`HyperliquidSignTransaction` domain) are
  decoded and described — `usdSend`, `spotSend`, `withdraw3`, `usdClassTransfer`, `sendAsset`,
  `cDeposit`, `cWithdraw`, `tokenDelegate`, `approveAgent` (name and `valid_until` shown) and
  `approveBuilderFee` — as `MessageContent.hyperliquid`. Every other shape under that domain is
  blind `typed-data-variant`; a main-account Hyperliquid L1 phantom-agent document (`Exchange` /
  `Agent`) is always blind `typed-data-commitment`.
- `@qntx/wallet-chains`: Polymarket CLOB orders on the CTF, Neg Risk CTF and ExchangeV3 exchanges
  (Polygon; Amoy for the CTF exchanges), including deposit-wallet ERC-7739 `TypedDataSign` orders,
  `ClobAuth` credential requests and `DepositWallet` `Batch` call batches are decoded as
  `MessageContent.polymarket`. Orders are `partial`: the trading fee is set at match time and is
  not capped on-chain. Near misses under the three domains are blind `typed-data-variant`.
- Kernel prompts for every described Hyperliquid and Polymarket shape in English and Simplified
  Chinese.
- `@qntx/wallet/protocol`: `sessions.create`, `sessions.list`, `sessions.delete` and
  `sessions.sign`. Types: `SessionInfo`, `SessionSchemes`, `SessionSchemeId`, `HyperliquidL1Action`,
  `HyperliquidL1Order`, `HyperliquidL1Params` and `HyperliquidNetwork`.
- Kernel: generic session keys. Each is a secp256k1 key generated in the enclave for one HD
  account and sealed as a `session-key` vault record. A session key is never exported or backed
  up, is deleted with its wallet, and belongs to a scheme from a compile-time table. A record whose
  scheme this build does not know is listed as unsupported. It cannot sign and can still be
  deleted, and it never makes the vault `unsupported`.
- Kernel: the `hyperliquid-l1-agent` session scheme. It signs only the allow-listed L1 trading
  actions (`order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `scheduleCancel`,
  `updateLeverage`, `updateIsolatedMargin`, `twapOrder`, `twapCancel`). The kernel re-encodes each
  action and computes the connectionId itself. It signs only while the vault is unlocked and before
  the session's `validUntil`. Each signature needs a nonce within 60 seconds of the kernel clock and
  an `expiresAfter` at most 60 seconds ahead. Hyperliquid rejects an action after its
  `expiresAfter`, so a signature can be submitted at most a minute after it was made, including
  after a lock. A `scheduleCancel` time must be at least 5 seconds out and within the session's
  validity.
- Kernel: when `chain.sign` signs an `approveAgent`, it reports whether this wallet holds the agent
  as a `hyperliquid-l1-agent` session key. It refuses an approval whose terms differ from the held
  session's.
- Vault: `VaultHooks.parseHeader` lets each module check the public headers of its own records, so
  status no longer imports module parsers.
- Vectors: `vectors/chains/hyperliquid.json` (from `@nktkas/hyperliquid` 0.33.3, asserting the
  nktkas and Python SDK published signatures) and `vectors/chains/polymarket.json` (from
  `@polymarket/clob-client-v2` 1.2.1, checked against each exchange's on-chain `hashOrder`); new
  cases in `signing-classes.json`, `records.json` and `vault-manifest.json`.
- `@qntx/wallet-engine/gateway/contract`: error codes `"too-costly"` (413 — one request costs more
  than a client's whole share window; split it) and `"unsupported"` (404 — the gateway will never
  serve this resource for this network or asset; do not retry), appended to `GATEWAY_ERRORS`.
- `@qntx/wallet-engine/gateway/contract`: `pricesResponse.unsupported` — every requested asset is in
  exactly one of `prices`, `missing` (no price now) and `unsupported` (no price coverage).
- `@qntx/wallet-engine/gateway/contract`: parameter bounds `RPC_PROOF_KEYS_MAX` (100 `eth_getProof`
  storage keys), `RPC_SIMULATE_BLOCKS_MAX` / `RPC_SIMULATE_CALLS_MAX` (16 / 100 for
  `eth_simulateV1`), `FEE_HISTORY_BLOCKS_MAX` / `FEE_HISTORY_PERCENTILES_MAX` (1024 / 100); requests
  over them are `400 invalid-request` before any upstream call.
- `@qntx/wallet-engine`: `GroupHistory.unsupported` — the networks the gateway has no history for.
- gateway: every upstream call is priced in its provider's published unit (Alchemy throughput CU,
  dRPC CU, one credit per call elsewhere; `src/budget/costs.ts`) and charged first to the client's
  share of that provider account (`SHARE_LIMITER`: one IP prefix gets at most 5 % of an account's
  per-minute budget), then to a gateway-wide per-account budget held in the `PROVIDER_BUDGET`
  Durable Object (`src/config/accounts.ts`). An exhausted budget fails over, then answers
  `503 unavailable` with the earliest `Retry-After`, before the provider throttles.
- `scripts/check-bundles.ts` (part of `bun run lint`): bundles every published entry point and
  checks the modules it actually loads against the package boundaries.
- `scripts/check-migration.ts`: compares the last release's API reports (from the registry) with
  `api/` and fails when a removed export is missing from MIGRATION.md §13; run before a release.
- Built-in EVM mainnets Ink, Fraxtal, Ronin, Scroll, BOB, opBNB, Arbitrum Nova, Taiko, Flare and Zora, and testnets Ink Sepolia, Fraxtal Hoodi, opBNB Testnet and Zora Sepolia. Each chain id is checked against the chain's documentation (or the OP superchain registry) and live endpoints; signing chain ids still come only from the built-in table.
- Scroll fee model: the L1 data fee is read from the L1GasPriceOracle on the transaction serialized under a maximal signature and shown with the model's safety margin.
- `GasPricing` (`"eip1559" | "legacy"`) on every EVM fee model: chains with no base fee or whose primary upstream lacks `eth_feeHistory` (opBNB, Fraxtal) build legacy transactions at `eth_gasPrice`.
- EIP-7702 delegation on Ink.
- Built-in Circle USDC on Ink.
- Native-alias tokens (Celo CELO, Arc USDC, Stable USDT0 and their testnets) are in the built-in token table with `role: "native-alias"`: `transfer`/`approve` on them are described like any listed token, they are never counted as a second balance and token discovery never offers them.
- Wrapped native tokens (`role: "wrapped-native"`) for 24 built-in networks; `deposit()` and `withdraw(uint256)` on them are decoded and described (native in, wrapped out and back).
- Gateway: Alchemy + dRPC production routes for Ink, Fraxtal, Ronin, Scroll, BOB, opBNB and Zora; an Ankr upstream (`ANKR_API_KEY`, sent in the `x-api-key` header) as the second provider for networks Alchemy does not serve (Arbitrum Nova, Taiko, Flare); production and staging routes, prices, token lists and transfer history for the new networks where the providers serve them.
- `@qntx/wallet-engine`: TRON (`tron:728126428`, Nile `tron:3448148188`; Shasta stays in the
  table, unserved by the gateway). `EngineFamily` gains `"tron"`; `TRON_NETWORKS` in
  `./gateway/contract`; host `rpc`
  entries for a TRON network are full-node HTTP base URLs (`/wallet/*`, `/walletsolidity/*`).
- `@qntx/wallet-engine`: TRX, TRC-10 and TRC-20 sends through the existing `send` request. The
  transaction is built locally from the latest **solidified** block (`expiration` = now + 60 s);
  no node-built transaction is ever signed; the reference block id and the fee-relevant chain
  parameters must agree on the independent host endpoint or the send is refused; the kernel's
  signature is verified before broadcast. `PendingRequest.tronFee` (`TronFeeQuote`): expected and
  maximum fee, bandwidth (bytes, staked/free/burn, activation), energy (estimate incl. dynamic
  penalty, available, burn, `fee_limit`) and warnings (`recipient-not-activated`,
  `token-recipient-empty`). TRC-20 `fee_limit` = `min(⌈estimate × 1.5⌉, getMaxFeeLimit)`. A send
  the TRX balance cannot cover is refused before approval. Risk findings `contract-recipient`,
  `token-contract-recipient` and `token-recipient-empty`.
- `@qntx/wallet-engine`: request methods `tron-stake` (Stake 2.0 freeze, unfreeze,
  withdraw-expired, cancel-unfreeze, delegate (optional lock), undelegate, vote, claim rewards —
  each pre-checked against the java-tron actuator rules) and `tron-approve` (TRC-20 allowance;
  `amount: 0n` revokes). `AccountPermissionUpdate` is not offered.
- `@qntx/wallet-engine`: TRON tracking — broadcast refusals classified from `Return.response_code`
  (`DUP_TRANSACTION_ERROR` is held; busy/connection/unknown codes stay `submitted`); signed bytes
  rebroadcast while unexpired; `dropped` only once a solidified block's timestamp is past
  `expiration` and neither node knows the id; included ⇒ `confirmed`, solidified ⇒ `final`; an
  on-chain failure (`OUT_OF_ENERGY`, `REVERT`, …) is `failed` with the reason and the burned fee in
  `error`; a reorg before solidification returns it to `submitted`.
- `@qntx/wallet-engine`: TRON balances — liquid TRX, built-in TRC-20s (`balanceOf`, no Multicall),
  custom TRC-20s, TRC-10s from `assetV2` (unverified), indexer-discovered TRC-20s (display-only,
  unverified, spam-flagged); `AccountBalances.tron` (`TronAccountView`): frozen, unfreezing,
  delegated in/out, votes, claimable reward, bandwidth/energy/TRON-power limits and usage.
- `@qntx/wallet-engine`: TRON history from the gateway indexer (TRX, TRC-10 and TRC-20 in/out),
  `verified` only after the node confirms the transaction bytes (TRX/TRC-10) or every Transfer log
  touching the account (TRC-20); zero-value, look-alike and impersonation flags.
- `@qntx/wallet-engine`: TRON account discovery, watch-only TRON addresses, TRON address-book
  entries, imported TRON keys on the send path.
- `@qntx/wallet-engine/gateway/contract`: the TRON route contract (`tronBasePath`, the allow-listed
  node and indexer paths with request/response schemas, `TRON_BROADCAST_PATH`);
  prices for TRX (`slip44:195`) and TRC-20 (`tron:<ref>/trc20:<base58>`).
- `@qntx/gateway`: `POST /v1/tron/:caip2/*` — allow-listed TRON full-node HTTP API (TronGrid then
  Tatum on mainnet, TronGrid then NileEx on Nile) with schema-checked answers and broadcast
  no-double-relay; TronGrid `/v1/accounts` indexer for history and discovery. New production
  secrets `TRONGRID_API_KEY`, `TATUM_API_KEY`. CoinGecko/DefiLlama price rows for TRX and TRC-20.
- `@qntx/wallet/sessions`: `sessions(wallet)` exposes the kernel-held session keys (`create`,
  `list`, `delete`, `sign`) the way `spark(wallet)` and `nostr(wallet)` expose their protocols.
  `create` and `sign` are typed per scheme.
- `@qntx/wallet-engine/apps`: a separate entry (hosts that do not import it bundle nothing new).
  `createApps({ wallet, requests, networks, fetch, socket, now, setTimer, random, logger, openStore,
  gateway, apps: [hyperliquid({ network, agentName, builder? })] })` returns an `AppsController` and
  the `HyperliquidProvider` as `apps.hyperliquid`:
  - `AppsController`: per account group and app state (`disabled`, `enabling`, `enabled`,
    `needs-reauthorization`, `unavailable`), terms acknowledgement, gateway eligibility, and a
    resumable enable flow (kernel agent → `ApproveAgent` request → optional `ApproveBuilderFee`
    request → verification on Hyperliquid); renew and disable (with optional deregistration on
    Hyperliquid). Agents created but never approved are deleted.
  - `HyperliquidProvider`: market and account reads, live views (order book, trades, candles,
    account, spot balances, open orders, fills) with reconnect, resubscribe and stale marking,
    order placement (limit, market with a computed slippage cap, stop/take-profit, attached and
    position TP/SL, reduce-only, post-only, TWAP), modify, cancel, cancel-all, scheduled cancel,
    leverage, isolated margin, close position, perp↔spot transfers, `usdSend`, `spotSend`,
    `withdraw3`, and USDC deposits from Arbitrum through Hyperliquid's bridge.
  - L1 actions are signed by the account's own kernel-held agent without a per-order prompt;
    user-signed actions go through the request pipeline as kernel-described typed data. A lost
    order POST is reconciled by client order id and never re-sent.
- `@qntx/wallet-engine`: `AppOrigin` (`{ kind: "app", id }`) joins `RequestOrigin`, and
  `RequestController.prepare(input, app?)` attributes a request to an in-engine app. `createApps`
  stamps every request each listed app opens with that app's own id — Hyperliquid (user-signed
  actions, the CCTP deposit's approve and burn) with `{ kind: "app", id: "hyperliquid" }` and
  Polymarket (the enable flow's credential and approvals requests, orders, pUSD deposit and
  withdraw) with `{ kind: "app", id: "polymarket" }`. A provider cannot choose its origin. The
  pending request and the sign log carry that origin, so a host can show which app asked.
  Otherwise the pipeline treats these requests as internal: typed data only for
  `evm-sign`/`tron-sign`, no phishing check, no per-origin queue.
- Repository: `scripts/check-kernel-budget.ts`, run by `bun run lint`, measures the application
  share of the native kernel bundle by ablation. Current values: 1.92 % against a 5 % budget,
  plus per-unit budgets for each protocol-family decoder and session scheme. `AGENTS.md` records
  the kernel growth rule.
- Gateway `GET /v1/eligibility`: per-app availability (`available`, `close-only`, `blocked`),
  computed from the request's country and region against sourced restricted-jurisdiction lists.
  The answer's `apps` is a map keyed by app id, and the gateway's configuration decides which apps
  appear (today Hyperliquid and Polymarket). A client treats an absent app as unknown. Display
  only — not a security boundary. Contract: `eligibility` in `@qntx/wallet-engine/gateway/contract`.
- `@qntx/wallet-chains`: Solana swap decoders for Raydium AMM v4, Raydium CPMM, Raydium CLMM
  `swap_v2` and Orca Whirlpool `swap_v2`. A swap whose layout bounds the signer's worst case is
  described as a swap: at most `maxIn` leaves the source account and at least `minOut` reaches the
  destination (named as the signer when it is the signer's own token account). AMM v4 names no
  mint, so its amounts are shown in base units of the token accounts unless an account is the
  signer's account of a built-in-table token. `DisplayIntent.minimumReceived[]` gains
  `tokenAccount`. Any other instruction of these programs keeps the program-authority rule.
- `@qntx/wallet-chains`: the Hyperliquid CCTP deposit — `TokenMessengerV2.depositForBurnWithHook`
  on Arbitrum One / Arbitrum Sepolia to HyperEVM (domain 19) through Circle's `CctpForwarder` with a
  forward hook naming the signer — is described ("deposit N USDC to your Hyperliquid perps/spot
  account; Circle fee at most F") via `DisplayIntent.hyperliquidDeposit`. Every other call to those
  messengers is blind with the new `BlindReason` `cctp-destination`.
- `@qntx/wallet-engine`: `engine.spark.archivePayment(account, id)` archives an open Spark token
  payment that can never be reconciled (its spent outputs were never reported). The record keeps
  its history entry (status `pending`, new `HistoryFlag` `unresolved`), stops being reconciled and
  stops blocking new sends. Call it only after the user confirmed.
- `@qntx/wallet-engine`: Spark `SparkErrorCategory` `duplicate` — a new payment with the same kind,
  receiver, amount (and token) as a payment whose outcome is still unknown is refused, carrying the
  earlier record. Retrying the same request (same transfer id) is unaffected.
- `@qntx/wallet-engine/apps`: the Hyperliquid builder fee is optional. Declining
  `ApproveBuilderFee` finishes enabling with `builder: "declined"` (orders carry no builder); the
  decline persists across unlock, renew and re-enable until `controller.approveBuilder(group,
  "hyperliquid")` obtains an approval.
- `@qntx/wallet-chains`: TIP-712 typed data — `SignRequest` `tron.typed-data { typedData }` (canonical JSON: `types` incl. `EIP712Domain`, `primaryType`, `domain`, `message`). `parseTronTypedData` / `tronTypedDataDigest` hash exactly like TronWeb 6.5.2 `_signTypedData` (address leaves drop the `0x41` prefix, `trcToken` is an atomic uint256, `domain.chainId` is the network's decimal CAIP-2 reference); `tronTypedDataFromArgs(domain, types, message)` turns TronWeb's argument form into that JSON; `@qntx/wallet-chains/tron/sign` `signTronTypedData`; `recoverTronTypedDataSigner` / `verifyTronTypedDataSignature`. `decodeTron` describes EIP-2612 permits and the SUN.io Permit2 deployment on mainnet (`TRON_PERMIT2`, PermitSingle/Batch/TransferFrom/WitnessTransferFrom) with base58 addresses; an unrecognised document lists its leaves or is blind (`typed-data-variant` for `Permit*`/Permit2/listed-token claims, `typed-data-oversize`, `typed-data-commitment`).
- `@qntx/wallet-chains`: `tronRawDataFromJson(rawData, visible)` re-encodes a dApp's `raw_data` JSON under TronWeb `txCheck` semantics (strict: unknown keys, non-canonical forms and `AccountPermissionUpdateContract` refuse); `tronMemoBytes` / `TRON_MEMO_MAX_BYTES` (256 UTF-8 bytes, one line, no hidden characters — always shown in full by the kernel prompt).
- `@qntx/wallet`: `chain.sign` request `tron.typed-data`; the kernel signs it and verifies the signature against the account.
- `@qntx/wallet-engine`: TRON in-app-browser provider. The injected script adds `window.tron` (TIP-1193 `request`/`on`/`removeListener`, TIP-6963 announcement under the host's own `ProviderInfo` — never TronLink's name or rdns, no `isTronLink`), and `window.tronLink` / `window.tronWeb` as the same minimal object: `ready`, `defaultAddress`, `trx.sign`, `trx.signMessageV2`, `trx._signTypedData`/`signTypedData`, `trx.sendRawTransaction`, `trx.getBlockByNumber(0)`, no-op node setters, `addressChanged`. Everything else on TronWeb's surface rejects with 4200 (`trx.sign(hex)` digest signing, `trx.signMessage`, `trx.multiSign` included). Methods: `eth_requestAccounts`, legacy `tron_requestAccounts` (`{code}` result), `wallet_switchEthereumChain` between enabled TRON networks, `wallet_watchAsset` (TRC-20). The official `@tronweb3/tronwallet-adapter-tronlink` finds the wallet through `window.tronLink`.
- `@qntx/wallet-engine`: request method `tron-sign` (dApp transaction, TIP-191 message, TIP-712 typed data). A dApp transaction is signed only as the exact `raw_data_hex` bytes after `sha256 == txID`, `raw_data` JSON re-encoding byte-equal, owner = the session account, a modeled contract type, `Permission_id` 0, `now + 20 s ≤ expiration ≤ now + 24 h` and a TaPoS reference block still on the chain; it gets the TRON fee quote (energy from `triggerconstantcontract`, the dApp's own `fee_limit` as the cap, `fee-limit-below-estimate` when it will run out of energy) and a TRC-20 balance-change simulation. After signing it is tracked by txid without the wallet broadcasting it (`TrackedTransaction.tron.dappSignature`); `trx.sendRawTransaction` of a transaction this wallet signed goes through the persisted, unknown-outcome-safe broadcast (`TransactionController.submitDappTron`), any other is refused.
- `@qntx/wallet-engine`: TRON `send` accepts `memo` (written to `raw_data.data`); the quote adds the live `getMemoFee` (`TronFeeQuote.memo`). `vectors/chains/tron-fees.json` gains 25 mainnet memo transfers bounding it.
- `@qntx/wallet-engine`: `watch-asset` accepts TRC-20 tokens (on-chain `symbol`/`decimals`, built-in-table impersonation check).
- `ConnectionController`: `tron` namespace (scopes for every enabled TRON network, `ConnectionSession.tronNetwork`, `setTronNetwork`); the engine facade exposes `tronWallet`.
- `@qntx/wallet-engine/walletconnect`: WalletConnect v2 wallet side on Reown WalletKit
  (`@reown/walletkit` 1.6.0, `@walletconnect/core`/`utils` 2.25.0, exact pins; WalletConnect
  Community License — commercial terms are a release gate). `createWalletConnect({ projectId,
  metadata, storage, wallet, engine, now, logger })` pairs `wc:` URIs, validates session proposals
  (`eip155`, `solana`, `bip122`; unsupported required namespaces/chains/methods/events are rejected
  with 5104/5100/5101/5102), approves them as ConnectionController sessions keyed
  `walletconnect:<topic>` and runs every `session_request` through the same EIP-1193, Solana and
  Bitcoin handlers and request pipeline as the in-app browser. Verify (`VALID`/`INVALID`/`UNKNOWN`,
  `isScam`) is merged with the phishing list; a mismatch or threat is a `danger` finding. Requests
  that arrive while locked queue until unlock or expiry; pending requests survive a restart; expired
  requests are answered `4100 Request expired`; group switches update the session and emit
  `accountsChanged`/`chainChanged`; revoking, a peer delete, a session expiry or deleting the wallet
  disconnects. One-click auth (`session_authenticate`, CAIP-222 + ReCaps) is approved as a SIWE
  message through the pipeline. Telemetry is off. Hosts that do not import the entry bundle none of it.
- `@qntx/wallet-engine`: `WalletConnectOrigin`, `WalletConnectVerify`, `DappOrigin`, `dappUrl`,
  `walletConnectKey`; `RequestOrigin`, `ConnectionOrigin` and every dApp request input accept a
  WalletConnect origin. Risk codes `verify-mismatch` and `verify-threat`.
- `@qntx/wallet-engine`: `connections.establishWalletConnect`, `connections.previewAccounts`, `connections.authorize`,
  `connections.touch` on the engine surface; `ConnectionState.ready`.
- `@qntx/wallet-engine`: the EIP-1193, Solana and Bitcoin handler requests take an optional
  `network` (CAIP-2); the in-app-browser bridge never sets it.
- `@qntx/wallet-engine`: `parsePayment` returns `{ kind: "walletconnect", uri }` for a `wc:` v2
  pairing URI.
- `@qntx/wallet-engine/apps/polymarket`: the Polymarket provider, `polymarket({ builder? })` —
  market discovery and order books (Gamma/CLOB/Data API v2), deposit-wallet location (both
  deposit-wallet generations and legacy Safes, from on-chain-verified derivations), account reads,
  quotes with directional rounding that never worsens the user's limit, limit (GTC/GTD, post-only)
  and market (FOK/FAK, shown worst-price bound) orders signed as kernel-described `TypedDataSign`
  approvals, unknown POST outcomes reconciled by order hash (never re-posted), cancels, a resumable
  enable flow (deploy → `ClobAuth` credentials → trading approvals batch → verify) and disable with
  server-side key revocation, live order books over the market WebSocket, live account views over
  the authenticated user WebSocket (order events applied in place, trade events re-read positions
  and trades; a 10 s REST poll while the socket is down), pUSD deposit and withdrawal to the owner.
  Relayer steps (deploy, approvals, withdraw) need the host's `builder.sign` hook; the builder
  secret never enters the app or the gateway. Opening positions (BUY) is refused under
  close-only/blocked/unknown eligibility and for accounts the CLOB marks `closed_only`.
- Polymarket CLOB L2 API credentials live in the apps store (the host's `openStore`, encrypted
  under the data key), one record per account group on Polygon; the engine computes the L2 HMAC
  itself. Credentials are never in controller state, events, logs or errors (L2 errors are scrubbed
  of them), are unavailable while the wallet is locked, are re-checked against the group's signer
  on every request, and are deleted on disable and when their wallet is deleted. A compromised main
  runtime can read them while the wallet is unlocked (cancel orders, read private CLOB data); it
  cannot place orders or move funds. The kernel gains no record kind or command for them.
- `@qntx/wallet-engine/apps/hyperliquid`: `hyperliquid({ network, agentName, builder? })` and every
  Hyperliquid export (moved from `@qntx/wallet-engine/apps`).
- `@qntx/wallet-engine/apps`: app definitions (`AppDefinition`, `AppInstance`, `AppContext`,
  `AppStorage`, `AppApis`) — each app gets its own encrypted per-group storage namespace
  (`apps.<id>`), pruned when a wallet is deleted.
- Vectors: `vectors/chains/polymarket-l2.json` (L2 headers, oracle clob-client-v2
  `createL2Headers`), `vectors/chains/polymarket-wallets.json` (deposit-wallet and Safe derivations
  checked against on-chain owners).
- `@qntx/wallet-chains`: Solana v1 transaction messages (SIMD-0385, live on mainnet, devnet and
  testnet) parse, classify and sign like legacy/v0. The parser reuses the pinned
  `@solana/kit` 8.5.0 codec and adds every Agave sanitize rule kit does not check: config mask
  limited to bits 0–4 with a complete priority-fee pair (an unknown bit is `unsupported`), 1–12
  signatures, readonly signers below the signer count, ≤ 64 distinct accounts covering the header,
  ≤ 64 instructions, program index in `[1, accounts)`, account indices in range, heap a multiple
  of 1024 in [32 KiB, 256 KiB], message plus signatures ≤ 4096 bytes, no trailing bytes.
  `ParsedSolanaMessage` gains `lifetimeToken` (every version) and, for v1, `config`
  (`SolanaTransactionConfig`: priority fee, compute-unit limit, loaded-accounts-data-size limit,
  heap size).
- `@qntx/wallet-chains`: a v1 transaction's maximum fee is `5000 × signatures + the config's
  priority fee` (lamports); ComputeBudget instructions in a v1 transaction configure nothing and
  no longer feed the fee. Resource limits are not shown — they bound neither funds nor fee.
- `@qntx/wallet-chains`: `decodeSolanaTransaction` / `addSolanaSignature` read and fill the v1
  message-first envelope (signatures after the message), up to 4096 bytes.
- `@qntx/wallet-engine`: the injected Wallet Standard provider advertises
  `supportedTransactionVersions: ["legacy", 0, 1]`; Wallet Standard and WalletConnect `solana_*`
  requests sign v1 transactions; `SolanaChainAdapter.finalize` lays out the wire with kit's
  transaction encoder, so simulation and broadcast of a v1 message send the message-first
  envelope; history reads `getTransaction` with `maxSupportedTransactionVersion: 1`.
- Vectors: `vectors/chains/solana-v1.json` (kit-built v1 cases with kernel prompts and WebCrypto
  signatures, plus one malformed case per sanitize rule), v1 cases in
  `vectors/chains/solana-wire.json`, and `vectors/chains/solana-mainnet-v1.json` — 65 landed
  mainnet v1 transactions re-fetched and signature-checked by `scripts/vectors/solana-mainnet-v1.ts`.
- **EIP-3009 authorizations are described.** `TransferWithAuthorization`, `ReceiveWithAuthorization` and `CancelAuthorization` signed to the token contract by the signer (x402 payments) show the amount, recipient, validity window and who can submit it — listed tokens `full`, others with the unverified-token amount; any other shape on these primary types is blind (`typed-data-variant`). New `MessageContent.authorization` (`TokenAuthorization`).
- **Account-authority signatures are described with danger wording.** Morpho Blue `Authorization`, Aave v3 credit delegation `DelegationWithSig` and Snapshot `Alias` decode into `MessageContent.authority` (`AccountAuthority`) with summary `authorization`; the Morpho Blue deployments and Aave variable-debt tokens of the built-in tables are probed on-chain (`vectors/chains/account-authority.json`), any other contract is named unverified.
- **Farcaster signer keys are described.** KeyGateway `Add` (owner = signer, ed25519 key, signed-key-request metadata) and `SignedKeyRequest` decode into `MessageContent.farcaster` (`FarcasterKey`).
- **0x gasless trades are described.** A Permit2 `PermitWitnessTransferFrom` whose `slippageAndActions` witness is spent by a 0x Settler MetaTxn deployment decodes as an `OffchainOrder` with `protocol: "0x"` — at most the permitted amount out, at least `minAmountOut` of the buy token to the recipient, enforced by the Settler's final slippage check.
- **UniswapX V3 reactors on Ink and Zora** (UniswapX README deployments, code and `permit2()` probed on-chain) are added to the reactor table; the Robinhood Chain and Arc addresses the README lists could not be confirmed on-chain and stay out.
- **Meteora DLMM `swap`/`swap2`** decode on Solana (legacy, v0 and v1 messages) with the signer's maximum input and minimum output; the legs' mints resolve through the signer's associated token accounts.
- `@qntx/wallet-engine`: `TrackedTransaction.stuck` and `TrackedTransaction.rebroadcast`.
- `@qntx/wallet-engine/apps/hyperliquid`: `HyperliquidTrade.corrections` and `HyperliquidOutcomeCorrection` —
  late answers for orders reported `unknown` (orderStatus re-asked for 10 minutes; live
  `openOrders` / `fills` sightings).
- `@qntx/wallet-engine/gateway/contract`: `PROVIDER_PIN_HEADER` (`x-gateway-provider`).
- `@qntx/gateway`: the TRON node route serves a request carrying `x-gateway-provider` from that
  provider only (unknown id → `400 invalid-request`), charged to the client share and the account
  budget exactly like the unpinned route; CORS allows the header.
- `@qntx/wallet-chains`: Fiat24 (SR Saphirstein AG) on Arbitrum One. USD24, EUR24, CHF24 and CNH24
  (2 decimals) are in the built-in token table, and the EVM decoder now reads Fiat24 calls
  straight from the calldata, without reading the chain:
  - `transferByAccountId` is a transfer to "Fiat24 account #id". The recipient is whoever holds
    that account when the transaction runs. Ids 9100–9299 are the issuer's internal accounts and
    raise `fiat24-internal-account`.
  - `clientPayout` / `clientPayoutRef` use the new `payout` summary. The amount and currency are
    shown, and so are the payee id, purpose and reference, each as requester text. The bank account
    that receives the money is chosen by Fiat24 off-chain, and `fiat24-payee-offchain` says so.
  - `moneyExchangeExactIn` / `moneyExchangeExactOut` are swaps with no minimum received. The issuer
    sets the rate (`fiat24-issuer-rate`). An exact-out swap can cost up to the whole allowance
    (`fiat24-exact-out-unbounded`).
  - `depositTokenViaUsdc`, `depositETH` and `depositTokenViaEth` are top-up swaps at the issuer's
    rate. When the input is swapped to USDC inside the transaction, `fiat24-swap-quote` is raised.
  - `mintByClient` / `mintByClientWithETH` open an account (`fiat24-account-link`). Moving the
    account NFT with `transferFrom` or `safeTransferFrom` raises the danger-level
    `fiat24-account-move`.
  - Approvals whose spender is the card or the deposit contract carry
    `ApprovalChange.fiat24Spender`. A card allowance raises `fiat24-card-pull`, and an unlimited
    allowance to either contract raises the danger-level `fiat24-unlimited-approval`.
  - Any other call to one of the seven pinned Fiat24 contracts is blind with `BlindReason`
    `"fiat24-function"`. The same applies to a Fiat24 function sent to another address or chain,
    trailing calldata, ETH sent to a non-payable function, and an FX or top-up whose output is not
    one of the four cash tokens.
- `@qntx/wallet-chains`: new types `Fiat24Action` and `Fiat24Token`, plus new optional fields
  `DisplayIntent.fiat24`, `AssetFlow.fiat24` (`{ account } | { payee }`), `IntentWarning.level`
  (`"danger"`) and `ApprovalChange.fiat24Spender`. `IntentSummary` gains `"payout"`.
  `IntentWarningKind` gains nine `fiat24-*` kinds. `./evm` exports `FIAT24_CHAIN` and
  `fiat24SessionMessage`.
- Fiat24 API session grants. A new sign request,
  `{ kind: "evm.fiat24-session", network: "eip155:42161", account, tokenId, deadline }`, works
  like this:
  - The kernel builds the `personal_sign` text itself:
    `"I agree to access my profile. " + keccak256(label ‖ deadline)`, where
    `label = fiat24-session-v1:<chainId>:<tokenId>:<deadline>`.
  - It refuses with `invalid-input` unless `0 < deadline − now ≤ 1200` s. It checks this when
    preparing and again when signing.
  - The prompt shows the account, the expiry and everything the grant allows.
  - The result is `{ kind: "evm.fiat24-session", signature }`, and `@qntx/wallet` checks the
    signer.
  - `@qntx/wallet/protocol` mirrors the new request and result kinds.
- Vectors: `vectors/chains/fiat24.json` (ABIs from Sourcify, calldata from viem cross-checked with
  `cast calldata`, session grants from `cast keccak` / `cast hash-message` / `cast wallet sign`,
  expected prompts written by hand) and `vectors/chains/fiat24-mainnet.json` (25 real Arbitrum One
  transactions).

### Changed

- **BREAKING:** vault format 5 and protocol version 3. A `manifest/default` record, rewritten in
  every structural commit, commits under the DEK to the format, the keyId and every other record
  and factor row; a replayed, dropped, added or altered row, or a rewritten format, latches the
  vault `corrupted`. Vaults of any other format, including every 0.13.0 vault (format 3), are
  `unsupported` and must be reset; there is no upgrade path. Vault images with duplicate keys are
  `corrupted`.
- **BREAKING:** the cloud-backup password is stretched with Argon2id (RFC 9106 second recommended
  option: 64 MiB, 3 passes, 4 lanes) instead of PBKDF2-SHA256 and must have at least 12
  characters. Backup envelope version 3 (its payload tag also authenticates the factor list, so a
  dropped, added, altered or reordered factor entry fails restore with `integrity`); version 1
  envelopes — every backup written by 0.13.0 — are not read, so backup has to be enabled again. The vault password factor is unchanged.
- **BREAKING:** an establishing `backup.restore` adopts the envelope's backup key only when a
  kernel passkey ceremony (React Native) unwrapped it. A restore unwrapped by a backup password or
  by a Web passkey ceremony brings the wallets back and leaves backup off until `backup.enable`
  writes a new key and cloud file. A compromised main runtime can no longer plant its own backup
  key through a restore of an empty envelope.
- **BREAKING:** `backup.disable(verify)` re-verifies before dropping the retained backup key.
- **BREAKING:** every `verify` parameter is `VerifyFactor`; `{ kind: "device" }` is rejected as
  `invalid-input` by the client, the wire validator and the kernel. On React Native a guarded call
  without a `hardware` factor fails `verification-unavailable` instead of `not-found`.
- **BREAKING:** React Native vaults are created with the `device` factor plus, when the device has
  a lock screen, the `hardware` factor; creation no longer needs a lock screen. `factor` on
  create / import / restore is `unsupported` on React Native, `InitialFactor` loses its `hardware`
  arm, and `vault.addFactor` / `vault.removeFactor` are `unsupported` there. `vault.unlock()`
  without a factor uses `device` (no prompt) unless `appLock` is on, then `hardware`.
- **BREAKING:** removing the lock screen no longer destroys a React Native vault while the `device`
  factor exists: the dead `hardware` factor is dropped and `verification` becomes
  `"unavailable"`. With app lock on, the vault is lost as before.
- **BREAKING:** `vault.reset()` of an open, healthy vault requires its live session; a locked or
  unhealthy vault still resets without one.
- **BREAKING:** `@qntx/wallet-native` admits one live kernel runtime per process: creating a
  second native wallet while another's kernel is live fails `integrity`. Destroy the first one
  first.
- **BREAKING:** signing classes. Requests the wallet can describe but not verify — an unknown
  contract call or creation, unrecognised EIP-712 that fits the display budget (up to 16 leaves as
  `path: value`), a Solana transaction with undecodable instructions, a PSBT with other signers'
  inputs — sign without the blind-signing setting. Only requests a decoder marks blind need it:
  raw-byte messages, typed data too large or misformed to show, an unrecognised function of a
  built-in token, calldata to the signing account itself, a Safe `delegatecall` outside a
  canonical MultiSendCallOnly batch, and a Safe transaction with a gas refund. Text, sign-in
  messages, permits, Seaport orders, Safe transactions of decoded calls and every recognised
  transaction are never blind. WETH `deposit`, Aave `supply`, Universal Router `execute`, CoW
  orders and similar everyday requests are no longer refused under the default policy.
- **BREAKING:** `@qntx/wallet-engine`: blind requests from dApps are no longer refused at
  `prepare`, and the EIP-1193 and Solana providers no longer answer `4200` for them. They become
  pending requests with the `blind-signing` danger; `approve` throws `BlindSigningDisabledError`
  while the vault setting is off and leaves the request approvable, so the host can enable the
  setting and approve again. `RequestController`'s `blindSigning` option is `() => boolean`.
  Described typed data and Solana requests with opaque instructions carry the `decode-partial`
  check.
- **BREAKING:** `@qntx/wallet-engine`: `requests.approve(id, method, options)` takes
  `{ verify, acknowledged }` instead of a positional `verify`, and refuses a request with `danger`
  findings or recorded checks unless `acknowledged` names exactly those codes, including findings
  a re-simulation adds at approval; otherwise it throws `AcknowledgementRequiredError` (carrying
  `required`) before anything is signed and the request stays approvable.
- **BREAKING:** `@qntx/wallet-engine`: a send, speed-up, cancel or CPFP whose broadcast outcome is
  unknown (transport error, 5xx, timeout) resolves with a `submitted` transaction tracked under its
  locally computed hash instead of rejecting; only a definitive node refusal rejects and marks it
  `failed`. The signed bytes move from `TrackedTransaction.evm.raw` to `TrackedTransaction.raw`
  for every family (EVM and Bitcoin hex, Solana base64 wire), persisted before the broadcast and
  cleared when the node refuses them. Bitcoin dApp `signAndSendTransaction` broadcasts are
  persisted, input-locked and tracked the same way, and the dApp receives the local txid.
- **BREAKING:** `@qntx/wallet-engine`: `RequestStage` gains `signed`, the point of no return
  between `signing` and `submitted`. `PreparedRequest.submit`, the request controller's
  `solanaSign` / `bitcoinSignPsbts` options and the Spark `send` / `payInvoice` /
  `paySparkInvoice` / `withdraw` params take a `commit` callback that runs immediately before
  anything is sent.
- **BREAKING:** `@qntx/wallet-engine`: `solana-sign` requests carry serialized transactions, as the
  Wallet Standard passes them, instead of compiled messages; `signedTransactions` are the dApp's
  transactions with the wallet's signature in its own slot, so co-signers' signatures and
  sponsored (dApp-paid) transactions survive. A sign-and-send still missing other signers'
  signatures is refused before the prompt.
- **BREAKING:** `@qntx/wallet-engine`: dApp sessions record the account group (and Nostr
  identity) they were granted, and providers resolve addresses and keys only through
  `connections.sessionAccounts()` / `nostrIdentity()`. `ConnectionController` follows the app's
  group selection itself (`onSelectedGroup`, `invalidateAll` options); switching group invalidates
  every pending request. WebLN takes `sparkNetwork` instead of `sparkAccount`.
- **BREAKING:** `@qntx/wallet-engine/connect`: the injected script generates the EIP-6963 uuid per
  document and tags every bridge message with it (`doc`); messages without one are dropped, and
  replies to a previous document are not delivered after a same-origin reload. The provider
  installs only in the top-level document, and `BrowserBridge.message` must receive the URL of the
  frame that sent the message (react-native-webview 13.13.5 or later).
- **BREAKING:** `@qntx/wallet-engine`: `EngineOptions.gateway` is `{ url }`. The engine sends a
  fresh random `x-client-id` per session and per scope (`evm`, `solana`, `bitcoin`, `service`)
  instead of one install id; the gateway contract's `INSTALL_ID_HEADER` / `installId` become
  `CLIENT_ID_HEADER` (`x-client-id`) / `clientId`. A gateway and an engine from different sides of
  this change refuse each other (`400 invalid-request`).
- **BREAKING:** `@qntx/wallet-engine/idb`: engine database format 2. Rows are named by an HMAC of
  their collection and key under HKDF subkeys of the data key; no collection name, key or value is
  readable on disk. An existing database, or one keyed by another data key, is rebuilt empty on
  open. `EngineCollection.get` resolves `undefined` for a row the store cannot authenticate, and
  `EngineErrorCode` loses `"integrity"`.
- **BREAKING:** `@qntx/wallet-engine`: Bitcoin UTXOs on taproot addresses or worth at most
  20,000 sat (ord's `MAX_POSTAGE`) are protected as possible inscription or rune carriers: sends do
  not select them unless named in `inputs`, the balance counts them in `protected`, and a dApp PSBT
  that signs one raises `bitcoin-inscription-input`.
- **BREAKING:** `@qntx/wallet-engine`: the persisted Bitcoin build record carries `template`,
  `groupIndex` and `tier`; speed-up, cancel and CPFP rebuild from it after a restart.
- **BREAKING:** `@qntx/wallet-engine`: a cooperative exit's `amountSats` (the `pay` Bitcoin option
  and `spark-exit`) is what arrives at the address; the exit debits `amountSats + feeSats`, the
  fee is quoted at prepare and refused above `maxFeeSats`, which Bitcoin options require.
  `SparkDisplay` is a union with a `token` variant and exit displays carry `feeSats`.
- **BREAKING:** `@qntx/wallet-engine`: Spark payments are idempotent per request. `SparkResult`
  gains `pending` (a lost response; the payment may settle under `transferId`), `token` and
  `token-pending`; `SparkErrorCategory` gains `unknown`; `SparkControllerError` carries
  `transferId` / `inputOutputIds`; `send` / `payInvoice` / `paySparkInvoice` / `withdraw` take a
  required `transferId`, derived from the request id by the pipeline.
- **BREAKING:** `@qntx/wallet-engine`: `engine.bridges.quote` requires `maxFeeBps` (0–10000), the
  relay-fee ceiling; swap and bridge quotes must match the requested tokens, amount, destination
  and slippage before they leave the engine.
- **BREAKING:** `@qntx/wallet-engine`: `AssetsController` requires a `chains` option; custom
  tokens persist as `{ address }` and `verified` is computed at read time from the built-in tables.
- **BREAKING:** `@qntx/wallet-engine`: `WalletEngine.transactions` no longer exposes `prepare*`
  methods; every signing path goes through `engine.requests`.
- **BREAKING:** `@qntx/wallet-chains`: `evm.typed-data` requests must declare
  `types.EIP712Domain` (`invalid-typed-data` otherwise); typed data nesting is capped at 32;
  EIP-1559/7702 transactions with `maxPriorityFeePerGas` above `maxFeePerGas` are rejected.
- **BREAKING:** `@qntx/wallet-chains`: `bitcoin.psbt` inputs signed under `btc.bip44`, `btc.bip49`
  or `btc.bip84` need `nonWitnessUtxo`; a fee is computed only from proven input amounts (a
  `witnessUtxo` amount counts only when a signed taproot input commits to all amounts), and PSBTs
  whose outputs exceed their proven inputs, or with an output lacking a script or amount, are
  rejected. The engine attaches previous transactions itself and takes dApp prevouts from Esplora.
- **BREAKING:** `@qntx/wallet-chains`: BIP-322 simple signatures reference to_spend by its txid in
  the correct byte order and match the official vectors; signatures made by earlier versions no
  longer verify. Legacy (P2PKH) message signatures are made over the standard digest and verify in
  Bitcoin Core and Electrum.
- **BREAKING:** `@qntx/wallet-chains`: `normalizeSolana` accepts the wallet as any required signer
  of a `solana.transaction`, not only the fee payer (the decoded fee is 0 when it is not);
  transaction versions other than legacy and v0 are `ChainError("unsupported")`; a compiled
  message with trailing bytes is rejected; duplicate compute-budget instructions are rejected and
  every Solana transaction intent carries a maximum fee derived as Agave does.
- **BREAKING:** `@qntx/wallet-chains`: `isBlindIntent` takes `Pick<DisplayIntent, "blind">`.
  `SafeTransaction.refund` is `{ receiver?, gasPrice, amount }` with
  `amount = (baseGas + safeTxGas) × gasPrice` in the gas token. `SignInParse` `malformed` carries
  the `claims` its preamble lines make.
- **BREAKING:** `@qntx/gateway`: `GatewayOptions` requires `auth` (construction fails when a
  provider names an unconfigured account) and `prices: { cache, coingecko? }`; production needs the
  `COINGECKO_API_KEY` secret.
- **BREAKING:** `@qntx/gateway`: an ambiguous broadcast (`eth_sendRawTransaction`,
  `sendTransaction`, Esplora `POST /tx` whose provider timed out, failed or answered malformed)
  answers `502 {"error":"outcome-unknown"}` instead of being retried on the next provider;
  broadcasts fail over only after an open breaker or a 401/403/429 refusal.
- **BREAKING:** `@qntx/gateway`: the Solana RPC allow-list drops `getBlock` and gains
  `getVoteAccounts` and `getStakeMinimumDelegation`.
- `@qntx/wallet`: password re-verification (signing, exports, factor and backup management) is
  rate-limited like unlock. `keys.list` no longer renews the idle timer. The call watchdog is
  suspended while a system verification prompt is open, so a slow user no longer crashes the
  React Native session.
- `@qntx/wallet`: requests beyond `MAX_IN_FLIGHT` wait in order in the main runtime instead of
  being posted at once.
- `@qntx/wallet`: `chain.sign` runs one two-pass flow for HD and imported keys; the host checks the
  signed content against the request (the EVM envelope is rebuilt and compared byte for byte, a
  PSBT must keep its unsigned transaction and prevouts) as well as the signer.
- `@qntx/wallet-native`: the Argon2 reference implementation is vendored and runs on the KDF worker
  thread (`__qntx.argon2id`); the Web and Node workers use `@noble/hashes`. The native file
  primitive is a compare-and-swap (`__qntx.file.replace`); `__qntx.file.write` and
  `__qntx.frames.onIntegrityViolation` are removed. The Spark native backend's ABI version is
  checked when the kernel starts. Kernel crash reasons stay out of public system logs.
- NIP-07 asks for confirmation of every replaceable (10000–19999), addressable (30000–39999) and
  ephemeral (20000–29999) event kind and of kinds 0, 3 and 5, whatever the origin's policy.
- `@qntx/wallet-engine`: the injected `setTimer` is one-shot (`setTimeout` semantics); polling
  loops re-arm it.
- `@qntx/wallet-engine`: custom RPC endpoints are probed again at every unlock; one that no longer
  serves its chain is skipped for the session but stays persisted.
- `@qntx/wallet-engine`: the Bitcoin address gap scan fails closed after 2000 addresses per chain.
- `@qntx/wallet-engine`: address-book sync treats a contact's family, address and creation time as
  immutable under its id, deletes as terminal, and refuses remote records stamped more than one
  hour ahead.
- `@qntx/gateway`: rate limits are charged per JSON-RPC call by weight (100 RPC / 50 default per
  client and 300 per IP prefix per 10 s, in weighted units); request bodies are capped before they
  are read (RPC 512 KiB, Esplora 1 MB; `413 invalid-request`) and upstream responses are bounded
  (RPC 8 MiB, Esplora 16 MiB streamed with a 30 s deadline); `eth_getLogs` tags must be equal or
  both name the head. Upstream 400/413/422 answers are `400 invalid-request` for that caller only
  and never open a shared breaker. Phishing list builds isolate each source's allow list and stop
  when a source's deny count halves or the allow list grows by more than 50 keys. wrangler
  4.160.0, hono 4.13.17.
- Build and release: `bunfig.toml` enforces a 7-day minimum release age on every install;
  `scripts/check-links.ts` (in `check:pkg`) fails on `@qntx` packages linked from outside the
  checkout; `bun run lint` runs `scripts/check-lint-boundaries.ts`, which proves every lint-enforced
  architecture boundary still fires; `scripts/check-version.ts --release-tag`; the publish workflow
  needs a verified tag on `main` with a green CI run; reusable workflows are pinned to a commit;
  staging and production gateway deploys are isolated and roll back on a failed smoke; rulesets
  require two reviewers.
- **BREAKING:** `AssetsController` takes `gateway`, `fetch` and `now` options, and `TokenBalance`
  now always carries `spam` and `hidden`.
- **BREAKING:** `verified` is also true for a token-list entry whose list decimals equal the
  on-chain decimals (it was true only for the built-in table).
- Hidden tokens are excluded from price requests and portfolio valuation.
- EVM token metadata (`decimals`, and `symbol` for custom tokens) is read once per unlock in batched
  `aggregate3` calls of at most 300, instead of two `eth_call`s per token per refresh.
- **BREAKING:** `@qntx/wallet-chains`: `BlindReason` gains `typed-data-commitment`,
  `typed-data-variant` and `core-instruction`; exhaustive maps over it must add them.
- **BREAKING:** a request is described only if what the prompt prints bounds what the signature
  authorises. With blind signing off the kernel now refuses: typed data that signs only hashes;
  near misses of recognised typed-data families (Safe 1.0.0 `dataGas` SafeTx, SafeTx with operation
  2 or without `verifyingContract`, EIP-3009 `TransferWithAuthorization` /
  `ReceiveWithAuthorization` on a built-in token, ERC-4494 `Permit`, unknown Seaport item types,
  `BulkOrder`, unknown Permit2 types); Seaport orders with more than four offer or consideration
  items (`typed-data-oversize`); undecoded core-program Solana instructions the signer signs (SPL
  `Transfer`, `SetAuthority`, `ApproveChecked`, System `Assign`, Stake `Split`, …). WETH `deposit`,
  Aave `supply`, Universal Router `execute` and CoW orders stay described.
- **BREAKING:** `messageContent` returns `bytes` for a message of exactly 32 bytes and for text
  with an unsafe code point other than TAB/LF/CR; `messageBlindReason` returns `message-bytes` for
  those and for text that is the hex rendering of at least 32 bytes (EVM `personal_sign` and Solana
  `signMessage`). Such messages need blind signing.
- `@qntx/wallet-chains`: EIP-712 `domain` keeps only the keys `types.EIP712Domain` declares; an
  undeclared `chainId`, `verifyingContract`, `name` or `salt` is neither shown nor used for
  recognition, the execution-grant refusal or the chain-id check (signatures are unchanged).
- **BREAKING:** `@qntx/wallet-engine` dApp sends: Solana `signAndSendTransaction` returns the
  locally computed fee-payer signatures and Bitcoin `signAndSendTransaction` the locally computed
  txids of what went out, never the ids an RPC reports. `SolanaSignResult` (send) and
  `BitcoinSignResult` gain an optional `refused: { index, error }`: a batch whose transaction k > 0
  the node refuses stops there, ends `submitted`, and the provider rejects the page naming the
  refused index and the ids already submitted ("do not resubmit").
- `@qntx/wallet-engine` history: `verified` now means chain-proven from a host endpoint. Entries
  read only through the gateway (no independent host endpoint for the network) are never
  verified, for EVM, Solana and Bitcoin alike; an EVM entry is verified only when every
  wallet-touching movement in its receipt and transaction is claimed.
- `@qntx/wallet-engine`: the engine opens one `EngineStore` per unlock session and hands it to
  every controller; controllers no longer open stores of their own, and the store is closed on
  lock.
- `@qntx/wallet-engine`: relay metadata sync (`metaSync`) starts in the background at unlock; the
  request pipeline and transaction recovery no longer wait for the relays.
- **BREAKING:** `@qntx/wallet-engine/gateway/contract`: a history `cursor` above
  `HISTORY_CURSOR_MAX` (2^63 − 1) and quote amounts wider than uint256 (EVM swap,
  bridge) or u64 (Solana swap) are `400 invalid-request` before any upstream call.
- `@qntx/wallet-engine/gateway/contract`: RPC cost scales with caller-sized arrays: per started 10
  elements of `getMultipleAccounts` / `getSignatureStatuses` (1 each) and `eth_getProof` storage
  keys (3 each); `eth_simulateV1` pays 3 per simulated block or call, whichever is more.
- Gateway: a history drain round pays its two units before it is sent.
- Gateway: upstream 401/403, other 4xx (including 404), malformed bodies and upstream JSON-RPC
  errors fail over without counting against the shared breaker; an upstream 400/413/422 on a
  JSON-RPC route and any answer over the route's response cap are the request's own `400`. Only
  transport errors, timeouts, 5xx and 429 open a breaker.
- Release: `publish-npm.yml` publishes from its own `publish` job in the environment `npm` (the
  only job with `id-token: write`), after `verify` and an unprivileged `pack`; every job is
  tag-only. `.github/rulesets/README.md` lists the npm Trusted Publisher and GitHub environment
  settings that must be applied for a branch to be unable to publish.
- CI: gateway deploys require the passing CI run to be a push on `main`.
- `bun run lint` enforces the package and kernel-layer boundaries on resolved import paths
  (`scripts/check-boundaries.ts`) — relative cross-package paths, `..`/`./` detours and the native
  kernel entry included — and lints enclave code against a global allow-list (no `globalThis`,
  `setTimeout`, `fetch`).
- **BREAKING:** `@qntx/wallet-engine`: every `WalletEngine` controller member is a host facade —
  the host methods listed for it plus a read-only `store` (`getState`, `getInitialState`,
  `subscribe`). Controller lifecycle and wiring (`init`, `lock`, `destroy`, `setStore`,
  `setAccounts`, `lockAll`, `reconcile`, `trigger`, `invalidateAll`), `store.setState`,
  `spark.sendToken` / `claimDeposit` / `inspect`, `transactions.submitDappBitcoin` /
  `recordBatch` / `markDepositClaimed` / `batchById` / `delegationState` (use
  `engine.delegation`), `requests.invalidateOrigin` (use `connections.invalidateOrigin`),
  `connections.request` / `authorize` / `touch`, `accounts.exportMeta` / `mergeMeta`,
  `addressBook.merge` / `syncEntries`, the networks cross-check clients (`ensClient`,
  `independent*`) and the provider handlers' `options` are no longer reachable from the engine.
  Type a component with `WalletEngine["spark"]`, not the controller class.
- **BREAKING:** `@qntx/wallet-engine`: the Bitcoin balance field for outputs protected as
  possible inscription or rune carriers is `protected` (`AccountBalances.protected`,
  `BitcoinTotals.protected`), not `frozen`. User freezes stay the separate
  `transactions.frozenUtxos` list; a user-frozen coin still counts in `native`.
  `TokenBalance.frozen` (Solana) is unchanged.
- **BREAKING:** `@qntx/wallet-engine`: `SparkResult`'s pending variant is
  `{ kind: "pending", payment: SparkPaymentRecord }`; `token-pending` is removed.
  `SparkControllerError` carries `payment` instead of `transferId` and `inputOutputIds`;
  `HistoryControllerOptions.spark` needs the Spark controller's `store`.
- `@qntx/wallet-engine`: while a token send with an unknown outcome is open, another send of the
  same token is refused until it resolves.

- **BREAKING:** `@qntx/wallet-engine`: `confirmed` is no longer terminal. A transaction in a block
  stays tracked (every `pollMs × 15`) until `final`; if its block leaves the chain it returns to
  `submitted`, its EVM nonce and Bitcoin inputs are held again, a replace-pair sibling marked
  `replaced` is revived, and the persisted bytes are rebroadcast. Treat a transaction as settled
  only when `final` is true (or it ended off chain: `failed` without a block, `rejected`,
  `dropped`, `replaced`), and show it pending again after a reorg.
- **BREAKING:** `@qntx/wallet-engine/gateway/contract`: `historyResponse` requires
  `truncated: boolean`, set when the gateway omits transfers in the page's range (a drained block
  over one upstream page, a transaction over `HISTORY_TRANSFERS_MAX` transfers, a page over
  `HISTORY_ITEMS_MAX` items). Both schemas are strict: deploy the gateway and the engine together.

- **BREAKING:** `NetworkInfo.opStack` is replaced by `NetworkInfo.feeModel` (`{ kind: "execution" }` or `{ kind: "op-stack" }`), set on every EVM network; the `FeeModel` type is exported from `@qntx/wallet-engine` and `@qntx/wallet-engine/gateway/contract`. See MIGRATION.md.
- Multicall3 is per network; ZKsync Era and ZKsync Sepolia use 0xF9cda624FBC7e059355ce98a31693d299FACd963.

- `@qntx/wallet-engine`: `NetworkInfo.family` is the new `EngineFamily` (`"evm" | "solana" | "bitcoin"`); TRON networks in the chain table are not served by the engine yet.
- Messages: every valid UTF-8 message is `kind: "text"`. Joiners, direction marks, soft hyphens and variation selectors are ordinary text (emoji ZWJ sequences, Persian ZWNJ, Hebrew/Arabic marks). 32-byte text, text with hidden/reordering characters and text that encodes raw bytes are blind (`message-bytes`) but still shown, under a line naming the hazard. New export `messageTextHazard`; `hasHiddenCharacters` and `isEncodedBytes` replace `isReadableText`, `isUnsafeCodePoint` and `isHexRendering`.
- `IntentWarning.kind` is the closed union `IntentWarningKind`.
- Seaport orders show up to 8 offer/consideration items (`ORDER_ITEMS`, was `SEAPORT_ORDER_ITEMS` = 4).
- Snapshot votes (snapshot.js Vote types) are a decoded family.
- Solana: SPL `Transfer`, `Burn`/`BurnChecked` and Stake `Split` signed by the account are decoded.
- **Breaking:** `SolanaSignResult.refused` / `BitcoinSignResult.refused` are replaced by
  `stopped: { index, reason: "refused" | "not-sent", error }` (see MIGRATION).
- `TrackedTransaction` gains `durableNonce?: { account: string | undefined; value: string }`.
- `HostController` state types are `DeepReadonly`; new exported type `DeepReadonly`.
- gateway: an upstream `429` is no longer an outage: it cools the whole provider account down for
  `min(Retry-After, 30 s)` (5 s default) and fails over. An attempt timeout counts against the
  breaker only when the provider's liveness probe (`eth_chainId`, `getHealth`, Esplora tip height,
  CoinGecko `ping`) also fails. Nothing a client sends can open a breaker for other users.
- gateway: IPv6 clients are charged on their `/64` and `/48` (IPv4 `/24`).
- gateway: the flood limiters count requests and batch entries; cost lives in the share limiter.
- gateway: history on a served network without a history provider answers `404 unsupported` (was
  `503`); `GET /v1/tokens/:caip2` answers `404 unsupported` for a network no token source covers
  and `503 unavailable` for a covered one whose list is not built yet (was `404` for both).
- `@qntx/wallet-engine`: `PricesState.errors` values are `"unpriced" | "unsupported"`; an
  unsupported asset drops its stored quote. Token lists back off on a bare `404` or a `503` and
  store an empty list only for `unsupported` / `unknown-network`.
- **BREAKING:** `FeeModel` variants carry a required `pricing: GasPricing`; the `op-stack` variant also carries `operatorFee` (false on pre-Isthmus oracles, which revert on `getOperatorFee`) and `tokenRatio`; a `scroll` variant is added. See MIGRATION.md.
- The OP Stack and Scroll L1 data fee shown in `DisplayIntent.fee.l1Data` (and used for the `fee-exceeds-amount` check) is now an upper bound: the oracle estimate × 5/4, sized from 5,600+ real transactions where the charge never exceeded 1.14× the estimate read one block earlier. Displayed maximum fees on Base, OP Mainnet and the other OP Stack networks increase accordingly.
- `@qntx/wallet-engine`: `GatewayScope` gains `"tron"` — TRON gateway traffic carries its own
  per-session client id. `GatewayConfig` and `GatewayScope` are now exported from the package root.
- `requests.prepare({ method: "evm-sign" })`: `origin` is optional; without it the request is the
  wallet's own and only `evm.typed-data` is accepted.
- `@qntx/wallet-engine`: a Spark sats payment becomes `failed` only when the operator lists its
  transfer as expired or returned. An id the operator does not list stays `unknown` at any age
  (previously `failed` at once on a complete listing, or after 30 minutes) — operator lag can no
  longer turn a committed payment into "failed" and invite a second payment. A shortfall is
  checked against the balance before anything is recorded and fails `insufficient-funds`.
- `@qntx/wallet-engine/apps`: Hyperliquid deposits go through CCTP (an exact USDC approval to
  `TokenMessengerV2` when the allowance is short — `deposit` then returns `approval-required` and is
  called again once it confirmed — and `depositForBurnWithHook` to the account's own HyperCore perps
  or spot balance, Fast Transfer). `createApps` takes `networks` for the chain reads, and
  `requests.prepare` gains the internal method `evm-cctp`. The fee cap comes from Circle's fee API; deposits at or below the fee, or above the
  on-chain per-message burn limit, are refused. The deprecated Bridge2 deposit is removed.
- `@qntx/wallet-engine`: TRON node responses are parsed losslessly: int64 amounts above 2^53
  (balances, TRC-10 totals, delegated amounts, chain parameters) are exact `bigint`s.
  `TronFeeQuote` availability fields are `bigint`; TRON account resource counters are decimal
  strings.
- `@qntx/wallet-engine`: a TRON transaction is `dropped` only when the independent endpoint (when
  configured) also proves it expired and unknown; any dissent or read failure keeps it
  `submitted`.
- `@qntx/wallet-engine`: EVM history entries of an account that has code (an EIP-7702 delegation
  included) are not `verified` unless the transaction reverted — a delegate can move native value
  without leaving a trace the claims are checked against.
- `@qntx/wallet-chains` / kernel prompt: a 32-byte message (digest-length hazard, still blind)
  shows its bytes as `Data 0x…`, and its text only when every code point prints plainly; the same
  in every family. Message decoders keep a leading BOM, so a 32-byte message starting with EF BB BF
  no longer measures 29 bytes and escapes the digest-length rule.
- `@qntx/wallet-engine`: a TRON transaction the engine built is rebuilt in place at approval when less than 20 s of validity remain or its reference block left the solidified chain (same contract and `fee_limit`, fresh block and 60 s expiry; refused when the fee cap would rise or the intent changes) — it used to fail at 5 s.
- `@qntx/wallet-engine`: `createBrowserBridge` requires a `tron` handler (`engine.tronWallet`); the facade's `connections` gains `setTronNetwork`.
- `@qntx/wallet-chains/evm`: `typedDataFields` takes an optional leaf-value override.
- `@qntx/wallet-engine`: `bitcoin:signAndSendTransaction` results carry `signedPsbt` next to `txId`.
- **BREAKING:** `@qntx/wallet-engine/apps`: `createApps` takes `apps: [hyperliquid(…),
  polymarket(…)]` instead of a `hyperliquid` config field and returns `controller`, `destroy` and
  one api per listed app id. The entry now carries only the controller and shared core; providers
  ship in the `/apps/hyperliquid` and `/apps/polymarket` sub-entries, so a host pays only for the
  apps it imports (gzip: core 9.8 kB, Hyperliquid 18.8 kB, Polymarket 39.6 kB).
  `AppGroupState.status` gains `"needs-migration"`, `AppStep` gains `"locate-wallet" |
  "deploy-wallet" | "credentials" | "approvals"`, and groups carry an optional `account`. The
  shared WebSocket core moved to `src/apps/socket.ts` (Hyperliquid behaviour unchanged).
  `controller.approveBuilder(group, "polymarket")` is refused with `PolymarketError("invalid-input")`
  (Polymarket has no builder fee approval). The main engine entry is byte-identical.
- **BREAKING:** `@qntx/wallet-chains`: `ParsedSolanaMessage["version"]` is `"legacy" | 0 | 1`
  (a discriminated union carrying `config` for v1); a v1 message no longer throws
  `ChainError("unsupported", "Solana transaction version 1 is not supported")`, and a v1 wire no
  longer fails with "transaction exceeds the 1232-byte limit" below 4096 bytes. Versions above 1
  stay `unsupported`. A v1 `solana.transaction` request that carries `lookupTables` is
  `invalid-request` (v1 has no lookup tables).
- `@qntx/wallet`: the `solana.transaction` `message` transport bound is 4096 bytes (was 1232).
- `@qntx/wallet-kernel`: `chain.sign` signs v1 `solana.transaction` requests under the same
  blind-signing policy (was `invalid-input`); a v1 message as `solana.message` is still refused.
- `@qntx/wallet-engine`: a send whose outcome is unknown is never declared `dropped` by a timer.
  EVM transactions end only on their receipt, a replacement, or their nonce being consumed without
  their receipt (now cross-checked against the host endpoint when configured); Bitcoin
  transactions only on inclusion, an input spent by another confirmed transaction, or their own
  replacement confirming. After 30 minutes unseen a row carries `stuck: true` (still `submitted`,
  nonce or inputs still held, polled at the finality interval) — offer speed-up or cancel.
- `@qntx/wallet-engine`: a definite broadcast refusal is stored durably as `failed`; if the store
  cannot take it (vault locked, write error) the row is retried by its own loop and replayed at the
  next unlock. A `signed` row recovered at unlock becomes `submitted` with `rebroadcast: false` —
  watched on chain, never resent. `lock()` clears transaction rows and call batches from memory.
- `@qntx/wallet-engine`: TRON `dropped` and reorg answers need the host endpoint's agreement or
  three consecutive polls spanning more than one solidification period (~57 s); every read of a
  poll is pinned to one upstream.
- `@qntx/wallet-engine`: TRON (send, stake, approve, dApp, rebuild) and Solana wallet builds are
  refused when only the gateway vouches for the reference block / recent blockhash; with a host
  endpoint it must confirm it, and the gateway's answering node must report the network's genesis.
- `@qntx/wallet-engine`: the OP Stack / Scroll L1 data fee maximum is `raw × (9/8)^3` (was × 5/4),
  re-read at approval (a rise beyond the shown maximum ends the request: "the L1 data fee rose —
  start over") and again before broadcast when the approval read is older than one L1 slot.
- `@qntx/wallet-engine`: a Solana durable-nonce transaction is `dropped` only when the nonce
  account's signature history covering the time since submission does not list it; a listed
  signature settles the row.
- `@qntx/wallet-engine`: TRON history collapses duplicated TRX/TRC-10 claims, shows
  `call_value` / `call_token_value` movements, and verifies an entry only on a decoded, sha256-pinned
  body; an unclaimed movement is `chain-mismatch`.
- `@qntx/wallet-engine`: typed-data and message requests (`evm-sign`, `tron-sign`) whose decode
  moves value — an EIP-3009 transfer authorization, a Hyperliquid `usdSend` — carry the same
  recipient findings as a transaction (`first-recipient`, `address-poisoning`), from any origin.
- `@qntx/wallet-engine/apps`: Hyperliquid account views clear their data when closed or locked;
  `AppsController.lock()` clears `groups`.
- **gateway:** client shares, POLICY budgets and flood limiters (IP 3,000 / RPC 1,500 / default 400 per 60 s) are sized from measured engine usage so a fresh all-family cold start uses at most a third of one client prefix's allowance; the README states the concurrency target and its arithmetic.
- **ci:** the gateway deploy workflow checks required secrets before deploying, rolls back only when the previous version shares the Durable Object migrations (Cloudflare refuses rollbacks across a migration) and alerts otherwise; a new `gateway-workerd` job boots the real worker with Durable Object and rate-limit bindings and runs the smoke plan and budget scenarios against stub upstreams, plus `wrangler deploy --dry-run` for both environments.
- `@qntx/wallet-chains`: Velora/Paraswap Delta orders deliberately stay blind: the verifying contract is an owner-upgradable module adapter, so the order bounds are not fixed by the signed bytes. 1inch Fusion orders stay blind: their extension's amount getter decides the taking amount and is only hash-committed in `salt`.
- `@qntx/wallet-chains/evm`: exports `hyperliquidL1Document` and the `HyperliquidL1Action`,
  `HyperliquidL1Order`, `HyperliquidL1Params`, `HyperliquidNetwork` types (the encoder moved out
  of the kernel scheme so `@qntx/wallet` can verify session signatures); `@qntx/wallet/protocol`
  and `@qntx/wallet/sessions` re-export the same names. `PROGRAM_IDS` gains `ed25519`,
  `secp256k1` and `secp256r1`.
- `@qntx/wallet-chains`: a raw `personal_sign` whose text begins with `I agree to access my
  profile.` or `I agree to access my Fiat24 profile.` is now blind with `"fiat24-session-grant"`,
  whatever its origin. The wallet signs Fiat24 grants only when it builds them itself.
- `@qntx/wallet-chains`: an ERC-7821 batch's `DisplayIntent.warnings` now includes the warnings of
  its inner calls. The kernel prompt now also shows the warnings of each Safe inner call.
- **build:** the size budgets `apps-hyperliquid` 19 → 20 KiB (measured 19 372 B) and chains `tron`
  80 → 84 KiB (measured 81 364 B) moved once; `scripts/check-kernel-budget.ts` gains a
  `fiat24 decoder` unit.

### Removed

- **BREAKING:** `@qntx/wallet`: error code `no-device-credential` (replaced by
  `verification-unavailable`).
- **BREAKING:** `@qntx/wallet-engine`: the per-account-group blind-signing flag
  (`AccountTreeController.setBlindSigning` / `blindSigning`, `AccountGroup.blindSigning`). It
  lived in the main runtime, where the code it was meant to restrain could switch it on.
- **BREAKING:** `@qntx/wallet-engine`: `AssetsController.refreshBitcoin(xpub, network)`; use
  `refreshBitcoinGroup`, or `refresh(address, network)` for a plain Bitcoin address.
- **BREAKING:** `@qntx/wallet-engine`: `ConnectionController.setActiveGroup`, `activeGroup`,
  `accounts`, `solanaAccount`, `bitcoinAccounts` and `nostrAccount`;
  `SolanaWalletHandler.solanaAccountsChanged` and `BitcoinWalletHandler.bitcoinAccountsChanged`;
  the Solana and Bitcoin handlers' `activeGroup` option.
- **BREAKING:** `@qntx/wallet-engine`: `EngineOptions.gateway.installId`,
  `SparkControllerOptions.random`, and `ProviderInfo.uuid` in `/connect`.
- **BREAKING:** `@qntx/wallet-chains`: `ChainErrorCode` `fee-payer-mismatch`; `SafeTransaction`
  `gasToken` / `refundReceiver` (now inside `refund`).
- `@qntx/wallet-engine/apps/hyperliquid`: the `not-placed` Hyperliquid order outcome — an unproven outcome is
  `unknown`.

### Fixed

- `@qntx/wallet-chains/evm`: native value sent with calldata is always an outflow; an unrecognised
  payable call, a payable token call and a contract creation decoded with no outflow (#224).
  Native amounts in typed data take the request network's symbol and decimals (Seaport no longer
  labels POL, BNB, AVAX or HYPE as ETH; Safe inner calls no longer show base units). Across
  deposits with unexplained native value and Jupiter routes with slippage above 100% are no longer
  recognised (they decode as opaque).
- `@qntx/wallet-chains/bitcoin`: value sent to an `OP_RETURN` output is no longer hidden from the
  prompt or the intent.
- `@qntx/wallet-chains/solana`: a raw `solana.message` that a cluster could accept as a
  transaction message of any version is never signed; a `0xff` off-chain prefix passes only when
  the whole payload is well-formed UTF-8.
- Solana Wallet Standard `solana:signTransaction` and `solana:signAndSendTransaction` work with real
  dApp transactions (every serialized transaction failed with "compiled message has trailing
  bytes"), and `standard:connect` no longer fails with "no Solana account for the group".
- Cooperative exits no longer fail with `integrity` in `spark.signFrost`; Spark lightning and exit
  approvals again cover several signing calls until they expire; a Spark token approval covers
  outputs summed per receiver.
- `@qntx/wallet`: a session ending during a password change or a verification prompt fails
  `locked` instead of latching the vault `corrupted` or answering `integrity`; a request whose
  params share references (`n = [n, n]` nested deep) no longer freezes the kernel or the host, and
  methods named after `Object.prototype` members are unknown methods; a backup payload ending in a
  lone tag byte is `integrity`.
- `@qntx/wallet`: secrets are wiped on every path — backup factor secrets and derived KEKs,
  `keys.export` encodings (no longer built as a JS string), the minted DEK and wire inputs of a
  failed create or import, and the mnemonic during seed derivation (built as bytes, never a
  string); `chains.sign` and `spark.approve` transfer the verify password or PRF output instead of
  structured-cloning it; `createWithPasskey` / `restoreWithPasskey` reject locally decidable errors
  before the WebAuthn ceremony.
- React Native: a burst of concurrent requests no longer kills the session; two kernels can no
  longer overwrite each other's vault file (commits fail `conflict` if it changed); kernel frames
  are wiped on both sides of the boundary; a response the port cannot encode is answered with
  `integrity` instead of hanging until the watchdog, and an unencodable request rejects
  `invalid-input` as on the Web; strings with a lone surrogate are refused instead of silently
  replaced; an undecodable inbound frame crashes the kernel immediately; the 24-hour session limit
  counts time asleep; the iOS passkey PRF output reaches the kernel as wiped bytes.
- dApp connections: a page can no longer get a signature from an account group it was not
  authorised for (EVM, Solana, Bitcoin, WebLN), silent Solana / Bitcoin `connect` no longer
  reveals another group's addresses, and NIP-07 signs with the session's identity; `change`
  events after a disconnect carry no account; adding a network keeps the origin's NIP-07 and WebLN
  policies; a request invalidated while its approval was in flight is never signed or sent; a
  cross-origin subframe gets no provider; the EIP-6963 uuid is no longer a fixed cross-site
  identifier; a Sign-In with Ethereum/Solana text for another domain is refused even when only
  lenient verifiers accept it.
- `@qntx/wallet-engine` balances: transaction tracking and balance polling ran only once on the
  one-shot timer, and timed refreshes called `refresh` with the wrong arguments; bip44, bip49 and
  bip86 balances no longer read 0 and a watched Bitcoin address no longer throws; Solana token
  balances sum every token account per mint (Token and Token-2022); built-in tokens show on every
  network that lists them without being added; watch accounts persist across unlocks.
- `@qntx/wallet-engine` sends: an ambiguous broadcast no longer leads to a double payment — the id
  comes from the signed bytes, the EVM nonce and Bitcoin inputs are held before the network call,
  and the tracker rebroadcasts the same bytes until the outcome is known, including after a
  restart. A Bitcoin transaction unknown to both Esplora endpoints for 30 minutes is `dropped` and
  releases its inputs; inputs are released on every terminal state; one whose input a confirmed
  foreign transaction spends settles `replaced`.
- `@qntx/wallet-engine` Bitcoin fee bumps: replacements spend only the original's inputs and the
  original account; coin selection spends only confirmed outputs and the wallet's own unconfirmed
  change, and replacements never add unconfirmed inputs; replacement and CPFP fees use a
  per-template vsize estimate and the replacement's own size for the BIP-125 rule-4 floor; CPFP of
  a bip44/bip49 parent builds on the bip84 change chain; a cancel that cannot pay its fee is
  refused.
- `@qntx/wallet-engine` Spark: paying a Bitcoin address shows the SSP fee and refuses a quote above
  `maxFeeSats` before approval; a corrupt exit-chain index, chain record or payment note is
  skipped instead of failing the client or the history page.
- `@qntx/wallet-engine` store: one tampered or torn row no longer aborts the unlock — a start that
  fails mid-sequence tears down and retries on the next status event; the IndexedDB primary keys
  no longer expose dApp origins, sign-log timestamps or account structure; a synced metadata
  document can no longer re-point, resurrect or revert contacts; account discovery no longer
  restamps groups and reverts renames made on another device; cloud backup no longer reports a
  conflict with its own write; adding a custom Esplora endpoint works.
- `@qntx/gateway`: a client could open the shared provider breakers for every user with requests
  the upstream answers 400/413/422; `id: null` or malformed params are rejected before any upstream
  call; a fresh client id per request no longer escapes the per-IP limit; oversized bodies no longer
  reach the paid upstreams; the production smoke no longer crashes on unconfigured auth.
- Token decimals are never guessed: a custom ERC-20 or SPL mint whose decimals cannot be read is
  omitted from the refresh instead of being shown at 18 (EVM) or 9 (Solana), and EVM `addToken`
  rejects such a token.
- Kernel: `backup.enable` wipes the backup password / passkey PRF when verification fails or the
  session is missing.
- Kernel: `backup.restore` runs the create/import gate before decrypting and wipes the payload
  plaintext and every decoded entropy or key on every failure path.
- Kernel: an establishing restore no longer persists an unauthenticated envelope factor list in the
  adopted backup key.
- The kernel prompt can no longer truncate Seaport order items without the request being blind.
- `@qntx/wallet-engine` dApp sends: Solana `signAndSendTransaction` goes through the same
  unknown-outcome path as wallet sends — the signed wire and its id are persisted before the
  broadcast, the transaction is tracked, and a lost answer (HTTP 502, timeout, non-JSON body)
  resolves the dApp with the wallet's signature instead of failing it and inviting a duplicate
  payment. Its expiry is bounded by the processed block height plus 150.
- `@qntx/wallet-engine` sends: signed bytes are never broadcast unless they reached the store; a
  vault that locks first fails the send with nothing sent.
- `@qntx/wallet-engine` Solana tracking: a transaction is `dropped` only when the expiry is proven
  — the block height (read first) is past `lastValidBlockHeight`, the cluster has no entry at any
  commitment, and the status came from a bank at least as far along. A transaction landing between
  the reads is no longer finalised `dropped`.
- `@qntx/wallet-engine` EVM nonces: a nonce is reserved for its transaction in the same step as the
  request's commit, so two overlapping approvals can no longer sign the same nonce; a refused send
  frees only its own nonce and never one a live transaction holds; a self-sponsored EIP-7702
  transaction also holds its authorization nonce; live transactions are re-held at unlock.
- `@qntx/wallet-engine` Spark: exit chains are listed from their records; a lost or racing index row
  can no longer hide unilateral-exit data.
- `@qntx/wallet-engine` balances: a read that resolves after lock writes nothing and is not polled
  by the next session; Bitcoin `unconfirmed` counts only outputs of transactions this wallet built
  (a third party's unconfirmed payment to a change address no longer shows); a Solana token
  account repeated in an RPC answer counts once.
- `@qntx/wallet-engine` prices: a future-dated quote is stale, and an older answer no longer
  replaces a newer stored quote.
- `@qntx/wallet-engine` tracking: a status poll whose transaction changed while the poll was in
  flight (a replace pair settling, a reload) no longer overwrites the newer state.
- `@qntx/wallet-engine` networks: a non-JSON Solana RPC answer fails over as
  `<method>: HTTP <status> from <url>` instead of a `SyntaxError`.
- Gateway: any client could open the shared history breaker (and by the same pattern the prices
  and quotes breakers) for every user with requests the upstream rejects, e.g. a history cursor
  of 2^64.
- Gateway: a failed upstream attempt cancels its other in-flight calls instead of leaving them
  running.
- `@qntx/wallet`: `backup.enable` runs its factor ceremonies one at a time; a failed factor no
  longer leaves a later ceremony's credential id and PRF output resident on a wiped wire, and a
  wiped `SecretWire` zeroes any late copy.
- `@qntx/wallet`: a params byte field that is classified neither secret nor public fails
  typecheck, so a new secret field cannot silently become a plain call.
- `@qntx/wallet-native`: a start that fails after claiming the kernel slot keeps the
  still-stopping predecessor for the next start and unregisters its lifecycle host; a successor
  waits for the whole chain of stopping runtimes instead of crashing the session after 10 s; a
  runtime destroyed while waiting never evaluates the kernel.
- `.github/rulesets/apply.sh` leaves each environment exactly one deployment policy and no longer
  pipes into `grep -q` under `pipefail`.
- `@qntx/wallet-engine`: a Spark payment whose commit answer was lost, or that was still in flight
  when the app stopped, is no longer invisible after the request returns: it stays recorded and
  shown as pending until the operator settles or fails it.
- `@qntx/wallet-engine`: a definite error on a Spark commit retry that followed an uncertain attempt
  no longer fails the request — the first attempt may have committed — it reports `pending`.

- `@qntx/wallet-engine`: a transaction reorged out of its block no longer stays `confirmed`
  forever; an on-chain `failed` transaction is tracked to finality the same way. A final
  transaction is never polled again, also after a restart.
- `@qntx/wallet-engine`: EVM nonce ownership stays consistent across a reorg — a reorged
  transaction's nonce is held again, other included transactions' nonces stay consumed, and a
  speed-up or cancel of the reorged transaction is accepted.
- gateway: a truncated history page is no longer indistinguishable from a complete one (#378).
- Replace the CHANGELOG sentence at lines 309–311 of fd771da1 ("Text, sign-in messages, permits, Seaport orders, Safe transactions of decoded calls and every recognised transaction are never blind.") with: "Whether a request is blind follows the decoder rules in `packages/wallet/README.md`; blind text is still shown." The README was corrected in this lane.
- EVM sends now fill a nonce freed by a refused or dropped transaction before signing anything
  higher: `EvmNonces.next` answers the lowest free nonce at or above the chain count, a prepared
  request sitting above a freed nonce is stale at approval, `reserve` refuses to sign above a gap,
  and a transaction already broadcast above a gap carries an explanatory `error` note on its tracked
  row until a send fills it.
- A storage failure after a transaction's bytes may have left the device no longer fails the
  request: the durable pre-broadcast record stays the source of truth, the row stays tracked in
  memory and the write is retried on the next poll. `wallet_sendCalls` bookkeeping writes are
  best-effort for the same reason.
- dApp batch sends (Solana `signAndSendTransactions`, Bitcoin PSBT broadcast) report exactly which
  transactions went out and distinguish "the network refused transaction k" from "transaction k
  was not sent" (a local failure before its broadcast).
- A broadcast settling after lock→unlock no longer writes into the new session's transactions or
  re-arms its timers.
- Solana durable-nonce transactions (first instruction `AdvanceNonceAccount`), from the wallet or a
  dApp, are never dropped by block height; they end only when they land or when the nonce account
  (read at `finalized`) no longer holds their nonce and a bank at least as fresh has no status
  entry. A nonce account loaded from a lookup table is kept tracked until the transaction lands.
- A Solana blockhash expiry is proven only when the polling endpoint's own `isBlockhashValid`
  says the blockhash is dead — a bound read from a lagging endpoint at request time can no longer
  drop a transaction that can still land.
- EVM history verifies provider claims one-to-one against receipt logs: identical claims collapse,
  ERC-1155 `TransferBatch` amounts are summed per id, and a native claim backed by no value
  movement (zero value, failed tx) leaves the entry unverified.
- Spark payments that throw after the commit call are no longer reported failed unless the Spark
  operator's own listing shows no such transfer; otherwise they stay `unknown` (WebLN `-32010`).
  Spark errors are categorized by class before message text (a 502 mentioning "rejected" is a
  network failure).
- Engine facade `getState()` snapshots are deeply frozen and typed `DeepReadonly`.
- Meta sync and token metadata writes started before a lock no longer land in the next session;
  `addToken`/`setTokenHidden` refuse while locked.
- gateway: a price request whose later source charge is refused keeps and caches what the earlier
  source already returned instead of answering `429`; CoinGecko keeps every platform that answered.
- `@qntx/wallet`: the type-level guard that every bytes-carrying RPC param field is classified
  secret or public now sees bytes in union members, nullable array elements, `ArrayBuffer`s and
  `Map`/`Set` values.
- `@qntx/wallet-native`: each lock/unlock no longer leaks the previous kernel runtime and its copy
  of the kernel bytecode (the predecessor chain is released on teardown).
- scripts: the source boundary checker no longer skips `.js`/`.cts` files, nested
  `generated`/`dist`/`node_modules` directories or symlinks, and refuses `#imports`, tsconfig
  `paths`, absolute specifiers, `require()` and `import.meta.glob` in library source.
- Mantle and Mantle Sepolia showed an L1 data fee about 4,400 times too low: Mantle charges `getL1Fee × tokenRatio()` in MNT.
- Speeding up or cancelling a legacy (type-0) EVM transaction re-signed it at the original, un-bumped gas price.
- `@qntx/wallet-engine`: RPC answers missing a field the spec guarantees (Solana
  `lastValidBlockHeight`, `blockhash`, `absoluteSlot`, `blockHeight`, rent, lamports, epoch; EVM
  nonce, gas estimate, gas price, fee history, receipt `status`) are malformed answers, never read
  as 0. A missing `lastValidBlockHeight` previously made a live transaction look expired; a receipt
  without `status` looked successful.
- `@qntx/wallet-engine`: Bitcoin UTXO lock snapshots are written in order and a failed write is
  logged instead of an unhandled rejection; a restart re-locks the inputs of live tracked
  transactions, so a lost snapshot cannot make spent outputs selectable.
- `apps/gateway`: TRON upstream bodies are validated after the same lossless parse.
- `@qntx/wallet-engine`: the in-app Solana and Bitcoin providers reported a rejected, expired or
  invalidated request as `-32603 internal error`; they now reject with `4001` like EIP-1193 (and
  `-32602` for a sign-in for another domain).
- `@qntx/wallet-engine`: a durable-nonce v1 transaction is tracked as durable — the kit decoder
  exposes no `instructions` for v1, so the nonce check read it as blockhash-lifetime and the poll
  could declare it dropped while it could still land. `durableNonceOfMessage` now reads the
  wallet's own parse and lets a parse failure propagate.
- **gateway:** the per-IP share of a provider account is priced from the account's minute-scale windows only; day and month quotas are enforced by the global account budget. CoinGecko (every non-USD price) is served again instead of `413 too-costly`, and the production smoke check can pass.
- **gateway:** a request whose share of one provider account is spent fails over to the next provider; the client gets `429` (shortest wait) only when every provider refused its share, `413` only when every one was too costly.
- **gateway:** every upstream call is billed at least one unit against the client share and the account budget, so zero-compute-unit methods are no longer free. dRPC is budgeted in requests (80 % of its 100 RPS Pay-as-you-go limit).
- **gateway:** client addresses are parsed strictly: IPv4-mapped IPv6 addresses are keyed by their embedded IPv4 /24, and a deployed gateway answers `400 invalid-request` to a request without a usable `cf-connecting-ip`.
- **gateway:** account-budget leases follow each isolate's spend rate and refusals are cached until their `Retry-After`, so the provider-budget Durable Object sees under one call per second per busy isolate instead of one per upstream call; a small request no longer shares a larger request's refusal. The object no longer wraps its synchronous storage in `blockConcurrencyWhile`.
- **gateway:** provider rows cite their sources (the dead Tatum URL is gone); Tatum, Ankr and TronGrid budgets follow the providers' published free-tier limits.
- **engine:** a Bitcoin balance read follows BIP-44 account discovery (an unused template's change chain is not walked, except `btc.bip84`, which receives every legacy-template send's change), derives UTXOs from the `/scripthash/:h/txs` page when it is complete, and remembers unused templates for the discovery interval: a fresh account's cold start costs 200 Esplora calls instead of 480 and a foreground refresh 81 instead of 380.
- **engine:** TRON built-in token balances are read only for contracts the indexer lists as held (the node stays the source of truth for their amounts); a failed indexer still reads every built-in.
- **scripts:** the bundle boundary check builds kernel entries exactly like the kernel build (same resolve conditions, nothing external) and judges workspace code reached through third-party packages; `new URL(literal, import.meta.url)` and `import.meta.resolve(literal)` are judged as module references.
- **ci:** the `tron-e2e` service image is pinned by digest.
- `@qntx/wallet-chains`: the Solana max fee now counts the signatures that ed25519, secp256k1 and
  secp256r1 precompile instructions verify (`data[0]` per instruction, legacy, v0 and v1), as
  Agave charges them; the displayed bound was up to 65 000 lamports below the fee charged on
  pinned mainnet transactions. A Solana instruction with empty data now parses (it is valid on
  chain) and is classified like any other undecoded instruction.
- `@qntx/wallet-chains`: EIP-712 and TIP-712 documents whose `string` values (domain or message,
  nested structs, arrays) contain hidden or reordering characters are blind `message-bytes`,
  exactly like text messages; the kernel prompt leads with the hidden-characters warning. RGI
  emoji sequences stay described.
- `@qntx/wallet`: `sessions(wallet).sign` verifies the kernel's answer — it rebuilds the scheme's
  document from `params` and the record's scope, recovers the signer and rejects `integrity`
  unless it is the session key.
- `@qntx/wallet-engine`: a host configured with only the gateway can send TRON and Solana on a
  mainnet again. A gateway-only testnet send is still refused, now with an error naming the
  missing `EngineOptions.rpc` entry: a mainnet reference block / blockhash would make a testnet
  signature valid on the mainnet, while a wrong-network binding on a mainnet send only makes
  that signature invalid on the mainnet. Gateway-only mainnet prepares carry
  `reads-unverified`; the genesis pin stays (and now also runs for gateway-only Solana).
- `@qntx/wallet-engine`: pinned TRON reads answered 429/503 wait the server's `Retry-After` and
  retry on the same upstream while the transaction's validity window allows it (minus a safety
  margin); broadcasts are never retried. When the window does not allow the wait the prepare
  rejects with the new `TronThrottledError` (`retryAfterMs`), which a host can retry.
- `@qntx/wallet-engine`: recipient risk keys a Fiat24 `transferByAccountId` / `clientPayout(Ref)`
  payment on the account or payee the calldata names instead of the cash-token contract every such
  payment shares — a payment to a never-paid Fiat24 account or payee is `first-recipient` again,
  and two Fiat24 ids are never compared as address lookalikes.
- Kernel prompt: a raw Fiat24 access grant whose text carries hidden or reordering characters
  keeps the hidden-characters warning under the grant line — the blind grant description no longer
  drops it.

### Security

- `@qntx/wallet`: `chains(wallet).sign` refuses a kernel result whose kind differs from the request's for every request kind (a Solana request previously accepted any result kind unchecked).
- `@qntx/wallet-chains`: an undecoded Solana program that receives the signer is described only with an exposure statement leading the prompt — it can move all SOL of the account and act with its authority on every listed writable account (the signer's ATAs for listed mints are named). Writable lookup-table accounts or more than 12 such accounts make the request blind with the new reason `program-authority`.
- `@qntx/wallet-chains`: an undecoded typed-data document with any hash or raw-bytes leaf (non-empty `bytes`, `bytesN`, or a string encoding ≥ 32 bytes / > 40 hex digits) is blind `typed-data-commitment`; a readable decoy leaf no longer makes it described.
- `@qntx/wallet-chains`: off-chain order protocols are claimed. 1inch LOP v4 orders without extensions/interactions, CoW Protocol GPv2 orders and UniswapX Exclusive/V2/V3/Priority witnesses (on reactors verified per chain) are decoded as orders showing the most given and the least received per recipient; any other 1inch, CoW, 0x v4, Blur, LooksRare v2, Bebop, Paraswap Augustus RFQ, Velora Delta, KyberSwap, OpenOcean or Odos document is blind `typed-data-variant`.
- `@qntx/wallet-kernel`: every decoder warning reaches the prompt (`permit2-witness` and `stake-lockup` were dropped); typed-data field lines render as `· path = value` so field names cannot imitate kernel lines.
- gateway: a few IP prefixes rotating client ids could spend the shared provider accounts, trigger
  upstream 429s and open the breakers for every user; one request could cost more than any
  limiter window. Fixed by the cost pricing, account budget, cost ceiling and throttle handling
  above.
- **Text rule bypasses closed.** The untrusted-text rule now classifies code points from generated Unicode 18.0.0 tables (`packages/wallet-chains/src/unicode-tables.ts`, written by `scripts/unicode-tables.ts`) instead of the engine's ICU, so the kernel (Hermes) and the host classify every code point identically. Emoji tag sequences are accepted only as the three RGI flag sequences — any other tag run (including the "ASCII smuggling" form that hid a sentence behind a black flag) is a hidden character; a variation selector counts only directly after a base it is defined for (StandardizedVariants, emoji-variation-sequences, or a unified ideograph for VS17–VS256); ZWJ/ZWNJ display only in their RFC 5892 ContextJ or emoji-ZWJ positions and show as U+FFFD elsewhere; the combining grapheme joiner always shows as U+FFFD. Every RGI emoji sequence and the usual Persian/Indic/Japanese/Mongolian joiner and selector uses stay plain text (`vectors/chains/text-rule.json`).
- **Requester text can no longer forge kernel prompt lines.** Every line of requester-supplied multi-line text in a signing prompt — message text, TRON memos, typed-data field lines — starts with `· `, which no kernel line does; a single-line requester value (domain name, token or agent name, TRON permission name) that had more lines or code points than shown ends with `…` instead of being cut silently.
- **Wrap/unwrap and Lido inside a Safe or deposit wallet credit the calling account.** WETH-style `deposit`/`withdraw` and Lido withdrawal requests in Safe or Polymarket deposit-wallet inner calls now show the Safe/wallet (the `msg.sender`) as the recipient or owner, not the signing EOA.

## [0.13.0] - 2026-11-09

DeFi on top of verified signing: EIP-7702 smart accounts and EIP-5792 call batches, same-chain
swaps through 0x and Jupiter, cross-chain transfers through Across, native SOL and Lido staking,
NFT sends, watch-only accounts and imported private keys. Every third-party quote is untrusted
input: the engine rebuilds or re-decodes each transaction and checks its terms on-chain before the
kernel shows it, and typed data that grants execution rights is refused in the kernel itself.

### Added

- `@qntx/wallet-chains/evm`: EIP-7702 against the MetaMask `EIP7702StatelessDeleGator` v1.3.0
  (`EVM_DELEGATOR`). `EvmTransaction` gains an `eip7702` variant (one self-sponsored authorization,
  `nonce = tx.nonce + 1`, delegator or zero address only); `encodeBatchExecute` /
  `decodeBatchExecute` for ERC-7821 batch mode; `decodeEvm` reports a `delegation` intent and
  decodes canonical batch self-calls call by call. `recoverEvmSigner` verifies the authorization.
- `@qntx/wallet-chains/evm`: 0x AllowanceHolder `exec` decoding (`ALLOWANCE_HOLDER`,
  `ZEROX_CHAINS`, `decodeZeroX`, `isZeroExSettler`): a taker Settler `execute` is a `swap` with the
  sell outflow and `DisplayIntent.minimumReceived`, the floor the Settler enforces on-chain; any
  other `exec` is a contract call with a one-time `allowance-holder` approval.
- `@qntx/wallet-chains/evm`: Lido stETH `submit`, the four WithdrawalQueue request forms and
  `claimWithdrawals` on mainnet; a request whose owner is not the signer is an outflow to that
  owner. Across SpokePool `deposit` / `depositV3` on nine chains as a `bridge` with
  `DisplayIntent.bridge` (`destinationNetwork`, `fillDeadline`, `refundTo`) and the calldata's
  output amount as `minimumReceived`.
- `@qntx/wallet-chains/solana`: Stake program decoding (create, initialize, delegate, deactivate,
  withdraw, authorize; post-SIMD-0490 and legacy account lists) with `DisplayIntent.staking`, a
  `stake-authority` approval and a `stake-lockup` warning. Jupiter `route_v2` /
  `shared_accounts_route_v2` as a `swap` with the derived minimum received, wSOL wrapping and
  closing back to the signer treated as harmless, and a platform-fee warning. Metaplex Core
  `TransferV1` as an outflow of the asset when the signer is the authority.
- `@qntx/wallet-engine`: internal requests `evm-delegation` (upgrade, revoke), `evm-batch`,
  `evm-approve` (exact amounts only; refuses unlimited, nonzero overwrite and no-op), `evm-swap`,
  `evm-bridge`, `evm-nft-send`, `evm-lido`, `solana-swap`, `solana-stake` and `solana-core-send`.
  Each verifies the quote or on-chain state on the primary and independent endpoints (disagreement
  refuses, an unavailable independent read is `reads-unverified`), requires its built transaction
  to decode back to exactly the requested terms, and requires a successful simulation that is
  re-checked at approval.
  - 0x: the AllowanceHolder code hash is pinned and the decoded Settler must be the deployer
    registry's current or previous taker Settler (`ownerOf(2)` / `prev(2)`).
  - Jupiter: every address lookup table is read from both endpoints, the wallet sets its own
    compute budget, only System, Token, Token-2022, ATA and Jupiter programs are allowed, and the
    message must fit 1232 bytes.
  - Across: SpokePool addresses are compile-time constants, the depositor and recipient are the
    account, and the fill deadline is at most two hours after the quote.
  - Native staking derives stake accounts as `stake:<n>` seeds of the account and reads the
    minimum delegation from RPC; Lido checks pause and stake limit and splits withdrawal requests
    into chunks of at most 1000 ETH.
- `@qntx/wallet-engine`: read facades `delegation(account, network)`, `swaps.quote` (provider
  union `"0x" | "jupiter"`), `bridges.quote` / `bridges.status`, `staking.positions` /
  `staking.validators` and `lido.position`, all display-only.
- `@qntx/wallet-engine/connect`: EIP-5792 v2.0.0 `wallet_getCapabilities`, `wallet_sendCalls`,
  `wallet_getCallsStatus` and `wallet_showCallsStatus`. Two or more calls become one atomic
  `evm-batch` when the account is or can be delegated, otherwise a sequential path, or `5760` when
  atomicity is required; a call addressed to the account itself is refused.
- `@qntx/wallet-engine`: watch-only accounts (`engine.watch.add` / `rename` / `remove` / `list` /
  `assets`) for EVM, Solana and Bitcoin addresses. `WatchAccount` is not an `AccountRef`, so no
  signing path accepts one; duplicates and the wallet's own derived addresses are refused, and dApp
  connections never expose them.
- `@qntx/wallet`: imported private keys (`keys.import` / `list` / `remove` / `export`, state
  `importedKeys`). EVM takes a 32-byte secp256k1 key, Solana a 32-byte seed or a 64-byte keypair
  whose public half is checked. Each key is its own encrypted `key` vault record with a `keyId`
  derived from its family and public key; duplicates and addresses of the first 20 groups of any
  mnemonic wallet in the vault are refused. Removal and export require factor verification.
  `chain.sign` takes `{ kind: "imported", keyId, family }` for EVM and Solana, and the host checks
  every signature against the key's listed address. Cloud backups carry imported keys and restore
  re-derives each `keyId`.
- `@qntx/wallet-engine`: `engine.keys` and `AccountTreeController.imported()`. Imported EVM and
  Solana keys sign every internal request (sends, approvals, swaps, bridges, NFT sends, staking,
  7702 delegation and batches, speed-up and cancel); one resolver checks the key is listed and of
  the request's family before any chain read. Imported keys are listed beside the HD tree, never as
  group members, and are not offered to dApp sessions.
- `apps/gateway`: `GET /v1/quotes/swap` (0x, `ZEROX_API_KEY`, optional `ZEROX_FEE_RECIPIENT` /
  `ZEROX_FEE_BPS`), `GET /v1/quotes/swap/solana` (Jupiter `/build`, optional `JUPITER_API_KEY`) and
  `GET /v1/quotes/bridge` (Across). Upstream 400/403/422 map to `invalid-request`; 401, 429, 5xx
  and malformed bodies to `unavailable`.

### Changed

- **BREAKING** `@qntx/wallet-chains`: `decodeEvm(request, signer, table)` and
  `verifiabilityEvm(request, signer)` take the signer. Typed data whose `verifyingContract` is the
  signer, the MetaMask DelegationManager or the ERC-4337 v0.8 EntryPoint is refused with
  `invalid-request`; the kernel applies the refusal on both signing passes.
- **BREAKING** `@qntx/wallet-chains`: `ApprovalChange.via` is `permit2 | allowance-holder`;
  `ApprovalChange` gains `stake-authority`; `IntentSummary` gains `stake` and `bridge`;
  `DisplayIntent` gains `minimumReceived`, `staking` (native stake and `lido-*` actions), `bridge`
  and `delegation`.
- **BREAKING** `@qntx/wallet-chains`: NFT flows carry `AssetAmount.tokenId`. ERC-721 is
  `amount: "1"` with the id in `tokenId`; ERC-1155 carries the quantity in `amount`, and a batch
  emits one flow per id and value. Token ids no longer appear as amounts in prompts or risk totals.
- **BREAKING** `@qntx/wallet-engine`: `EngineOptions.showCallsStatus` is required;
  `ChainRequestMethod` gains the internal requests above.
- **BREAKING** `@qntx/wallet-engine`: a tracked transaction's EVM build record is
  `{ from, account, raw }` with the signing `AccountRef`, so replacements of imported-key
  transactions sign with the same key. Records without `account` are dropped as malformed on load.
- **BREAKING** `@qntx/wallet`: system prompts gain `export-private-key` and `remove-private-key`.
- CI runs the Solana e2e suite on Agave 4.4.0 (Stake program v5).

### Fixed

- `@qntx/wallet-chains/solana`: v0 lookup accounts resolve every table's writable entries before
  the readonly ones; multi-table messages previously showed wrong addresses. An unrecognised
  instruction in a lookup-table message is `opaque` again instead of `partial`.
- `@qntx/wallet-chains/solana`: a system transfer's outflow uses the instruction's source account
  instead of the fee payer.
- `@qntx/wallet-engine`: a stake-authority grant to another account is a `danger` on the dApp
  Solana sign path.
- The bitcoin e2e Esplora container waits for bitcoind before creating its wallet (start-up race).

## [0.12.0] - 2026-11-08

One PSBT can spend inputs of several Bitcoin templates of a wallet group, as inscription purchases
do, and `@qntx/nostr` moves to 0.15.4.

### Changed

- **BREAKING**: `bitcoin.psbt` requests name a wallet group (`account: { kind: "hd", walletId,
  groupIndex }`) and give every input to sign its own BTC template (`sign: { index, template }[]`,
  normalized to ascending index) instead of an `AccountRef` and bare input indices; `bitcoin-sign`
  PSBT requests take a `BitcoinGroup`. bip86 entries need `tapBip32Derivation`, the others
  `bip32Derivation`. The kernel checks each input under its entry's template and binds outputs of
  any purpose of the group as own; the main runtime verifies each signature against that
  template's xpub. The engine drops the mixed-purpose refusal, and dApp PSBT preparation scans only
  the signing templates and adds derivation data to outputs paying the group's own scripts.
- Pin @qntx/nostr 0.15.4.

## [0.11.0] - 2026-11-07

Precise error codes for unusable unlock factors, so hosts can tell users the real remedy instead of
always asking for a device passcode (qntx/social#275), plus a platform diagnostic on every error.

### Changed

- **BREAKING**: `WalletErrorCode` drops `factor-unavailable`, which collapsed every keystore and
  passkey platform failure into one bucket. Three precise codes replace it, and every remaining
  site moved to an existing code:
  - `no-device-credential` — the device has no passcode or lock screen, so a hardware factor
    cannot exist. iOS: `LAErrorPasscodeNotSet` from `canEvaluatePolicy` (keystore seal, open and
    authenticate). Android: `KeyguardManager.isDeviceSecure()` false or
    `BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL`.
  - `passkey-not-configured` — no passkey provider is set up (iCloud Keychain off, no credential
    provider). iOS: `ASAuthorizationErrorNotHandled` and 1010
    (`DeviceNotConfiguredForPasskeyCreation`). Android: `CreateCredentialNoCreateOptionException`
    and the `*ProviderConfigurationException` pair.
  - `passkey-prf-unsupported` — the authenticator cannot produce PRF output (`prf.enabled =
    false`, a ceremony that returns no PRF results, the kernel's "does not support the PRF
    extension" rejection, the browser and software-passkey hosts).
  - `unsupported` — the platform cannot do this at all (iOS < 18 passkeys, `*UnsupportedException`
    and `NotSupportedError` on Android, a hardware factor on a non-RN host, a passkey ceremony
    where the platform runs them elsewhere).
  - `not-found` — the vault has no hardware factor ("no hardware factor exists").
  - `unavailable` — every other platform failure (Secure Enclave / Keystore key or access-control
    creation, `ASAuthorizationErrorFailed`/`NotInteractive`, no key window, unrecognised Android
    exceptions).

### Added

- `WalletError.detail`: an optional `"<domain>:<code>"` diagnostic (e.g. `"LAErrorDomain:-5"`,
  `"NSOSStatusErrorDomain:-34018"`, `"ASAuthorizationErrorDomain:1004"`,
  `"android:KeyPermanentlyInvalidatedException"`) that rides the error frame from the platform
  through the kernel to the host. Producers emit domain/code tokens only — never userInfo,
  localized text or account names — and anything off-shape is dropped at the producer and
  rejected by the protocol validator (≤80 chars, `^[A-Za-z0-9_.:-]+$`).

## [0.10.0] - 2026-11-05

Signature safety and fund correctness from the code-level audit against MetaMask, Rabby, OneKey and
Uniswap: message content and Sign-In with Ethereum/Solana binding, EIP-712 permit, Permit2, Seaport
and Safe recognition, complete approval decoding, per-account blind signing, re-simulation before
signing, EVM drop detection, the OP Stack L1 data fee and ENS names. Adds BIP-39 passphrases and a
Bitcoin Wallet Standard dApp provider. `@qntx/siwx` 0.8.0 is a new dependency.

### Added

- `@qntx/wallet`: BIP-39 passphrases for mnemonic wallets (WD-083). `wallets.importMnemonic` and
  `MnemonicDraft.confirm` take an optional `passphrase` (NFKD, never trimmed, 1–1024 bytes); the
  seed and `walletId` derive from it, so the same words with another passphrase are a separate
  wallet. `WalletInfo.passphrase`. The passphrase lives in the wallet's entropy record; records and
  backups without one keep their bytes.
- `@qntx/wallet-engine/connect`: a Bitcoin Wallet Standard wallet in the injected script with a
  `bip122` connection namespace: `bitcoin:connect` (payment = `btc.bip84` 0/0, ordinals =
  `btc.bip86` 0/0), `bitcoin:events`, `standard:disconnect`, `bitcoin:signMessage` (BIP-322
  simple), `bitcoin:signTransaction` and `bitcoin:signAndSendTransaction`. dApp PSBTs get
  derivation paths only for inputs whose prevout is a scanned address of the account;
  `SINGLE|ANYONECANPAY` is signed only with a same-index output and is a `danger`; inputs of
  inscription-postage size are flagged; mixing payment and ordinals inputs in one request is
  refused for now.
- `@qntx/wallet-chains`: `DisplayIntent.message` carries what a message request signs: text (with
  `signIn` from `parseSignIn`, built on `@qntx/siwx`), hex for non-text bytes, or structured typed
  data (`domain`, `primaryType`, `data`, plus `seaport` / `safe` when recognized).
- `@qntx/wallet-chains`: EIP-712 recognition by exact field lists: EIP-2612 and DAI `Permit`, the six
  Permit2 types at the canonical contract (`PERMIT2_ADDRESS`), Seaport 1.5/1.6 `OrderComponents`
  and Safe `SafeTx` (inner calls decoded, MultiSendCallOnly unpacked).
- `@qntx/wallet-chains`: transaction decoding of `setApprovalForAll`, `decreaseAllowance`, Permit2
  `approve` and `lockdown`, ERC-721 `safeTransferFrom` with data and ERC-1155
  `safeBatchTransferFrom`; `transferFrom` on a built-in token decodes as ERC-20.
- `@qntx/wallet-engine`: request risk for sign-in messages (domain/scheme mismatch refused per
  ERC-4361 outside local development, port, address, validity window, malformed text), permits
  (`permit-approval`, `permit-unlimited`, `permit-long-lived`), approvals (`collection-approval`,
  `unlimited-approval`), Seaport (`order-receives-nothing`, `order-offerer-mismatch`), Safe
  (`safe-delegatecall`, `safe-gas-refund`), blind signing and dApp PSBTs.
- `@qntx/wallet-engine`: per-account-group blind signing (`AccountTreeController.setBlindSigning`,
  device-local, never synced); non-text `personal_sign` and Solana `signMessage` bytes are refused
  (`4200`) unless enabled, and then carry a `blind-signing` danger.
- `@qntx/wallet-engine`: approval re-simulates a request whose simulation is older than 60 s; a
  material change (status, asset set, any asset by more than 5%) returns the request to
  `awaiting-approval` with `SimulationChangedError`.
- `@qntx/wallet-engine`: EVM drop detection: a persisted `evm` build record (sender, group, signed
  raw transaction); a nonce consumed without our receipt settles `replaced` or `dropped`; a
  transaction the node forgot is rebroadcast with backoff and, after 30 minutes unknown to every
  endpoint, `dropped` with its nonce released. Speed-up and cancel work after a restart.
- `@qntx/wallet-engine`: the OP Stack L1 data fee and operator fee on OP Mainnet, Base and their
  testnets (`DisplayIntent.fee.l1Data`), counted in `fee-exceeds-amount`.
- `@qntx/wallet-engine`: ENS names as EVM send recipients and `engine.names.resolve`, resolved on
  mainnet or Sepolia with ENSIP-11 coin types and the ENSIP-19 default, cross-checked between
  endpoints; the outflow shows the name (`AssetFlow.name`).
- Coverage thresholds for every package (ratchet) and fast-check property tests with a weekly fuzz
  workflow.

### Changed

- **BREAKING** `@qntx/wallet-chains`: `ApprovalChange` is an `allowance` | `operator` union.
- **BREAKING** `@qntx/wallet-chains`: `parseTypedData(typedData)` takes only the source;
  `normalizeEvm` refuses a malformed or mismatched `domain.chainId` (`chain-id-mismatch`, the kernel
  refuses it too) instead of warning; recognized permits decode as `approve` / `partial`.
- **BREAKING** `@qntx/wallet-engine`: `RequestController` requires `blindSigning`;
  `SolanaDisplay.message` is a `MessageContent`; typed data whose `verifyingContract` is the signer
  is refused from web pages.
- **BREAKING** `@qntx/wallet`: `wallets.exportMnemonic` resolves `{ mnemonic, passphrase? }`;
  `backup.restore` takes `passphrases` and resolves `{ wallets, passphraseRequired }` (the
  passphrase never enters a backup).
- `@qntx/wallet-engine`: general viem clients disable CCIP-Read (it used the global `fetch`); ENS
  clients use the injected fetch.
- `@qntx/wallet-engine`: the connection controller receives every enabled family's networks.

### Fixed

- `@qntx/wallet-chains`: a bare `"0x"` quantity and empty or garbage PSBT bytes throw `ChainError`
  instead of foreign exceptions (found by property fuzzing).
- `@qntx/wallet-engine`: a dropped original no longer marks its live replacement `replaced`.
- `@qntx/wallet-engine`: the account totals debounce, metadata publish debounce and Spark events
  backoff run on the injected `setTimer` (`AccountTreeController`, `MetaSyncController`,
  `SparkController` and `DepositClaimer` take a required `setTimer`).
- `@qntx/wallet-engine`: the sign log keeps `solana-sign` entries when it reads them back.
- Browser test servers bind the IPv4 loopback (intermittent Playwright start-up timeouts).

## [0.9.0] - 2026-11-04

A local phishing list, transaction simulation and the remaining in-app browser methods
(`wallet_addEthereumChain`, `wallet_watchAsset`, `solana:signIn`), plus hardening from the 0.9
audit: contract-reported token text is shown only when it is safe, pending connection requests are
bounded and expire, and the engine's timeouts and jitter run on the injected timer and random
source. Closes #99, #100, #101 and #102. Includes the 0.8.1 native fix.

### Added

- `@qntx/wallet-engine`: untrusted contract text is checked before it is shown: a watched token's symbol must be printable (no control, bidi or zero-width characters, at most 32 code points) and its decimals an integer in 0..36 or the request fails with `-32602`; a non-ASCII symbol adds a `token-symbol-unicode` warning; simulated asset changes keep an unverified token's `symbol` and `decimals` only when they pass the same checks.
- `@qntx/wallet-engine`: pending connection requests are capped at 64 and expire after ten minutes (`ConnectionControllerOptions.setTimer`).
- `@qntx/wallet-engine/connect`: the remaining browser methods.
  - `wallet_addEthereumChain` answers `4902` for a chain the wallet does not enable, otherwise `null`; a chain outside the session goes through the `network` connection approval without becoming current. The page's `rpcUrls` are validated for shape only and never used.
  - `wallet_watchAsset` (ERC-20) reads `symbol` and `decimals` on-chain in a new factor-free `watch-asset` request, shows them with a `token-impersonation` danger when another built-in token of the chain reports the same symbol, and adds the token on approval. `AssetsController` gains `isTracked` and `tokenMetadata`; `RequestControllerOptions` takes a required `tokens` and `Eip1193HandlerOptions` a required `isTracked`.
  - `solana:signIn` (Sign In With Solana) is registered in the injected Wallet Standard wallet; the message text from `connect/siws.ts` is byte-identical to `@solana/wallet-standard-util` 1.2.0 and bound to the page's host.
- `@qntx/wallet-engine`: transaction simulation for display. Internal EVM and Solana sends, dApp
  `evm.transaction` requests and single-transaction `solana-sign` requests carry a
  `simulation: SimulationOutcome` (`success` with signed `AssetChange`s, `reverted` or
  `unavailable`). EVM uses viem `simulateCalls` with traced asset changes (`eth_simulateV1`, now on
  the gateway allow-list); Solana reads the watched accounts before and after `simulateTransaction`,
  including writable address-lookup-table entries. An `unavailable` result adds the
  `simulation-unavailable` check, a revert the `simulation-reverted` danger, and an outflow above
  what the local decode declares (non-`opaque` decodes only, never Solana lamports) the
  `simulation-mismatch` danger. Token symbols and decimals are `verified` only from the built-in
  tables.
- `@qntx/wallet-chains`: `EVM_NATIVE_ASSET` and `SOLANA_NATIVE_ASSET`.
- `@qntx/wallet-engine`: a local phishing list. The gateway merges the MetaMask `eth-phishing-detect`
  and Polkadot `phishing` lists hourly into hashed deny and allow sets served at
  `GET /v1/risk/lists/phishing` (snapshot, net diff or `current`). The contract
  (`gateway/contract/risk.ts` and `hash-list.ts`) exports `phishingKey`, `phishingHash`,
  `phishingCandidates` and the sorted hash-set operations (`hashList`, `union`, `difference`,
  `applyDiff`, `encodeHashList`, `decodeHashList`) the gateway and the engine share. The engine's new
  `PhishingController` (`engine.phishing`) syncs it hourly, answers `check(url)` synchronously
  (`blocked`, `trusted`, `clear`, `unchecked`) and keeps the origins the user trusts. A blocked
  origin is refused with `4100` by `ConnectionController.checkOrigin`, so every handler and the
  bridge drop its messages; `approveConnection` and request `approve` re-check it, and `prepare`
  refuses it. A trusted origin adds a `phishing-origin` danger finding and an unchecked one a
  `phishing-unchecked` warning to browser-origin requests.
- `@qntx/wallet-engine`: the `publicStore` port for non-secret device data available while locked,
  with `createMemoryPublicStore()` and `openIndexedDbPublicStore({ name })` (unencrypted IndexedDB,
  from `@qntx/wallet-engine/idb`).
- `@qntx/gateway` (staging): a `scheduled` handler and a `RISK` KV namespace for the list; the build is not scheduled until its hosting is decided.

### Changed

- **Breaking:** `WeblnHandlerOptions.now`, `ConnectionControllerOptions.setTimer`, `NetworkController` options `setTimer` and `random` are required; `ConnectionController.request(origin, { kind, namespace?, network?, activate? })` takes an options object; `esplora(endpoints, fetch, { setTimer, random }, timeoutMs?)` takes injected timers and randomness. The engine no longer uses `AbortSignal.timeout` or `Math.random`.
- `@qntx/wallet-chains`: BIP-322 script pushes longer than 252 bytes are rejected instead of mis-encoded.
- `@qntx/wallet-engine`: the Solana and EIP-1193 handlers share one session-event helper and the Solana sign path one request method.
- `@qntx/wallet-engine/connect`: the injected Solana Wallet Standard wallet now conforms to `@wallet-standard/base` and `@solana/wallet-standard-features` (typed, no cast): every feature is versioned `1.0.0`, `solana:signTransaction` and `solana:signAndSendTransaction` declare `supportedTransactionVersions: ["legacy", 0]` and are variadic (N inputs become one host request, one approval), `signMessage` returns `[{ signedMessage, signature, signatureType }]`, `standard:events` `on` returns an unsubscribe function, and each input's `account` and `chain` are forwarded. The handler rejects an account other than the session's (`4100`), an unknown or mixed chain (`-32602`) and a chain the session is not authorized for (`4100`); sign-and-send needs a chain and returns raw signature bytes.
- `@qntx/wallet-engine/connect`: Solana `signMessage` now refuses non-UTF-8 bytes with `4200` like `personal_sign`, and a Solana message request's display carries `message.text` (and `signIn`).
- Sessions must be reconnected to use `wallet_watchAsset` and `solana:signIn`: they are new session methods.
- **Breaking:** `RequestControllerOptions` takes a required `simulateSolana`, and
  `@qntx/wallet-chains` `parseCompiledMessage` returns `lookups` (table address with writable and
  readonly indexes) in place of `lookupCount`/`lookupAddresses`.
- **Breaking:** `EngineOptions.publicStore` is required, and `ConnectionController` and
  `RequestController` take a required `phishing` option.
- `@qntx/wallet-engine`: `engine.unsubscribe()` also stops the phishing list refresh.
- The install-id `fetch` for the gateway moved from `NetworkController` to `gateway/client.ts`.

## [0.8.1] - 2026-11-04

A native wallet can unlock again after it locks, without restarting the app.

### Fixed

- `packages/wallet-native`: after a lock (manual or background auto-lock), a wallet deletion or a
  kernel crash, the next `vault.unlock()` hung forever. A `KernelHost` serves one kernel runtime —
  once it exits, `start()` returns without creating a new one — but `createNativeWallet` passed the
  channel the same host for every respawn. The channel now gets a new host for each spawn.

### Changed

- `packages/wallet-native`: `NativeWalletOptions.host` is replaced by `createHost`, a factory called
  once per kernel runtime. Hosts that passed `host: fake` pass `createHost: () => fake`, creating
  a new fake per call when the test must survive a lock.

## [0.8.0] - 2026-11-04

The wallet and the engine no longer bind a signature verifier: hosts inject `verifyEvent`, so a
native verifier checks each signed event once instead of the pure-JS noble default running first.
The engine registers a Solana Wallet Standard wallet in the injected script, and the WebLN and
NIP-07 providers are in.

### Added

- `packages/wallet-engine` registers a Solana Wallet Standard wallet in the
  injected script (`@wallet-standard/wallet` `registerWallet`), exposing
  `standard:connect`, `standard:disconnect`, `standard:events` change,
  `solana:signTransaction`, `solana:signAndSendTransaction` and
  `solana:signMessage` over the `solana` provider. `Uint8Array`
  fields carry as `{ __bytes: hex }` on the JSON wire.

- `@qntx/wallet-engine/connect`: the in-app-browser EIP-1193/EIP-6963 provider — `injectedScript`
  produces the fixed injected script plus a `__qntxInstall(<ProviderInfo>)` call, and
  `createBrowserBridge` runs in the host's main runtime to carry page `postMessage` requests to a
  real `Eip1193Handler`, with per-origin rate limiting, message bounds and navigation invalidation.
- `@qntx/wallet-engine/connect`: a NIP-07 `window.nostr` in the injected provider — `getPublicKey`,
  `signEvent` and `nip04`/`nip44` encrypt/decrypt — routed through the same bridge to a new
  `Nip07Handler` (`engine.nip07`). A `nostr` connection namespace carries the active identity and a
  per-origin `NostrPolicy`; `signEvent` signs directly when the policy allows, otherwise a
  `nostr-sign` request through the pipeline (forced confirmation for kinds 0, 3, 5 and 10002) and
  `decrypt` additionally needs the `decrypt` grant.
- `@qntx/wallet-engine/connect`: a WebLN `window.webln` in the injected provider — `enable`,
  `getInfo`, `sendPayment`, `makeInvoice`, `lnurl` and `getBalance` (`keysend`, `signMessage`,
  `verifyMessage` and `request` reject in-page as `NotSupported`) — routed through the same bridge
  to a new `WeblnHandler` (`engine.webln`). A `lightning` connection namespace carries the active
  group's Spark account and a per-origin `LightningPolicy`; `sendPayment`/`lnurl` pay through the
  `pay` request pipeline and poll the settled preimage via `SparkController.paymentStatus`,
  `lnurl` pays the service's minimum amount (`minSendableMsat`) — the approval display marks
  it with `amountFromServiceMinimum`. `makeInvoice` goes through the factor-free `webln-invoice`
  request, and `getBalance` additionally
  needs the `balance` grant.

### Changed

- BREAKING: `createWebWallet`, `createNodeWallet` and `createNativeWallet` require a
  `verifyEvent: (event) => boolean` option (added to `WalletOptions`), and `createWalletEngine`
  requires the same `verifyEvent`. The wallet signer used to import `verifyEvent` from
  `@qntx/nostr`, which is bound to the pure-JS noble backend (tens of milliseconds per event on
  Hermes), and ran it on every event the kernel signed; the engine did the same for external-signer
  zap requests and relay metadata documents. Each host now injects the verifier, so an app that
  already verifies events natively checks a signature once. There is no default. Migration: pass
  `verifyEvent` to `createWebWallet`/`createNodeWallet`/`createNativeWallet` and to
  `createWalletEngine` (for example `createEventVerifier(signing)` with `signing` from
  `@qntx/nostr-native`, or `verifyEvent` from `@qntx/nostr` in tests).

## [0.7.0] - 2026-11-03

Seed-only Nostr identities and native iOS passkeys: identities are indexed independently of
account groups, imported and NIP-46 client keys are gone, and wallet metadata is authored by a
dedicated per-wallet sync key (WD-076, Meowl ADR-060). `@qntx/wallet-native` runs passkey
ceremonies with the PRF extension on iOS 18+. Taproot (BIP-86) sends are fixed, and the engine gains dApp
connections with an EIP-1193 provider and Spark to bitcoin L1 transfers. Vaults, the wire protocol
and backups change format with no migration: recreate existing vaults.

### Changed

- BREAKING: the in-app-browser page→host message now requires a `provider` field —
  `"eip1193"` for `window.ethereum` and `"nostr"` for `window.nostr` — and the bridge routes by it;
  a message without it is dropped as malformed.
- BREAKING: `NostrKeyRef`, `nostr.deriveKey`, `nostr.discover` and the `nostr-key` record header
  now carry an `index` (a NIP-06 identity index) instead of `groupIndex`: identities derive
  independently of account groups. `VAULT_FORMAT` 3, `PROTOCOL_VERSION` 2; no migration — existing
  vaults must be recreated. The derived `NostrKeyRef`, `DerivedNostrKey` and the affected method
  params are retyped accordingly.

- BREAKING: wallet metadata documents are now authored by the wallet's dedicated sync key
  (`m/44'/1237'/2147483647'/0/0`); documents authored by identity 0's Nostr key are no longer read.
  `MetaSyncWalletStatus` no longer has an `unavailable` state — every wallet owns a sync key.

### Removed

- `nostr.importKey`, `nostr.generateKey` and `nostr.createNip46ClientKey` are gone (WD-076):
  Nostr identities are seed-derived only — `nostr.deriveKey` / `nostr.discover` against a wallet's
  identity index are the sole way to add one. `NostrKeyRef` has only the `derived` variant,
  `NostrKeyInfo` drops `origin`/`backedUp`, and `nostr.removeKey` takes `{ publicKey }` with no
  factor verification. The backup payload carries wallet entropy only (payload version 2): the
  `importedNostrKeyCount`/`importedChainKeyCount` header fields and the standalone-key restore path
  are removed.

### Fixed

- BIP-86 (Taproot) sends failed at two points: `@qntx/wallet-engine` built the PSBT inputs with a
  31-byte `tapInternalKey`, throwing before signing, and `@qntx/wallet-chains` verified the
  key-path signature against the untweaked internal key instead of the tweaked output key, so the
  host signature check rejected the signed transaction.

### Added

- `nostr(wallet).syncSigner(walletId)` and the `nostr.syncKey` / `nostr.syncSign` /
  `nostr.syncEncrypt` / `nostr.syncDecrypt` kernel methods: every wallet owns a dedicated metadata
  sync key derived at the reserved NIP-06 segment `m/44'/1237'/2147483647'/0/0`, sealed under a
  `nostr-sync-key` record, claimed into its own signer pool on unlock and disposed on lock. It is
  never listed in `nostr.keys`, never exportable and never in the backup payload.
- `@qntx/wallet-engine` metadata sync now authors kind-30078 documents with the wallet's sync key
  rather than its identity-0 Nostr key; a wallet with no derived identity still syncs.
- `@qntx/wallet-engine`: Spark and bitcoin L1 transfers through the request pipeline.
  `{ method: "spark-deposit", account, from, amountSats, fee }` sends from a bitcoin account of the
  same wallet to a fresh Spark deposit address, with the full bitcoin send checks; the broadcast
  transaction carries `sparkDeposit` (persisted) and is claimed automatically once confirmed, with
  backoff, resuming after a restart. `{ method: "spark-exit", account, amountSats, maxFeeSats }`
  exits to the group's next unused `btc.bip84` receive address. Neither is assessed for recipient
  risk, and the Spark network must map to its bitcoin network (`mainnet`, `regtest`).
- `@qntx/wallet-engine`: dApp connections for EVM. `engine.connections` (`ConnectionController`)
  keeps one CAIP-25-style session per `https` origin (network, account and method scopes,
  persisted, dropped after 90 days unused, bound to the active account group through
  `setActiveGroup`) and approves connections by id from a pending queue. `engine.eip1193`
  (`Eip1193Handler`) is the platform-neutral provider: accounts and permissions, `eth_chainId` and
  `wallet_switchEthereumChain`, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4` and
  the read-only RPC list, with EIP-1193 error codes (`ProviderError`) and `accountsChanged`,
  `chainChanged`, `connect` and `disconnect` events. `eth_sign`, `eth_signTypedData` (v1, v3),
  `eth_signTransaction`, `eth_sendRawTransaction` and the deferred `wallet_addEthereumChain`,
  `wallet_watchAsset` and EIP-5792 methods answer `4200`. The request pipeline accepts them as
  `{ method: "evm-sign", origin, ... }` with a `browser` origin: a dApp transaction is rebuilt with
  fresh nonce and fees (its gas only raises the floor), each origin has one request at a time,
  and revoking or switching network voids the origin's unfinished requests. Sign-log entries carry
  the browser origin. A `personal_sign` whose bytes are not UTF-8 text is blind signing, which is
  off by default: it answers `4200` without entering the pipeline. New engine option
  `allowLocalhostOrigins` for development.
- `@qntx/wallet-native`: iOS native passkeys with the PRF extension through `ASAuthorization`
  platform credentials (iOS 18+). The kernel now reads a registration's authenticator data from
  the CBOR attestation object iOS returns, keeps the PRF results of that single ceremony, and
  reports `factor-unavailable` when the authenticator answers `prf.enabled = false`.

## [0.6.0] - 2026-11-03

The request pipeline and the wallet gateway: every fund-moving action in `@qntx/wallet-engine` is
prepared, reviewed and then approved through `engine.requests`; the engine reads chains through the
wallet gateway and cross-checks pre-signing reads against the host endpoints; an address book with
recipient risk checks, a sign log and metadata sync; `@qntx/wallet-native` builds cleanly on Android.

### Changed

- **BREAKING** `@qntx/wallet-engine`: the wallet metadata document is now `v: 2`
  (`{ v, wallet, groups, contacts }`) and `v: 1` documents are no longer read. A remote `v: 1`
  document is reported as unreadable (`corrupt`) and the wallet will not overwrite it. Entries are
  validated strictly; one invalid contact rejects the whole document.

- **BREAKING** `@qntx/wallet-engine`: every Spark, Lightning and cooperative-exit payment now goes
  through the request pipeline. `engine.payments.pay` and `engine.zaps.pay` are removed, and
  `engine.spark` no longer exposes `send`, `payInvoice`, `paySparkInvoice` or `withdraw`. Use
  `engine.requests.prepare({ method: "pay", account, option, ... })` or
  `{ method: "zap", account, zap, maxFeeSats }`, then `engine.requests.approve(id, "pay" | "zap",
  verify)`. Receiving through an LNURL-withdraw moved to `engine.payments.withdrawLnurl(params)`
  and needs no verification factor.
- **BREAKING** `@qntx/wallet-engine`: `transactions.replace` and `transactions.bumpChild` are
  removed, and `requests.prepare` now takes a discriminated input: `{ method: "send", ... }`,
  `{ method: "speed-up" | "cancel", txId }` or `{ method: "cpfp", txId, feeRate }`.
  `requests.approve(id, method, verify)` takes the request's own method. A `PendingRequest` carries
  its `target` (the transaction being replaced or accelerated). Replacement fees are cross-checked
  and merged like a send's, and the replacement floor (+10%, BIP-125 rule 4) is applied after the
  merge; the original must still be unconfirmed at approval, and a transaction can have one
  unfinished replacement request at a time. `fee-exceeds-amount` applies to sends only.
- **BREAKING** `@qntx/wallet-engine`: `transactions.send` is removed. Internal sends go through the
  request pipeline: `engine.requests.prepare(params)` builds, estimates and cross-checks without
  signing and returns a `PendingRequest`; `engine.requests.approve(id, "send", verify)` signs and
  submits it, `engine.requests.reject(id)` drops it. `replace` and `bumpChild` are unchanged.
- `@qntx/wallet-engine`: an EVM nonce is only recorded after a successful broadcast, and Bitcoin
  outputs already held by a pending request or an unconfirmed transaction are no longer selected.

### Added

- `@qntx/wallet-engine`: address-book sync. Every wallet's metadata document carries the whole
  address book; documents merge per entry id, last writer wins (a tie goes to the larger
  serialization, so every device converges). Deletions travel as tombstones, dropped after 90 days;
  entries plus tombstones are capped at 128 (`add` evicts the oldest tombstone, then fails with
  `AddressBookError("limit")`). Entries gain an optional `note` (at most 120 characters), set with
  `add` or `setNote`.
- `@qntx/wallet-engine`: `engine.addressBook` (`AddressBookController`): named recipients per chain
  family (`evm`, `solana`, `bitcoin`, `spark`), validated and normalized (EIP-55 for EVM; bitcoin
  accepted on any known network), persisted in the engine store and cleared on lock.
  `PendingRequest.risk` (`RiskFinding`) flags a first-time recipient (`first-recipient`, warning) and
  a lookalike of a known address with the same first and last four characters
  (`address-poisoning`, danger) for sends and Spark transfers; the known set is the address book plus
  recipients of tracked sends. `requests.signLog()` and `requests.clearSignLog()` expose the
  signature record (`SignLogEntry`): one entry per request that reached a final stage, newest 1000
  kept, without signature bytes.
- `@qntx/wallet-engine`: Spark requests. `PendingRequest.display` is a `SparkDisplay`
  (`family: "spark"`: kind, amount, fee ceiling, receiver, description) for payments, prepared
  before approval with every input check and the LNURL invoice fetch done once; approval refuses
  an invoice that is within 60 seconds of expiry (a Spark invoice must not be expired), and a
  Lightning or exit request whose `maxFeeSats` reaches the amount records `fee-exceeds-amount`.
- `@qntx/wallet-engine`: `RequestController` (`engine.requests`). A request carries the locally
  decoded `display`, a `verification` of `verified` or `unverifiable` with its `checks`, and expires
  after 10 minutes; locking invalidates unfinished requests and frees what they reserved. When the
  gateway heads a network's endpoint list, nonce, EVM fees, Solana priority fees and Bitcoin fee
  rates are read a second time from the host endpoints (`NetworkController.independentClient`,
  `independentSolanaRpc`, `independentEsplora`): the larger nonce and the lower fees are used, and a
  disagreement over 25%, an unreachable second endpoint, a fee ceiling over 2x the independent
  estimate, or a fee not below the amount sent is recorded as a check.
- `@qntx/wallet-engine`: the `gateway` engine option (`{ url, installId }`). At each unlock the
  engine reads `GET /v1/networks` and, for the networks the gateway serves, tries it before the
  host endpoints (EVM and Solana JSON-RPC, Bitcoin Esplora); a network with custom endpoints never
  uses the gateway, and the install id goes only to the gateway's origin. The gateway contract gains
  `/v1/networks` and the `rpcPath` / `esploraBasePath` path helpers.
- `@qntx/wallet-engine/gateway/contract`: the wallet gateway's `/v1` contract (health, JSON-RPC
  forwarding with per-family method allowlists, the Esplora paths the engine uses) as `zod/mini`
  schemas, shared by the engine and the gateway. `apps/gateway` (private) is the Cloudflare
  Workers reference gateway; staging serves testnets only.

### Fixed

- `@qntx/wallet-native`: the Android library no longer applies the React Native Gradle plugin.
  With another `react-native` resolvable from the library directory, the plugin regenerated the
  React Native core specs inside the library and the app build failed with duplicate classes.

- `@qntx/wallet-engine`: Bitcoin UTXO locks were never persisted (the lock store was never
  opened on unlock), so a broadcast but unconfirmed transaction's inputs could be selected again
  after a restart. Locks are now persisted under the transaction id after broadcast.
- `@qntx/wallet-engine`: the Solana network registry carried malformed genesis hashes, so
  `NetworkController.addRpc` rejected every custom Solana RPC.

## [0.5.2] - 2026-11-02

All five packages are on npm with provenance. `@qntx/wallet-engine` and `@qntx/wallet-chains` were
first rejected (`E404`, no trusted publisher) and published by re-running their jobs once the
trusted publishers were configured.

### Fixed

- `@qntx/wallet-native` 0.5.1 was rejected by npm (`E422`): its manifest had no `repository`, and
  npm provenance requires it to match the publishing repository. It now declares the repository
  and its directory, ships `LICENSE-MIT` and `LICENSE-APACHE`, and `check-version` fails any
  published package whose `repository` does not name this repository and its own directory.

## [0.5.1] - 2026-11-02

Only `@qntx/wallet` and `@qntx/wallet-worker` reached npm at 0.5.0 and at 0.5.1; see 0.5.2.

### Fixed

- `@qntx/wallet-native` 0.5.0 never reached npm: the publish job runs each package's own
  `build` then `test`, and the package's build did not build `@qntx/wallet`, so its tests could
  not resolve `@qntx/wallet/nostr`. The build now builds `@qntx/wallet` first. The `files`
  allowlist no longer carries `!` exclusions (the publish workflow requires every entry to exist);
  `android/.npmignore` keeps local Gradle and CMake output out, and `check-native-pack` now reads
  `npm pack`, the packer the publish workflow uses.
- `@qntx/wallet-engine` and `@qntx/wallet-chains` 0.5.0 were rejected by npm (`E404` on publish):
  neither package had a trusted publisher for this repository's `publish-npm.yml`.

## [0.5.0] - 2026-11-02

The React Native host and the three chain families: `@qntx/wallet-native` ships through the
release workflow, the kernel signs EVM, Solana and Bitcoin requests with a fresh system verification per
request, and the engine sends, tracks and replaces transactions on all three chains.

### Added

- `@qntx/wallet-native` (its first release through the tag workflow; 0.4.0 was a manual
  bootstrap publish for trusted publishing): `createNativeWallet` runs the kernel on its own Hermes
  runtime and thread behind the Nitro `KernelHost`, with a native vault file, kernel bytecode
  compiled by the app's own `hermesc` at native build time (manifest SHA-256 checked by the
  build), the background lock, and the native Nostr and Spark backends bound to their C ABIs.
  Secret-bearing capabilities (keystore, passkey, store) are JSI host objects inside the kernel
  runtime and are never registered with Nitro; no Nitro patch is needed in the app. The README
  covers the Expo configuration, passkey domains and vault storage.
- Hardware vault factor: Secure Enclave on iOS and Android Keystore with BiometricPrompt on
  Android (API 30) seal a per-factor KEK. Every unlock, export, deletion, reset, backup enable and
  every `chain.sign` / `spark.approve` opens one system verification whose text the kernel writes
  (zh-Hans or en, from the device locale); ceremonies are serialized, and `vault.reset` verifies
  the device owner first.
- Native passkeys (Android, Credential Manager with the Play services provider): passkey wallet
  creation and restore and the cloud-backup passkey factor run inside the native kernel, so no PRF
  output crosses the main runtime. The backup protection credential is named by the kernel
  (`Cloud backup key` / `云备份密钥`). iOS reports `factor-unavailable` until native iOS passkeys
  land.
- `@qntx/wallet-chains` (bootstrapped on npm at 0.4.0; first release through the tag workflow):
  addresses, request normalization, display decoding,
  verifiability and signing for EVM (transactions, `personal_sign`, EIP-712), Solana
  (transactions, messages, Token-2022 mint extensions) and Bitcoin (PSBT for P2WPKH, P2TR,
  P2SH-P2WPKH and P2PKH; BIP-322 and legacy messages), with built-in Circle USDC and Tether USDT
  token tables.
- `@qntx/wallet/chains`: `chains(wallet).account(...)` derives chain accounts in the kernel
  (`evm.bip44`, `solana.bip44-change`, `btc.bip84`, `btc.bip86`, `btc.bip49`, `btc.bip44`), and
  `chains(wallet).sign(...)` signs after normalization, decoding and a per-request verification;
  the host re-verifies every signature against the account address and rejects forged results
  as `integrity`.
- `@qntx/wallet-engine`: `engine.networks` (EVM, Solana and Bitcoin registries, custom endpoints
  validated by chain id, genesis hash or block 0, ordered failover), `engine.transactions` (EVM
  native and ERC-20 sends with speed-up and cancel; SOL, SPL and Token-2022 sends; Bitcoin sends
  with UTXO locking, RBF speed-up and cancel, and CPFP; persisted lifecycle resumed on unlock),
  `engine.assets` (native and token balances, Multicall3 where deployed, custom tokens marked
  unverified) and account-group discovery across all chain families.

### Changed

- **BREAKING:** on React Native the hardware factor is the only vault factor; password and
  passkey factors are rejected with `factor-unavailable` (the web and Node hosts keep passkey
  and password factors).
- **BREAKING:** `wallet.createWithPasskey`, `wallet.restoreWithPasskey`, `backup.enable` and
  `backup.restore` passkey factors take one of two protocol shapes, `ceremony: "host"` (web) or
  `ceremony: "kernel"` (React Native); the kernel accepts only its platform's shape.
- **BREAKING:** the kernel policy has no foreground idle lock on React Native; the native host
  locks after `autoLock.backgroundSeconds` (0, 60, 300 or 900) in the background.
- `@qntx/spark*` are pinned at 0.5.2 and `@qntx/nostr*` at 0.15.3.
- `@qntx/wallet-engine` and `@qntx/wallet-chains` publish on every release tag through trusted
  publishing, as does `@qntx/wallet-native`.

### Removed

- **BREAKING:** `NativeWalletOptions.ceremony`: the hardware factor mode runs every passkey
  ceremony inside the kernel, so a host `PasskeyCeremony` was never invoked.

### Fixed

- `@qntx/wallet-engine`: Bitcoin account discovery could deadlock. A request that received HTTP
  429 retried while still holding its Esplora concurrency slot, and with all four slots
  throttled every retry waited on itself; the slot is now released before backing off. Esplora
  requests are also bounded by a timeout.
- `@qntx/wallet-chains` no longer bundles `@noble/curves`, `@noble/hashes` and `@scure/base`;
  they are exact-pinned dependencies, and every published package's `vp pack` externals all
  imports with a `check-dist-deps` gate in `check:pkg`.
- Playground: UI clicks queue behind the wallet boot.

## [0.4.0] - 2026-10-29

### Changed

- **BREAKING:** `@qntx/spark` is pinned at `0.5.0` in the kernel and the optional peer range is
  `^0.5.0` (was `^0.3.0`). Spark 0.4.0 adds `transfers.history` and renames the invoice payload
  type to `SparkInvoicePayment`; 0.5.0 replaces `addressToScript` with the network-strict
  `bitcoinAddressScript`, which the kernel now uses to bind exit approvals to the account's
  network. The worker ships the matching `spark.wasm`.

### Fixed

- `@qntx/wallet-worker`: the Web host spawns the kernel with the literal
  `new Worker(new URL("kernel.worker.js", import.meta.url))` form. With a precomputed URL,
  bundlers (Vite, webpack) copied `kernel.worker.js` as a single asset without its split chunks,
  so the worker died loading its first import and `createWebWallet` rejected with "the kernel port
  died before its first status" in every bundled app.

## [0.3.0] - 2026-10-28

The E0 hardening series (#91–#108): the vault is fail-closed, cryptographically authenticated,
race-safe across tabs, and resistant to storage tampering, factor misuse, session expiry,
request abuse and cross-host stale state.

The E1 series (#3–#10): the Spark signer runs inside the enclave behind per-outflow approvals,
the Nostr backend is injected, cloud backup keeps a vault-sealed encryption key, and the
@qntx/wallet-engine package lands (controllers, Spark, Lightning zaps, BackupController) —
engine is in this repository but not yet published to npm.

### Added

- `@qntx/wallet/spark`: `spark(wallet)` returns a proxy Spark interface — `signer(ref)` gives a
  per account-group/network `SparkSigner` whose signatures happen inside the enclave over the
  injected `spark.wasm` (ABI version checked at kernel start, hash recorded in
  `dist/kernel.manifest.json`). The Spark runtime loads on first use, so a Nostr-only session
  never fetches it and the initial kernel is smaller (#3, #4).
- `spark(wallet).approve({ account, intent, verify })` registers a 60-second single-account
  outflow approval: `verify` re-verifies the session factor as in `exportMnemonic`, the kernel
  decodes the intent itself, and spends without a matching live approval fail
  `approval-required`. Approvals clear on lock (#3).
- Cloud backup: `wallet.backup.enable({ verify, factors })` retains a 32-byte BEK sealed as the
  vault `backup-key` record, `wallet.backup.update()` rewrites the XChaCha20-Poly1305 envelope
  with one fresh payload nonce and no factor ceremony, `wallet.backup.disable()` deletes the
  key, and `wallet.backup.restore({ envelope, backupFactor, factor? })` merges into the vault —
  adopting the BEK only while the restore establishes it. `parseBackupHeader(envelope)` exposes
  the public header, `BackupInfo`/`WalletSnapshot.backup` the key summary, and fixed vectors pin
  the enable record, factor entries and update envelopes byte-for-byte (#9, #10).
- `@qntx/nostr` 0.15 `NostrBackend` injection: the host supplies the backend (Wasm or native) —
  the kernel never loads signing implementations itself (#4).
- `@qntx/wallet-engine` (not yet published to npm): controllers with Zustand stores, an
  encrypted `EngineStore`, `SparkController` (Spark accounts, sends, Lightning receives,
  cooperative exit), `BackupController` over an injected `CloudStore`, and LNURL zap payment
  wiring plus the web playground under `apps/playground` (#5, #8).
- Tooling: the root scripts build consumed workspace packages once — per-package lint/typecheck/
  test scripts are build-free; the playground's Playwright spec joins the browser suite.
- `WalletSnapshot.vault` reports `unsupported` (written by a newer build — update the app) and `unavailable` (transient store failure — retry) alongside `corrupted`; `lockReason` reports `invalidated` when another tab's factor change rotated the vault DEK. New `WalletError` codes: `wrong-passkey`, `conflict`, `unsupported`, `unavailable` (#92, #93).
- `NostrKeyInfo.backedUp` on standalone keys (nsec/ncryptsec/generated): imported keys report `true`, generated keys `false`, and a successful `nostr.exportKey` re-seals the record with `backedUp: true` (#102).
- `@qntx/wallet/host`: `PASSKEY_PURPOSE_WALLET`/`PASSKEY_PURPOSE_VAULT` and `PrfResult.userHandle`; the WebAuthn ceremony returns the assertion's `userHandle` (#95, #101).
- `@qntx/wallet-worker`: `dist/kernel.manifest.json` records the protocol version, vault format, each pinned kernel dependency's bun.lock integrity and the SHA-256 of each worker bundle (#107).
- `vectors/records.json` and `vectors/protocol.json` fix the public-header/vault-meta layouts and the wire-protocol shapes (#107).
- CI runs `check:pkg` (publint + attw) and v8 coverage on pull requests; browser tests run on WebKit and Firefox for the specs that do not need the CDP virtual authenticator (#108).
- `ConnectOptions.presence`: the host injects a user-activity source; the wallet throttles it to one `session.touch` per 30 s and only while a session exists. On the Web the source listens for pointer, key, wheel and touch input plus `visibilitychange` back to `visible`.
- Browser tests now run against the production `vite build` + `vite preview` output as a `chromium-build` project alongside the dev server.
- `createSoftwarePasskey(seed, { synced })` — `synced` defaults to `true`; pass `false` to exercise a device-bound credential.

### Changed

- **BREAKING:** `PasskeyConfig` gains a required `backupSalt` — passkey backup factors run the
  WebAuthn ceremony with `prf` over it, distinct from `vaultSalt`/`walletSalt` (#9).
- `@qntx/wallet` peer dependencies: `@qntx/nostr` `^0.15.0` and `@qntx/spark` `^0.3.0`, both
  optional (the kernel pins them exactly at `0.15.0` and `0.3.0`) (#3, #4).
- **BREAKING:** the vault store is format 2 — atomic revision-guarded commits, authenticated public headers and factor wrap v2 (each factor header carries an X25519 `publicKey`). Vaults written by older builds report `unsupported` (#92, #93, #100).
- **BREAKING:** `wallet.vault.lock()` resolves immediately on the host and terminates the worker — it no longer waits on the kernel queue; kernel calls time out instead of hanging (#97).
- **BREAKING:** `restoreWithPasskey` rejects assertions whose `userHandle` is missing or not wallet-purpose (`wrong-passkey`); `connectKernel` validates `PasskeyConfig` — non-empty `rpId`/`rpName`, distinct salts — synchronously before spawning (#95, #101).
- Changing the password or removing a factor rotates the vault DEK and invalidates sessions in other tabs (they lock with reason `invalidated`); adding a passkey factor keeps the current DEK (#96, #100).
- ncryptsec exports always carry NIP-49 key-security byte `0x02`; imports prevalidate the bech32 payload before scrypt runs, cap `logN` by policy (18 on Web, 20 on Node) and map failures precisely — `invalid-input`, `unsupported`, `unavailable` or `wrong-password` (#106).
- Requests are capped at 1 MiB, measured on the whole message envelope and enforced on both sides of the channel (#104).
- Every `@qntx/wallet-kernel` runtime dependency is an exact pin; `scripts/check-version.ts` fails unless each pin equals what `bun.lock` resolves (#107).
- **BREAKING:** `WalletInfo.backedUp` is replaced by `WalletInfo.backup` — `"mnemonic"`, `"passkey"` or `"none"`. Passkey wallets report the credential's real sync state (WebAuthn BE/BS flags on the Web); `exportMnemonic` upgrades the record to `"mnemonic"`. Standalone Nostr keys keep `backedUp`.
- **BREAKING:** `PrfResult` gains `synced`, and `wallet.createWithPasskey`/`wallet.restoreWithPasskey` carry it into the kernel.
- **BREAKING:** the kernel's idle model is presence-based on the Web (`KernelPolicy.activity`): signing and background requests no longer refresh the idle timer — user presence, `session.touch` and factor/user-facing operations do; the 12 h maximum is unchanged. Node keeps request-based activity. Failed requests never count as activity.
- **BREAKING:** the channel watchdog times only the queue head — a request queued behind a slow head is no longer timed while it waits; the head gets 60 s before the port is replaced. `MAX_BATCH` drops from 256 to 64 and `nostr.unwrapGiftWraps` accepts any number of events, chunking internally.
- **BREAKING:** the hidden-page 5-minute lock is removed; `pagehide` still locks and the idle timer is presence-driven.

### Fixed

- `wallet.vault.unlock` holds the `unlocked` status until the session is actually installed,
  and re-unlocking with the same `keyId` reuses the live session instead of minting and
  invalidating a new one (#8).
- Password unlock is rate-limited inside the kernel: five counted failures arm a 30 s/60 s/300 s backoff, a `rate-limited` error carries `retryAt`, retries during backoff do not push the deadline, and passkey unlocks are never gated by password backoff (#91, #99).
- Vault-health classification no longer conflates corruption with transient I/O failure or newer-build data; a corrupted vault invalidates the live session immediately (#93, #94).
- Concurrent commits from two tabs resolve to exactly one writer — `expect-revision` guards make the loser a `conflict`, so a factor can never be lost (#92).
- Session deadlines (idle 5/15/60 minutes, fixed 12 h maximum) are owned by the worker and measured on a monotonic clock — a wall-clock jump cannot extend or shorten a session (#98).
- Live state is a function of the authenticated store image: key imports, deletes and wallet removals reconcile across tabs without re-unlock; a tampered record or planted factor row corrupts the vault (#96).
- IndexedDB `versionchange` closes the worker's connection so a newer-version open is never `blocked`; once the database is newer than the schema the vault reports `unsupported` (#105).
- The Node store's precondition failures surface `conflict` and RPC failures `unavailable` — never a hang.
- Shape validators and header parsers check own properties only — inherited names cannot satisfy or forge a field, and a missing required key is still reported missing (#103).
- A wrong passkey now consistently reports `wrong-passkey` — unlock, factor verification, and credential mismatches — instead of `integrity`.
- A stored Nostr key record whose authenticated plaintext does not match its record id latches the vault `corrupted`.
- `dataKeys.get` documentation corrected: the data key is random per vault — created on first use, stable across lock/unlock and DEK rotation, lost on reset or restore to another device; callers must be able to rebuild from it.

## [0.2.0] - 2026-10-15

### Removed

- **BREAKING:** `WalletOptions.logger` and the `WalletLogger` type — the option was declared but never wired to anything.

## [0.1.0] - 2026-10-15

### Added

- `@qntx/wallet`: the host-facing `Wallet` — an immutable snapshot for `useSyncExternalStore` (`uninitialized`, `locked`, `unlocked`, `corrupted`), core vault/wallet/data-key APIs, and one `WalletError` with typed codes. `@qntx/wallet/nostr` is the Nostr protocol module: `nostr(wallet)` returns key derivation/import/generation, guarded export and removal, and proxy Nostr signers whose results are verified on the main thread — the root entry never pulls `@qntx/nostr`. `@qntx/wallet/protocol` defines the strictly validated enclave protocol; `@qntx/wallet/host` is for host packages only.
- `@qntx/wallet-worker/browser`: `createWebWallet` runs the kernel in a module Worker with an IndexedDB vault, Web Locks and cross-tab change notifications, and performs the WebAuthn PRF ceremony on the main thread. Locking terminates the Worker.
- `@qntx/wallet-worker/node`: `createNodeWallet` runs the same kernel in `worker_threads`, with the test-only `createSoftwarePasskey`.
- The kernel: BIP-39 (random with a backup quiz, import, export), passkey wallets (PRF output as BIP-39 entropy), BIP-32 and NIP-06 derivation, `walletId`, an XChaCha20-Poly1305 vault whose public headers are authenticated and record-kind agnostic (an unknown kind reports `corrupted` rather than silently dropping data), password and passkey factors with online rate limiting, sessions with idle and absolute limits, a statically composed Nostr module (derived keys, nsec, ncryptsec, generated, NIP-46 client; NIP-04, NIP-44 and batched NIP-59 unwrapping).

[Unreleased]: https://github.com/qntx/wallet/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/qntx/wallet/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/qntx/wallet/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/qntx/wallet/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/qntx/wallet/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/qntx/wallet/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/qntx/wallet/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/qntx/wallet/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/qntx/wallet/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/qntx/wallet/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/qntx/wallet/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/qntx/wallet/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/qntx/wallet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/qntx/wallet/releases/tag/v0.1.0
