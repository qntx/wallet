# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A `vX.Y.Z` tag runs `publish-npm.yml` (publishing `packages/wallet`, `packages/wallet-worker`, `packages/wallet-engine`, `packages/wallet-chains` and `packages/wallet-native` via npm trusted publishing / OIDC). `@qntx/wallet-kernel` is private and only bundled into the host packages.

## [Unreleased]

Hardening and reach. The vault moves to format 6: an authenticated manifest, and a vault anchor
outside the store that floors the revision and rate-limits password attempts, so a rolled-back
store cannot replay an old vault. The kernel signs what it can describe and refuses what it
cannot show unless the owner allows blind signing, broadcasts whose outcome is unknown are never
failed, and the cloud-backup password is stretched with Argon2id. React Native gains a silent
`device` factor and an optional app lock. TRON joins EVM, Solana and Bitcoin as a fourth chain
family, the EVM table grows to 41 mainnets, and Solana v1 transactions are supported.

Signing is split into plan → backend → assemble, and the same plans now run on external signers:
`WalletInfo` becomes a `custody` union (`vault`, `hardware`, `card`). Hardware wallets pair and
sign through the kernel — Keystone 3 Pro over QR, Ledger and OneKey over USB or Bluetooth — and
every pinned key stays unconfirmed until the device shows it. qntx card wallets (React Native)
keep the seed only on one to three NFC cards; this release pins no production card anchor, so
every card is refused as `card-not-genuine` until a later release ships it. A QR signer mode
answers a watch-only counterpart's animated UR requests through the ordinary approval pipeline.

The engine adds fiat prices, per-group activity history, Bitcoin coin control, Spark tokens,
an approvals inventory with revocation, an NFT inventory with transfer requests, push
notifications through the gateway, iCloud and Google Drive backup transports with versioned
backup files, WalletConnect, and opt-in apps: Hyperliquid, whose L1 actions are signed by a
kernel-held session key metered against limits the owner approved; Polymarket; and Fiat24 on
Arbitrum One.

Upgrading is not data-preserving. Vaults written by 0.13.0 (format 3) are `unsupported` and must
be reset, 0.13.0 cloud-backup files can no longer be read, and the engine database is rebuilt
empty. Wallets come back only from their mnemonic, a passkey, or a cloud backup made after the
upgrade. Upgrade every `@qntx/wallet*` package together and deploy the gateway from this release
with the apps. [MIGRATION.md](MIGRATION.md) lists every change a host has to make; each breaking
change below names its section.

### Breaking changes

Vault, backup and storage:

- Vault format 6 and protocol version 3. A `manifest/default` record, rewritten in every
  structural commit, commits under the DEK to the format, the revision, the keyId and every other
  record and factor row; a replayed, dropped, added or altered row, a rewritten format or
  revision, or duplicate keys latch the vault `corrupted`. Vaults of any other format, including
  every 0.13.0 vault (format 3), are `unsupported` and must be reset; there is no upgrade path.
  `vault.reset()` of an open, healthy vault requires its live session. (MIGRATION §1)
- The vault anchor. A 21-byte record the kernel keeps outside the vault store holds the revision
  floor and the password failure counters (`vectors/vault-anchor.json`): React Native keeps it in
  the platform credential store (an iOS keychain item, `WhenUnlockedThisDeviceOnly`; Android
  Keystore entry aliases), the Web in Cache Storage beside the IndexedDB vault, Node in the main
  thread beside the in-memory store. An image whose revision is below the floor — an older
  committed vault put back — reads `corrupted` before any unlock; only a revision the kernel
  sealed or authenticated under a session raises the floor; a new vault starts above it and a
  reset raises it past the erased image. The failure counters left the vault meta
  (`record-failure` / `reset-failures` are gone from the store), so rewriting the vault store no
  longer resets the password backoff. SECURITY.md states what each host can and cannot detect.
  (MIGRATION §1)
- Cloud backup: the password is stretched with Argon2id (RFC 9106 second recommended option:
  64 MiB, 3 passes, 4 lanes) instead of PBKDF2-SHA256 and must have at least 12 characters;
  `BackupController.enable` also refuses a password below zxcvbn's top score (`weak-password`).
  Envelope version 3 authenticates the factor list; version 1 envelopes — every backup written by
  0.13.0 — are not read. An establishing `backup.restore` adopts the envelope's backup key only
  when a kernel passkey ceremony (React Native) unwrapped it; otherwise backup stays off until
  `backup.enable`. `backup.disable(verify)` re-verifies. (MIGRATION §8)
- `@qntx/wallet-engine/idb`: engine database format 2. Rows are named by an HMAC of their
  collection and key under HKDF subkeys of the data key; an existing database, or one keyed by
  another data key, is rebuilt empty on open. `EngineCollection.get` resolves `undefined` for a row
  the store cannot authenticate, and `EngineErrorCode` loses `"integrity"`. (MIGRATION §1, §13)

Factors and the React Native host:

- Every `verify` parameter is `VerifyFactor` (`UnlockFactor` without `device`); `{ kind: "device" }`
  is rejected as `invalid-input`. React Native vaults are created with the silent `device` factor
  plus, when the device has a lock screen, the `hardware` factor; `factor` on create / import /
  restore and `vault.addFactor` / `vault.removeFactor` are `unsupported` there, and `InitialFactor`
  loses its `hardware` arm. A guarded call without a `hardware` factor fails
  `verification-unavailable` (error code `no-device-credential` is removed). Removing the lock
  screen no longer destroys the vault while the `device` factor exists, unless app lock is on.
  (MIGRATION §3, §13, §14)
- `@qntx/wallet-native` admits one live kernel runtime per process: creating a second native wallet
  while another's kernel is live fails `integrity`. (MIGRATION §3)

Signing and requests:

- Blind signing is a vault setting enforced in the kernel (`wallet.vault.setBlindSigning(enabled,
  verify)`, `snapshot.blindSigning`), off on a new vault and not part of a backup; the per-group
  engine flag (`AccountTreeController.setBlindSigning` / `blindSigning`,
  `AccountGroup.blindSigning`) is removed. A request is described only if what the prompt prints
  bounds what the signature authorises: requests the wallet can describe but not verify (an
  unknown contract call, unrecognised typed data that fits the display, undecodable Solana
  instructions, a multi-party PSBT) sign without the setting with a "cannot verify" line and the
  `decode-partial` check, and only requests a decoder marks blind need it — raw bytes and hazardous
  text (32 bytes, hidden or reordering characters, encoded bytes), typed data that signs only
  hashes or is a near miss of a recognised family, undecoded core-program Solana instructions the
  signer signs, an unrecognised function of a built-in token, calldata to the signing account
  itself, a Safe `delegatecall` outside MultiSendCallOnly, a Safe transaction with a gas refund.
  dApp blind requests are no longer refused at `prepare` (no more `4200`): they become pending
  requests with the `blind-signing` danger, and `approve` throws `BlindSigningDisabledError` while
  the setting is off. (MIGRATION §5, §18)
- `@qntx/wallet-engine`: `requests.approve(id, method, { verify, acknowledged })` replaces the
  positional `verify` and refuses a request with `danger` findings or recorded checks unless
  `acknowledged` names exactly those codes, including findings a re-simulation adds at approval
  (`AcknowledgementRequiredError`). (MIGRATION §4)
- `@qntx/wallet-chains`: `IntentWarning.kind` is the closed union `IntentWarningKind`;
  `evm.typed-data` must declare `types.EIP712Domain` and nests at most 32 levels; EIP-1559/7702
  transactions with `maxPriorityFeePerGas` above `maxFeePerGas` are rejected; `bitcoin.psbt` inputs
  signed under `btc.bip44`, `btc.bip49` or `btc.bip84` need `nonWitnessUtxo`, a fee is computed only
  from proven input amounts, and PSBTs whose outputs exceed their proven inputs are rejected;
  BIP-322 simple signatures now match the official vectors, so signatures made by 0.13.0 no longer
  verify; `SafeTransaction.refund` is `{ receiver?, gasPrice, amount }` (`gasToken` /
  `refundReceiver` are removed) and `SignInParse` `malformed` carries `claims`. (MIGRATION §13,
  §15, §18)
- `@qntx/wallet-chains/bitcoin`: `decodeBitcoinPsbt` takes a `BitcoinOwn`
  (`{ change, unusual, unconfirmed }`) as its second argument — an own-key output is hidden as change only when the wallet can
  discover it (the group's `/1/i` key with `i ≤ mark + BITCOIN_GAP_LIMIT`, a script type a signed
  input shares); every other own-key output is a verified outflow whose `AssetFlow.ownPath`
  carries its `m/…` path, plus an `unusual-own-output` `IntentWarning` surfaced to the user as the
  `bitcoin-unusual-output` warning finding. An output whose key a never-confirmed device entry
  serves is in `unconfirmed`: an ordinary send plus an `unconfirmed-signer-output` danger warning
  (`bitcoin-unconfirmed-output` danger finding), never hidden and never an own-address row.
  `mark` is a kernel-sealed per-(wallet, group, purpose, network) change mark in a `change-marks`
  vault record (`ChainAccount.changeMark`), raised before signing — only for a request that
  declares `origin: "internal"` — to the highest hidden change index and the highest same-purpose
  change index of the signed inputs. An external request may hide change inside the current
  window but never raises the mark, so a crafted PSBT cannot park change at an index the wallet
  never scans, nor ratchet the scan with signatures it never broadcasts; a seed-only restore
  starts the mark at 0. `bitcoin.psbt` requests therefore carry a
  required `origin` (`"internal" | "external"`): the engine sets it for its own sends, every other
  caller passes `"external"`, and a request without it is refused. The engine's own change
  selection obeys the same rule: change lands on the spending template's own chain at
  `min(first unused, mark + BITCOIN_GAP_LIMIT)` — `btc.bip44`/`btc.bip49` sends no longer migrate
  change to native segwit. (MIGRATION §34, §35)
- `@qntx/wallet-engine`: `TransactionController.nextReceiveAddress` returns
  `{ address, confirmed }` instead of the address string. (MIGRATION §35)
- Kernel prompts render every warning row before the detail rows, and a bounded prompt drops only
  detail rows — a request whose warnings alone cannot fit the dialog is `unsupported` even with
  blind signing on. `@qntx/wallet-native` locks the session after 15 idle minutes, and on every
  keystore host (React Native, Node with a keystore) only a successful factor verification
  re-arms the idle deadline — `session.touch` and other presence-marked methods do not, so a
  compromised main runtime cannot hold the vault unlocked; on the Web presence-marked methods
  still count. (MIGRATION §34, §35)

Transactions:

- `@qntx/wallet-engine`: a send, speed-up, cancel or CPFP whose broadcast outcome is unknown
  (transport error, 5xx, timeout) resolves with a `submitted` transaction tracked under its locally
  computed hash instead of rejecting; only a definitive node refusal rejects. The signed bytes move
  from `TrackedTransaction.evm.raw` to `TrackedTransaction.raw` for every family. `RequestStage`
  gains `signed`; `PreparedRequest.submit` and the Spark payment params take a `commit` callback.
  (MIGRATION §7, §13, §14)
- `@qntx/wallet-engine`: `confirmed` is no longer terminal — a transaction in a block stays
  tracked until `final` (EVM `finalized`, six Bitcoin confirmations, Solana `finalized`) and returns
  to `submitted` after a reorg. `dropped` is no longer produced by a timeout: a transaction unseen
  for 30 minutes stays `submitted` with `stuck: true`. (MIGRATION §7, §19)
- `@qntx/wallet-engine`: dApp sign-and-send results carry the locally computed ids of what went
  out (Solana fee-payer signatures, Bitcoin txids), never ids an RPC reports, and a batch that
  stops part-way reports `stopped: { index, reason: "refused" | "not-sent", error }`;
  `bitcoin:signAndSendTransaction` entries are `{ txId, signedPsbt }`. (MIGRATION §19)
- `@qntx/wallet-engine`: `WalletEngine` state snapshots are deeply frozen and typed
  `DeepReadonly`. (MIGRATION §19)
- `@qntx/wallet-engine`: `evm-nft-send` takes `items: [{ tokenId, amount? }]` instead of `tokenId`
  / `amount` (one entry for ERC-721; up to 10 distinct ERC-1155 ids as one batch), and
  `solana-core-send` is replaced by `solana-nft-send` (`asset` is a Core asset or an SPL NFT
  mint). (MIGRATION §13, §26)

Solana:

- `solana-sign` requests carry serialized transactions, as the Wallet Standard passes them, instead
  of compiled messages, and `signedTransactions` keep co-signers' signatures; `normalizeSolana`
  accepts the wallet as any required signer (`ChainErrorCode` `fee-payer-mismatch` is removed), a
  sign-and-send still missing other signatures is refused before the prompt, a compiled message
  with trailing bytes or duplicate compute-budget instructions is rejected.
  `ParsedSolanaMessage["version"]` is `"legacy" | 0 | 1` (v1 carries `config`); versions above 1
  stay `unsupported`. (MIGRATION §6, §20)
- `@qntx/wallet-engine`: dApp Solana transactions are bound to the session's cluster before the
  prompt and fail with `SolanaClusterBindingError` otherwise. Solana testnet sends behind the
  gateway alone are refused (configure `EngineOptions.rpc`); gateway-only mainnet reads carry
  `reads-unverified`. A user-set custom RPC is cross-checked by the host endpoints or the gateway.
  (MIGRATION §20)

Engine options, facades and the in-app browser:

- `@qntx/wallet-engine`: `EngineOptions.gateway` is `{ url }`. The engine sends a fresh random
  `x-client-id` per session and per scope (`evm`, `solana`, `bitcoin`, `tron`, `service`) instead of
  one install id; `EngineOptions.gateway.installId` is removed and the contract's
  `INSTALL_ID_HEADER` / `installId` become `CLIENT_ID_HEADER` / `clientId`. A gateway and an engine
  from different sides of this change refuse each other (`400 invalid-request`). (MIGRATION §2,
  §13, §22)
- `@qntx/wallet-engine`: every `WalletEngine` member is a host facade — its host methods plus a
  read-only `store`. Controller lifecycle and wiring, `store.setState`, `transactions.prepare*`,
  `spark.sendToken` / `claimDeposit` / `inspect`, `transactions.batchById` / `delegationState`,
  `requests.invalidateOrigin`, `connections.request` / `authorize` / `touch`,
  `accounts.exportMeta` / `mergeMeta`, `addressBook.merge` / `syncEntries` and the networks'
  cross-check clients are gone from the engine; controller constructors take new required options
  (`AssetsController` `chains`, `gateway`, `fetch`, `now`; `SparkControllerOptions.random` is
  removed). `engine.bridges.quote` requires `maxFeeBps`. (MIGRATION §2, §13)
- `@qntx/wallet-engine`: `TransactionController`'s `Options.chains` is required — the controller
  signs through the injected apis so an external-custody request routes to its signer; what was a
  test seam defaulting to `chains(wallet)` is a constructor requirement. `createApps`'s `account`
  option and `AppContext.account` are required — an app derives through the same apis; a host
  composing apps without the engine passes `chains(wallet).account`. (MIGRATION §32)
- `@qntx/wallet-engine`: `RequestEndedError`'s constructor takes a third `signed` argument; read
  `error.signed` to tell whether anything may have been broadcast — `false` proves nothing it
  produced was broadcast. (MIGRATION §29)
- `@qntx/wallet-engine`: dApp sessions record the account group (and Nostr identity) they were
  granted and follow the app's group selection; switching group invalidates every pending request.
  `ConnectionController.setActiveGroup`, `activeGroup`, `accounts`, `solanaAccount`,
  `bitcoinAccounts`, `nostrAccount`, the handlers' `solanaAccountsChanged` /
  `bitcoinAccountsChanged` and `activeGroup` option are removed; WebLN takes `sparkNetwork`.
  `RequestOrigin` gains `{ kind: "app", id }`, `{ kind: "qr", declared? }` (a request scanned from a
  QR counterpart) and WalletConnect origins (`DappOrigin`) — every switch on its `kind` must name
  them. The injected
  Solana and Bitcoin providers reject a refused request with `4001` instead of `-32603`.
  (MIGRATION §2, §13, §21, §33)
- `@qntx/wallet-engine/connect`: the injected script generates the EIP-6963 uuid per document
  (`ProviderInfo.uuid` is removed), installs only in the top-level document and tags every bridge
  message; `BrowserBridge.message` must receive the URL of the frame that sent it
  (react-native-webview 13.13.5 or later). `BrowserBridgeOptions` requires a `tron` handler
  (`engine.tronWallet`). (MIGRATION §2, §17)

Backup and the native keystore:

- `CloudStore` loses `available()`; every failure is a `CloudStoreError`. The port's
  semantics (portable names, a 4 000 000-byte text cap, atomic whole-file writes, no partial reads,
  read-your-own-write, eventually consistent but complete lists, delete-missing succeeds) are
  documented on the type and checked by one conformance suite across every implementation.
  Cloud backups are versioned: each upload is a new file
  `qntx-wallet-backup-<id>-<sha256>.json` instead of an overwrite; two devices updating the same
  backup keep both versions, and a version that holds wallets this device lacks reports `conflict`
  without blocking this device's upload. `BackupController.list()` items carry the backup `id`;
  `BackupErrorCategory` gains `quota` and `auth-required` (status `error`). (MIGRATION §28)
- `@qntx/wallet`: `BackupFactorInput`'s password arm is `{ kind: "password"; password?: string }`
  — on React Native the kernel collects the entry through `SecureInput` and a `password` field is
  `unsupported`; on Web and Node it stays required. (MIGRATION §8, §30)
- `@qntx/wallet-native`: the keystore contract gains the required `platform: "ios" | "android"`
  — `bindNativeKeystore` rejects any other value. (MIGRATION §3)

Wallets:

- `@qntx/wallet`: `WalletInfo` is a `custody` union — `wallet.custody === "vault"` narrows to the
  shape 0.13.0 returned (`VaultWalletInfo`); `HardwareWalletInfo` (`custody: "hardware"`) carries
  `device`, `fingerprint`, `supported` and optional `model`/`firmware` but no `origin`, `words`,
  `backup` or `passphrase`, and `CardWalletInfo` (`custody: "card"`) carries `origin`
  (`"card-generated" | "card-imported"`), `backup: "cards"`, `members` and `cards`
  (`CardInfo[]`) — narrow on `custody` before reading any of them. Seed-bound commands answer
  `unsupported` for an external-custody wallet (`exportMnemonic`, Nostr key derivation and sync,
  Spark, `sessions.create`), `chain.sign` answers `device-required`, and `wallet.accounts`
  answers `device-required` for a group the signer has not exported yet. (MIGRATION §24, §30)

Assets, networks and Spark:

- `@qntx/wallet-engine`: Bitcoin UTXOs on taproot addresses or worth at most 20,000 sat are
  protected as possible inscription or rune carriers: sends do not select them unless named in
  `inputs`, and the balance field is `protected` (`AccountBalances.frozen` is renamed). `AssetsController.refreshBitcoin(xpub, network)` is removed
  in favour of `refreshBitcoinGroup`. (MIGRATION §11, §13)
- `@qntx/wallet-engine`: `NetworkInfo.opStack` is replaced by `NetworkInfo.feeModel`
  (`FeeModel`: `execution`, `op-stack` with `operatorFee` and `tokenRatio`, `scroll`; each with
  `pricing: GasPricing`). `DisplayIntent.fee.l1Data` is a maximum (the oracle estimate × (9/8)³),
  re-read at approval and before a late broadcast; `approve` can fail with "the L1 data fee rose —
  start over". (MIGRATION §16)
- The TRON family widens closed unions in every package (`ChainFamily`, `ChainTemplate`,
  `ChainAccount`, `ChainSignRequest`/`Result`, `EngineFamily`, `NetworkInfo.family`,
  `GatewayScope`, history, watch and address-book families). (MIGRATION §17)
- `@qntx/wallet-engine`: Spark payments are idempotent per request and recorded before they are
  sent. `SparkResult` gains `{ kind: "pending", payment }` and `token`; `SparkErrorCategory` gains
  `unknown` and `duplicate`; `SparkControllerError` carries `payment`. A cooperative exit's
  `amountSats` is what arrives (the exit debits `amountSats + feeSats`), `maxFeeSats` is required
  and `SparkDisplay` gains a `token` variant. (MIGRATION §12, §14)

Gateway (operators):

- `GatewayOptions` requires `auth` and `prices: { cache, coingecko? }`; production needs the
  `COINGECKO_API_KEY`, `TRONGRID_API_KEY`, `TATUM_API_KEY` and `ANKR_API_KEY` secrets. An ambiguous
  broadcast answers `502 {"error":"outcome-unknown"}` instead of being retried on the next
  provider. The Solana RPC allow-list drops `getBlock`. A deployed gateway requires
  `cf-connecting-ip`. (MIGRATION §22)

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
- `@qntx/wallet-chains`: `displayExcerpt` (bounded, sanitised display text),
  `messageTextHazard`, `hasHiddenCharacters` and `isEncodedBytes` (whether text is blind and why),
  `messageContent`, `messageBlindReason`, `isBlindIntent`, `BlindReason`, `TypedDataLeaf`,
  `DisplayExcerpt`, `SignInClaim`; `DisplayIntent` gains `blind`, `contract` (with `selector`,
  `symbol`) and `programs` (Solana); typed-data `MessageContent` gains `fields`; `AssetFlow.burn`
  marks an outflow to a provably unspendable Bitcoin output (a script starting with `OP_RETURN` or
  over 10,000 bytes).
- `@qntx/wallet-chains/evm`: `typedDataFields`, `TYPED_FIELD_BUDGET`, `TYPED_FIELD_CODE_POINTS`. `typedDataFields` takes an optional
  leaf-value override.
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
  lint rule keeps `src/prices` out of every build and sign path. Assets
  the gateway cannot price at all are `unsupported` in `PricesState.errors` (their stored quote is
  dropped); hidden tokens are neither priced nor valued. The engine sends one price request per
  chain family under that family's client id, so the held asset set does not link the gateway
  scopes. (MIGRATION §9)
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
  known-recipient set. The newest 200 entries per group are cached; lock clears the state. `verified` means chain-proven from a
  host endpoint: entries read only through the gateway are never verified, nor EVM entries of an
  account that has code (an EIP-7702 delegation included) unless the transaction reverted.
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
  `token: { identifier, amount }` to a Spark address, result `token`;
  `engine.spark.quoteExit` (the converged cooperative-exit quote); token sends are only `pay`
  requests.
  While a token send with an unknown outcome is open, another send of the same token is refused.
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
- `@qntx/gateway`: `POST /v1/prices/:family` — spot price and 24 h change for up to 100 CAIP-19
  assets of one chain family in one fiat currency (`usd`, `eur`, `gbp`, `jpy`, `cny`, `krw`, `hkd`, `sgd`, `cad`, `aud`, `chf`);
  CoinGecko Pro primary (`COINGECKO_API_KEY`), DefiLlama fallback;
  answers cached per asset and currency for 30 s, converted to bounded decimal strings without
  float arithmetic, `no-store`. The body may name only the route family's assets (`evm`,
  `solana`, `bitcoin`, `tron`; else `400 invalid-request`, an unknown family is `404`). Contract:
  `PRICE_FAMILIES`, `PriceFamily`, `priceFamily`, `priceAssetFamily`, `pricesPath`.
- `@qntx/gateway`: `POST /v1/history/:caip2` — EVM transfers of an address over Alchemy
  `alchemy_getAssetTransfers` (existing `ALCHEMY_API_KEY`, breaker id `alchemy-transfers`),
  newest first, block-frontier pagination; `404 unsupported` on a served network without a
  history provider.
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
  `tokenListResponse`, `tokenListPath`, `TOKEN_LIST_MAX_ENTRIES`, `TOKEN_LIST_SOURCES`. A network no source covers
  answers `404 unsupported`; a covered one whose list is not built yet answers `503 unavailable`.
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
- `@qntx/wallet-chains/evm`: `ORDER_ITEMS` (8), the most offer or consideration items a prompt shows for
  Seaport and the off-chain order decoders.
- `@qntx/wallet-chains`: Solana System `CreateAccount` / `CreateAccountWithSeed` for any owner
  program (an outflow of the new account's lamports when the signer funds it),
  `AdvanceNonceAccount`, and Token / Token-2022 `InitializeAccount` and `Revoke` are decoded
  (`full`).
- Kernel prompts (en, zh-Hans): "It signs only hashes or raw bytes; the wallet cannot see what they
  commit to" and "The wallet recognises this kind of signature but not this form of it; it may
  authorise moving assets".
- `vectors/chains/signing-classes.json`: cases for the new blind classes.
- `@qntx/wallet-engine`: WebLN rejects with code `-32010` (JSON-RPC implementation-defined server
  error; `PAYMENT_PENDING_CODE` in `connect/errors.ts`) when a committed payment may have been
  made — its commit answer was lost, the preimage poll ran out of budget, a status read failed, or
  the payment settled without a preimage. Pages must not retry on `-32010`; `-32603 "payment
  failed"` stays reserved for terminal failures.
- `@qntx/wallet-engine/gateway/contract`: `HISTORY_CURSOR_MAX` (the largest history cursor the
  gateway forwards).
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
  (`submitted` | `unknown` | `settled` | `failed` | `archived`), persisted while open and reconciled against
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
- Gateway: production routes (Alchemy + dRPC) for the new mainnets; staging routes for every built-in EVM testnet; prices, Uniswap token lists and Alchemy transfer history where the providers serve the network. Networks without a history provider answer `404 unsupported` without calling upstream; Celo's CELO token-duality contract is excluded from token lists.
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
- `@qntx/wallet/protocol`: `sessions.create`, `sessions.list`, `sessions.open`,
  `sessions.delete` and `sessions.sign`. Types: `SessionInfo` (with the scheme's `limits` and
  `spent` as opaque `ProtocolValue`), `SessionSchemes`, `SessionSchemeId`,
  `HyperliquidAgentLimits`, `HyperliquidAssetLimit`, `HyperliquidAgentSpent`,
  `HyperliquidL1Action`, `HyperliquidL1Order`, `HyperliquidL1Params` and `HyperliquidNetwork`.
- Kernel: generic session keys. Each is a secp256k1 key generated in the enclave for one HD
  account and sealed as a `session-key` vault record. A session key is never exported or backed
  up, is deleted with its wallet, and belongs to a scheme from a compile-time table. A record whose
  scheme this build does not know is listed as unsupported. It cannot sign and can still be
  deleted, and it never makes the vault `unsupported`.
- Kernel: the `hyperliquid-l1-agent` session scheme, approved and metered. It signs only the
  allow-listed L1 trading actions (`order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`,
  `updateLeverage`, `updateIsolatedMargin`, `twapCancel`) — not `twapOrder`, whose slices carry no
  price the kernel can meter, nor `scheduleCancel`, which no allow-list can scope. The kernel
  re-encodes each action and computes the connectionId itself. It signs only while the vault is
  unlocked and before the session's `validUntil`; each signature needs a nonce within 60 seconds
  of the kernel clock and an `expiresAfter` at most 60 seconds ahead, so a signature can be
  submitted at most a minute after it was made, including after a lock.
  - `sessions.create` takes the scheme's `limits` (`HyperliquidAgentLimits`: a cumulative
    `notional` budget that buys charge, a `maxLeverage` cap on `updateLeverage`, and 1–16
    per-asset `{ asset, size }` caps over ids 0..99999 that buys and sells both charge) and a
    `verify` factor; `sessions.open(address, verify)` re-approves the session after every lock,
    and `sessions.sign` on an unopened session answers `approval-required`. Every signed order is
    charged into `spent` before the signature returns; out-of-bounds use is `limit-exceeded`.
  - The approval prompt restates the limits and labels each market by its numeric asset id
    rendered `#id` (perp/spot split at 10000) — the kernel keeps no trusted id→name table, so the
    id is the field a compromised runtime cannot relabel; hosts show it next to their market
    name. An approval text that cannot fit the platform dialog is `invalid-input`. On iOS, create
    and open first confirm the limits with a kernel-chosen 4-digit code on the secure-input hub
    (`SecureInputKind` `"session-approval"`; `cancelled` on a wrong code, `unsupported` on a host
    without a secure-input surface).
  - Create, open and sign answer `app-lock-required` while a keystore host's vault holds its
    `device` factor (app lock off), and `unsupported` for a card or hardware wallet before any
    prompt. At most two live metered sessions may exist per owner and scope (`conflict`).
  - A stolen session key is bounded: a compromised main runtime can trade at most the remaining
    budget and cannot withdraw. The kernel cannot know prices, so absurd prices in a thin book can
    lose up to the whole budget.
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
- `scripts/check-migration-guide.ts` (part of `bun run lint`): every MIGRATION.md snippet block equals
  its compiled file under `tests/migration/`, every snippet file is referenced, and every `§n` in the
  guide, the snippets and the entry being released names a section.
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
  parameters must agree on the host endpoint when one is configured (gateway-only mainnet sends carry
  `reads-unverified`, gateway-only testnet sends are refused); the kernel's
  signature is verified before broadcast. `PendingRequest.tronFee` (`TronFeeQuote`): expected and
  maximum fee, bandwidth (bytes, staked/free/burn, activation), energy (estimate incl. dynamic
  penalty, available, burn, `fee_limit`) and warnings (`recipient-not-activated`,
  `token-recipient-empty`). TRC-20 `fee_limit` = `min(⌈estimate × 1.5⌉, getMaxFeeLimit)`. A send
  the TRX balance cannot cover is refused before approval. Risk findings `contract-recipient`,
  `token-contract-recipient` and `token-recipient-empty`. A send
  with less than 20 s of validity left at approval is rebuilt in place; pinned reads answered
  429/503 wait `Retry-After` within the validity window, else the prepare rejects with
  `TronThrottledError` (`retryAfterMs`). Node responses are parsed losslessly: int64 amounts are exact
  `bigint`s and account resource counters decimal strings.
- `@qntx/wallet-engine`: request methods `tron-stake` (Stake 2.0 freeze, unfreeze,
  withdraw-expired, cancel-unfreeze, delegate (optional lock), undelegate, vote, claim rewards —
  each pre-checked against the java-tron actuator rules) and `tron-approve` (TRC-20 allowance;
  `amount: 0n` revokes). `AccountPermissionUpdate` is not offered.
- `@qntx/wallet-engine`: TRON tracking — broadcast refusals classified from `Return.response_code`
  (`DUP_TRANSACTION_ERROR` is held; busy/connection/unknown codes stay `submitted`); signed bytes
  rebroadcast while unexpired; `dropped` only once a solidified block's timestamp is past
  `expiration`, neither node knows the id and the host endpoint agrees (without one: three
  consecutive polls spanning more than one solidification period, each pinned to one upstream); included ⇒ `confirmed`, solidified ⇒ `final`; an
  on-chain failure (`OUT_OF_ENERGY`, `REVERT`, …) is `failed` with the reason and the burned fee in
  `error`; a reorg before solidification returns it to `submitted`.
- `@qntx/wallet-engine`: TRON balances — liquid TRX, built-in TRC-20s (`balanceOf`, no Multicall),
  custom TRC-20s, TRC-10s from `assetV2` (unverified), indexer-discovered TRC-20s (display-only,
  unverified, spam-flagged); `AccountBalances.tron` (`TronAccountView`): frozen, unfreezing,
  delegated in/out, votes, claimable reward, bandwidth/energy/TRON-power limits and usage.
- `@qntx/wallet-engine`: TRON history from the gateway indexer (TRX, TRC-10 and TRC-20 in/out),
  `verified` only after the node confirms the transaction bytes (TRX/TRC-10) or every Transfer log
  touching the account (TRC-20); zero-value, look-alike and impersonation flags. Duplicated TRX/TRC-10 claims collapse,
  `call_value` / `call_token_value` movements are shown, and an entry is verified only on a decoded,
  sha256-pinned body.
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
  `list`, `open`, `delete`, `sign`) the way `spark(wallet)` and `nostr(wallet)` expose their
  protocols. `create` and `sign` are typed per scheme; `create`/`open` take the `verify` factor the
  kernel approves the session's `limits` under. `sign` verifies the kernel's answer: it rebuilds
  the scheme's document and rejects `integrity` unless the session key signed it. (MIGRATION §31)
- `@qntx/wallet-engine/apps`: a separate entry (hosts that do not import it bundle nothing new).
  `createApps({ wallet, account, requests, networks, fetch, socket, now, setTimer, random, logger,
  openStore, gateway, apps: [hyperliquid(…), polymarket(…)] })` returns `controller` (an
  `AppsController` typed by the listed definitions), `destroy` and one api per listed app id. Providers ship in the
  `/apps/hyperliquid` and `/apps/polymarket` sub-entries, so a host bundles only the apps it imports:
  - `AppsController`: per account group and app state (`disabled`, `enabling`, `enabled`,
    `needs-reauthorization`, `needs-migration`, `unavailable`), terms acknowledgement, gateway eligibility, and a
    resumable enable flow (kernel agent → `ApproveAgent` request → optional `ApproveBuilderFee`
    request → verification on Hyperliquid); renew and disable (with optional deregistration on
    Hyperliquid). Agents created but never approved are deleted. `authorities(group)` lists the
    standing authorities an app's venue holds over the group's funds — display-only rows with a
    `revoke` hint; the Hyperliquid builder-fee approval on HyperCore, Polymarket's trading
    approvals on the deposit wallet, and Fiat24's owner-EOA allowances, one `{ app, error }` row
    per failed app read.
  - `HyperliquidProvider`: market and account reads, live views (order book, trades, candles,
    account, spot balances, open orders, fills) with reconnect, resubscribe and stale marking,
    order placement (limit, market with a computed slippage cap, stop/take-profit, attached and
    position TP/SL, reduce-only, post-only), modify, cancel, cancel-all, TWAP cancel, leverage,
    isolated margin, close position, perp↔spot transfers, `usdSend`, `spotSend`,
    `withdraw3`, and USDC deposits from Arbitrum through CCTP (`depositForBurnWithHook` to the
    account's own perps or spot balance, after an exact USDC approval when the allowance is short).
    `enable` and `renew` take `{ limits, verify }` (`HyperliquidEnableInput`), and
    `reopen(group, verify)` re-approves the agent session in the kernel after a lock — the prompt
    restates the approved limits and the remaining budget. `HyperliquidErrorCategory` includes
    `reopen-required`, `app-lock-required` and `limit-exceeded`. There is no TWAP placement and no
    scheduled cancel: the kernel's allow-list refuses both. (MIGRATION §31)
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
  share of the native kernel bundle by ablation. The budget is 5 % (2.01 % measured for 0.14.0),
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
  decline persists across unlock, renew and re-enable until `apps.hyperliquid.approveBuilder(group)`
  obtains an approval.
- `@qntx/wallet-chains`: TIP-712 typed data — `SignRequest` `tron.typed-data { typedData }` (canonical JSON: `types` incl. `EIP712Domain`, `primaryType`, `domain`, `message`). `parseTronTypedData` / `tronTypedDataDigest` hash exactly like TronWeb 6.5.2 `_signTypedData` (address leaves drop the `0x41` prefix, `trcToken` is an atomic uint256, `domain.chainId` is the network's decimal CAIP-2 reference); `tronTypedDataFromArgs(domain, types, message)` turns TronWeb's argument form into that JSON; `@qntx/wallet-chains/tron/sign` `signTronTypedData`; `recoverTronTypedDataSigner` / `verifyTronTypedDataSignature`. `decodeTron` describes EIP-2612 permits and the SUN.io Permit2 deployment on mainnet (`TRON_PERMIT2`, PermitSingle/Batch/TransferFrom/WitnessTransferFrom) with base58 addresses; an unrecognised document lists its leaves or is blind (`typed-data-variant` for `Permit*`/Permit2/listed-token claims, `typed-data-oversize`, `typed-data-commitment`).
- `@qntx/wallet-chains`: `tronRawDataFromJson(rawData, visible)` re-encodes a dApp's `raw_data` JSON under TronWeb `txCheck` semantics (strict: unknown keys, non-canonical forms and `AccountPermissionUpdateContract` refuse); `tronMemoBytes` / `TRON_MEMO_MAX_BYTES` (256 UTF-8 bytes, one line, no hidden characters — always shown in full by the kernel prompt).
- `@qntx/wallet`: `chain.sign` request `tron.typed-data`; the kernel signs it and verifies the signature against the account.
- `@qntx/wallet-engine`: TRON in-app-browser provider. The injected script adds `window.tron` (TIP-1193 `request`/`on`/`removeListener`, TIP-6963 announcement under the host's own `ProviderInfo` — never TronLink's name or rdns, no `isTronLink`), and `window.tronLink` / `window.tronWeb` as the same minimal object: `ready`, `defaultAddress`, `trx.sign`, `trx.signMessageV2`, `trx._signTypedData`/`signTypedData`, `trx.sendRawTransaction`, `trx.getBlockByNumber(0)`, no-op node setters, `addressChanged`. Everything else on TronWeb's surface rejects with 4200 (`trx.sign(hex)` digest signing, `trx.signMessage`, `trx.multiSign` included). Methods: `eth_requestAccounts`, legacy `tron_requestAccounts` (`{code}` result), `wallet_switchEthereumChain` between enabled TRON networks, `wallet_watchAsset` (TRC-20). The official `@tronweb3/tronwallet-adapter-tronlink` finds the wallet through `window.tronLink`.
- `@qntx/wallet-engine`: request method `tron-sign` (dApp transaction, TIP-191 message, TIP-712 typed data). A dApp transaction is signed only as the exact `raw_data_hex` bytes after `sha256 == txID`, `raw_data` JSON re-encoding byte-equal, owner = the session account, a modeled contract type, `Permission_id` 0, `now + 20 s ≤ expiration ≤ now + 24 h` and a TaPoS reference block still on the chain; it gets the TRON fee quote (energy from `triggerconstantcontract`, the dApp's own `fee_limit` as the cap, `fee-limit-below-estimate` when it will run out of energy) and a TRC-20 balance-change simulation. After signing it is tracked by txid without the wallet broadcasting it (`TrackedTransaction.tron.dappSignature`); `trx.sendRawTransaction` of a transaction this wallet signed goes through the persisted, unknown-outcome-safe broadcast (`TransactionController.submitDappTron`), any other is refused.
- `@qntx/wallet-engine`: TRON `send` accepts `memo` (written to `raw_data.data`); the quote adds the live `getMemoFee` (`TronFeeQuote.memo`). `vectors/chains/tron-fees.json` gains 25 mainnet memo transfers bounding it.
- `@qntx/wallet-engine`: `watch-asset` accepts TRC-20 tokens (on-chain `symbol`/`decimals`, built-in-table impersonation check).
- `ConnectionController`: `tron` namespace (scopes for every enabled TRON network, `ConnectionSession.tronNetwork`, `setTronNetwork`); the engine facade exposes `tronWallet`.
- `@qntx/wallet-engine/walletconnect`: WalletConnect v2 wallet side on Reown WalletKit. The SDK
  packages (`@reown/walletkit` 1.6.0, `@walletconnect/core`, `@walletconnect/types` and
  `@walletconnect/utils` 2.25.0, exact pins, under the WalletConnect Community License) are
  optional peer dependencies: a host using this entry installs them itself, and every other entry
  works without them. `createWalletConnect({ projectId,
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
  message through the pipeline. Telemetry is off. Hosts that do not import the entry bundle none
  of it. (MIGRATION §21)
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
  close-only/blocked/unknown eligibility and for accounts the CLOB marks `closed_only`. The deposit target is proven by `eth_getCode` on Polygon, cross-checked with the
  host endpoint (`deployment-mismatch` otherwise); a `canceled` outcome carries `making`, the size
  filled before the cancel.
- Polymarket CLOB L2 API credentials live in the apps store (the host's `openStore`, encrypted
  under the data key), one record per account group on Polygon; the engine computes the L2 HMAC
  itself. Credentials are never in controller state, events, logs or errors (L2 errors are scrubbed
  of them), are unavailable while the wallet is locked, are re-checked against the group's signer
  on every request, and are deleted on disable and when their wallet is deleted. A compromised main
  runtime can read them while the wallet is unlocked (cancel orders, read private CLOB data); it
  cannot place orders or move funds. The kernel gains no record kind or command for them.
- `@qntx/wallet-engine/apps/hyperliquid`: `hyperliquid({ network, agentName, builder? })` and every
  Hyperliquid export.
- `@qntx/wallet-engine/apps`: app definitions (`AppDefinition`, `AppInstance`, `AppContext`,
  `AppStorage`, `AppApis`) — each app gets its own encrypted per-group storage namespace
  (`apps.<id>`), pruned when a wallet is deleted. Each
  definition declares `enableWhen` (the eligibility answers under which `enable`/`renew` may start);
  group state is the controller's `status`, `termsAcknowledged`, `requestId` and `error` merged with
  the app's own typed detail (`HyperliquidGroupState`, `PolymarketGroupState`). Providers import only
  the provider SPI (`src/apps/spi.ts`, enforced by `scripts/check-boundaries.ts`); the engine README
  gains "Writing an app provider".
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
    that account when the transaction runs. Every id whose first digit is 9 is an issuer-only
    account a client can never mint (`Fiat24Account.sol` `hasFirstDigit(INTERNALDIGIT)`) and
    raises `fiat24-internal-account`.
  - `clientPayout` / `clientPayoutRef` use the new `payout` summary. The amount and currency are
    shown, and so are the payee id, purpose and reference, each as requester text. The bank account
    that receives the money is chosen by Fiat24 off-chain, and `fiat24-payee-offchain` says so.
  - `moneyExchangeExactIn` / `moneyExchangeExactOut` are swaps with no minimum received. The issuer
    sets the rate (`fiat24-issuer-rate`). An exact-out swap can cost up to the whole allowance
    (`fiat24-exact-out-unbounded`).
  - `depositTokenViaUsdc`, `depositETH` and `depositTokenViaEth` are top-up swaps at the issuer's
    rate. When the input is swapped to USDC inside the transaction, `fiat24-swap-quote` is raised.
  - `mintByClient` / `mintByClientWithETH` open an account (`fiat24-account-link`).
    `mintByClient` also burns F24 at the price the issuer sets for the account number, bounded
    only by the address's F24 allowance for the account contract: `Fiat24Action` `open-account`
    carries `burn` (the F24 token, no amount) and `fiat24-account-burn` is raised. Moving the
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
  `IntentWarningKind` gains ten `fiat24-*` kinds. `./evm` exports `FIAT24_CHAIN` and
  `fiat24SessionMessage`.
- Fiat24 API session grants. A new sign request,
  `{ kind: "evm.fiat24-session", network: "eip155:42161", account, tokenId, deadline }`, works
  like this:
  - The kernel builds the `personal_sign` text itself:
    `"I agree to access my profile. " + keccak256(label ‖ deadline)`, where
    `label = fiat24-session-v1:<chainId>:<tokenId>:<deadline>;`. The server verifies
    `keccak256(hash ‖ deadline)` from two client headers and parses nothing in `hash`; the `;`
    terminator keeps the signed text from re-splitting into a later deadline. The label binds no
    chain or account on the server.
  - It refuses with `invalid-input` unless `0 < deadline − now ≤ 1200` s. It checks this when
    preparing and again when signing.
  - The prompt describes a bearer grant for the signing address's Fiat24 account until the
    expiry, and everything the grant allows.
  - The result is `{ kind: "evm.fiat24-session", signature }`, and `@qntx/wallet` checks the
    signer.
  - `@qntx/wallet/protocol` mirrors the new request and result kinds.
- Vectors: `vectors/chains/fiat24.json` (ABIs from Sourcify, calldata from viem cross-checked with
  `cast calldata`, session grants from `cast keccak` / `cast hash-message` / `cast wallet sign`,
  expected prompts written by hand) and `vectors/chains/fiat24-mainnet.json` (25 real Arbitrum One
  transactions).
- `@qntx/wallet-engine/apps/polymarket`: `trade.corrections`. Every `unknown` order outcome is
  re-asked every 10 s for 10 minutes (64 at most, dropped on lock), and the first provable status
  is emitted once as a `PolymarketOutcomeCorrection`, like Hyperliquid's corrections.
- gateway: the JSON-RPC route honours `x-gateway-provider` like the TRON route. A pinned request is
  served, metered and budgeted by that provider alone; an unknown pin is a 400 before any upstream
  call.
- `vectors/chains/signing-plans.json` (generator `packages/wallet-chains/scripts/signing-plans-vectors.ts`):
  plans and artefacts for every family, digests from viem, tronweb, bitcoinjs-lib and @solana/kit.
- **qntx card wallets** (React Native). A wallet's seed can live only on one to three qntx cards:
  the vault keeps a `card-wallet` record (card IDs and pinned certificates, the wallet anchor,
  the public keys a tap fetched, optionally the sealed access-code hash), never the seed.
  `@qntx/wallet/card`: `card(wallet).start(op, verify)` returns a `CardTask` (`observe`, `cancel`,
  `result`); operations `status`, `add`, `accounts`, `health`, `change-access`, `erase`,
  `create` (card-generated, or moving a vault wallet onto the cards), `transfer`, `reseal`,
  `sign` and `forget-access`. Kernel protocol `card.begin` / `card.step` / `card.cancel`
  (`CARD_METHODS`); the host only starts, observes and cancels — APDUs flow between the kernel
  runtime and the native reader, the kernel collects the access code from `SecureInput`, and the
  NFC sheet's text is the kernel's decoded prompt of the request (for a blind request, the blind
  warning and the network). Web and Node answer `unsupported`. **This release pins no production
  certificate anchor (`PRODUCTION_ANCHORS` is empty until the first production batch), so every
  card — including one that never finished personalisation — is refused as `card-not-genuine`;**
  card wallets become usable with the release that ships the anchor. (MIGRATION §30)
- Card signing covers every `chain.sign` request: EVM transactions (incl. EIP-7702
  authorisations), personal messages and EIP-712 (incl. Fiat24 sessions and app-origin typed
  data), Bitcoin PSBTs (multi-input, all four account templates, Taproot key path), BIP-322 and
  legacy messages, Solana legacy/v0/v1 transactions and messages (≤ 16 KiB), and TRON. ECDSA,
  BIP-340 and Ed25519 (streamed) run on the card; every card signature is verified against the
  cached public key before assembly, and a repeated ECDSA `r` within one operation is
  `card-fault`. A plan that needs more than one tap resumes on the next tap of the same card
  without a new prompt.
- Every tap is its own authenticated session: the card's certificate must chain to a pinned
  anchor (else `card-not-genuine`), its ephemeral key must not repeat, the card ID must be the
  one the step expects before any access-code hash is sent (`card-id-mismatch`), a failure
  counter that moved without this kernel is `card-tampered`, and every exit path wipes the code,
  the hashes, the session keys and any generated entropy or imported seed. An operation without
  progress for 120 s, a lock or `card.cancel` discards it. A remembered access code is suspended
  while the app lock is off — it cannot verify until the lock comes back on. Session keys
  (`sessions.create` / `open`) answer `unsupported` for a card wallet.
- The card protocol client (`packages/wallet-kernel/src/modules/card/protocol/`, private to the
  kernel): a self-contained host implementation of qntx card protocol 1 (`qntx/wallet-applet`
  `spec/protocol.md`) — card IDs and short IDs, certificate verification against batch anchors,
  `accessHash` through the injected Argon2id (6–64 printable ASCII characters,
  `m = 64 MiB, t = 3, p = 4`), OPEN with the signed ephemeral ECDH and SP 800-56C key schedule,
  the AES-CBC/CMAC record layer with counters, pre-wrapped records and teardown on any failure
  (`session-broken`, keys wiped), encoders for every inner command, the per-command status-word
  mapping to a typed `CardError` union, and decoders that verify every card output: WalletInfo
  membership and CREATE echoes, public keys, Wei25519 points mapped to RFC 8032 encodings with
  subgroup checks, ECDSA (low-s normalisation, recovery bit, repeated `r`), BIP-340 under the
  taproot-tweaked key, Ed25519 streaming and assembly under strict RFC 8032 verification, OFFER
  and EXPORT signatures for multi-card transfer and re-seal. Pure and synchronous except
  `accessHash`; runs in bare Hermes with no globals. It follows the two protocol amendments the
  owner approved (spec proposals B1 and B2): `VERIFY`'s wait gate answers `6986`
  (`wait-required`) and `6985` is a wrong card state for every command; `finish` carries 1–236
  bytes and the client never sends an empty one.
- `@qntx/wallet`: `CardWalletInfo`, `VaultWalletInfo`, `CardInfo`; error codes
  `card-not-genuine`, `card-id-mismatch`, `card-erased`, `card-locked`,
  `card-tampered`, `card-fault`, `card-unsupported`. `@qntx/wallet/protocol`: `CARD_METHODS`, the
  `cardId` validator and the `Card*` wire types.
- `@qntx/wallet-native`: two kernel-only native capabilities for card wallets. `__qntx.cardReader`
  opens an NFC reader session whose visible text only the kernel sets (iOS:
  `NFCTagReaderSession.alertMessage`, set once before `begin`; Android: reader mode behind the
  module's own dialog, polling only while that dialog holds window focus) and exchanges APDUs
  directly between the kernel runtime and native code: the main runtime never relays them and only
  drives the tap cadence. `__qntx.secureInput` collects a card access code or printed short ID
  from a native field and hands the bytes to the kernel runtime only. Neither is registered with
  Nitro or reachable from the main runtime. They are wired into the kernel as
  `KernelPlatform.card` (reader, secure input and certificate anchors).
- `@qntx/wallet-native/secure-input`: the `SecureInput` Nitro host component. The main runtime can
  mount and size it and receives only `idle | empty | filled | submitted`; the kernel decides
  whether it collects an access code (masked, printable ASCII, ≤ 64), a short ID (8 hex digits),
  the backup password (`backup-password` — how the kernel collects it on React Native) or a
  session-approval code, and which label it shows. The field is editable only while a kernel
  request is pending, takes focus and raises the keyboard on that request, has no edit menu (no
  paste, copy or cut), is excluded from autofill, and on Android sets `FLAG_SECURE` while an
  access code is being typed.
- `vectors/card/`: the applet's published vector files pinned by commit and SHA-256
  (`vectors/card/SOURCE`, `scripts/check-card-vectors.ts <applet checkout>` fails on drift), and
  `oracle.json`, independent host-side vectors from `scripts/vectors/card-oracle.py`
  (libsecp256k1, the Argon2 reference implementation, pyca/cryptography).
- `scripts/card-sim/` and `bun run card:sim`: the real qntx applet at the commit
  `vectors/card/SOURCE` pins, in its patched jcardsim, behind a multi-card stdio bridge with a
  power-loss hook; the kernel's simulator suites and CI's `card.yml` run against it.
  `bun run smoke:hermes` also runs the card protocol client under bare Hermes, and
  `scripts/check-kernel-budget.ts` reports the card module on its own line with a measured budget;
  `scripts/check-boundaries.ts` keeps `modules/card/protocol/` self-contained.
- `apps/harness`: a card-surfaces page (`EXPO_PUBLIC_CARD_SURFACES=1`) that drives both surfaces
  through a real kernel runtime with a fake card reader, and a leak check proving the typed code
  never appears in any main-runtime message, log, event payload or React state.
- `@qntx/wallet-chains/evm`: exports `hyperliquidL1Document` and the `HyperliquidL1Action`,
  `HyperliquidL1Order`, `HyperliquidL1Params`, `HyperliquidNetwork` types (`@qntx/wallet` verifies
  session signatures with it); `@qntx/wallet/protocol`
  and `@qntx/wallet/sessions` re-export the same names. `PROGRAM_IDS` gains `ed25519`,
  `secp256k1` and `secp256r1`.
- `@qntx/wallet-engine`: the main entry exports `parseDecimal`, `formatDecimal`, `Decimal`, `SetTimer`,
  `timeoutSignal` and `readJson`. `@qntx/wallet-engine/gateway/contract` exports `APP_ID`.
- `@qntx/wallet-engine/apps/fiat24`: the Fiat24 app (Arbitrum One), built on `@qntx/fiat24` 0.1.0
  (pinned exactly). `fiat24({ fetch? })` is the definition `createApps` lists; the core `apps`
  entry never loads it.
  - `account(group)` reads the group's `evm.bip44` address on `eip155:42161` through a viem client
    built from the engine's network controller: with an independent endpoint every pinned read must
    agree on both, the lower head is pinned, pending nonces take the higher count, a receipt missing
    on either side is missing, and a failing corroborator fails the read. The SDK's pinned
    deployment check stays on; a drift is the typed status `contract-changed`, not an error.
    `live(group)` polls every 15 s (`FIAT24_POLL_MS`) while `setVisible(true)` and unlocked.
  - `flows`: `start`/`advance`/`list`/`discard`/`payoutSettlement` over the SDK's resumable
    transfer, exchange (exact-in and exact-out with the bounded approval), payout (contact, bank,
    Swiss QR), top-up, onboarding and card flows. Each state is stored as `encodeFlowState` text
    in the app's EngineStore collection (no PII); payout drafts stay in memory. Advances run one at
    a time per group; a new flow is refused while another is `sending`, `unknown` or undecodable;
    reconciliation after unlock and every 15 s while visible only advances flows whose last
    transaction is `sending`/`submitted`/`unknown`, so it never sends. Onboarding and top-up need
    the app to be `available` in the caller's jurisdiction.
  - Every SDK write is exactly one request attributed `{ kind: "app", id: "fiat24" }`: transactions
    are `evm-sign` `evm.transaction` requests at the SDK-chosen nonce; session grants are
    `evm.fiat24-session` requests. `Fiat24Flow.refusal` says why a send did not happen.
  - `session(group)`: profile, cards, card display token and statements through a lazy SDK session
    whose grant lives only in memory and ends on lock, disable and wallet removal; disable also
    rejects the group's open requests.
  - `api`: rates, payment purposes, countries, country cities, banks, `bankByIban`, `kycUrl`.
  - The REST API has no CORS: it is reached only through the injected `fetch` (React Native: the
    native fetch; Web: a host proxy that rewrites the URL). Without it every API-backed feature
    throws `Fiat24AppError` `api-unavailable`.
  - Errors are `Fiat24AppError` (`category`; `code` carries the SDK's `Fiat24ErrorCode` for
    `protocol`); none carries a `cause`.
- `@qntx/wallet-engine`: `EvmSignInput.nonce` pins the nonce of an app's `evm.transaction`;
  `prepare` refuses with the new `NonceConflictError` (`expected`, `next`) before anything is shown
  when the sender's next free nonce differs.
- `@qntx/wallet-engine`: app origins may prepare `evm.transaction` and `evm.fiat24-session`
  requests (decoded and prompted like any other); dApps still cannot request a Fiat24 session and
  the wallet's internal requests still sign only typed data.
- `@qntx/wallet-engine/apps`: `AppStorage.list(group)`.
- `@qntx/wallet-engine`: the chain decoder's intent warnings become risk findings for every
  origin. `RiskFinding.code` gains `fiat24-unlimited-approval` and `fiat24-account-move`
  (`danger`), `fiat24-internal-account`, `fiat24-card-pull`, `fiat24-exact-out-unbounded`,
  `fiat24-payee-offchain` and `fiat24-account-burn` (`warning`); a warning the decoder marks
  `level: "danger"` is always a `danger` finding.
- **gateway:** `/v1/eligibility` answers `fiat24`: blocked in the sanctioned set, close-only where
  Fiat24's `/countries` bans the nationality (US and territories, RU).
- `@qntx/wallet-engine`: approvals inventory — `engine.approvals.load(account, network)` returns a
  view key; `ApprovalsState.views[key]` lists every standing authority over the account: EVM ERC-20
  allowances, Permit2 allowances (amount, expiration), ERC-721/1155 operators, ERC-721 single-token
  approvals and the account's EIP-7702 delegation; Solana SPL delegates, foreign close authorities,
  mint freeze authorities and Token-2022 permanent delegates, stake authorities; TRON TRC-20
  allowances and account permission keys. Kernel session keys signing for the owner are linked
  (`sessions`), not duplicated. Every row is read on chain at the view's `at.height` and cross-checked
  on the independent endpoint: a candidate the chain does not confirm is dropped, a disagreement
  hides the row (`disputed`), a single-upstream read is `verified: false`. Discovery sources and
  their freshness are listed (`sources`); kinds the chain enumerates are in `exhaustive`, the rest
  are known approvals only. Rows carry risk flags (`unlimited`, `eoa-spender`, `spender-no-code`,
  `address-poisoning`, `foreign-delegation`) and an `exposure` (what the spender can take now);
  `engine.approvals.exposure(key)` values it at current quotes (display-only). Views poll every
  `APPROVALS_POLL_MS` while `setVisible(true)` and re-read after an approval-bearing transaction on
  the network confirms. Discovered candidate keys persist in the session store (collection
  `approvals`).
- `@qntx/wallet-engine`: `engine.approvals.revoke(key, rowId, fee?)` and
  `revokeBatch(key, rowIds, fee?)` open an ordinary request per revocation: request methods
  `evm-revoke` (`approve(spender, 0)`, Permit2 `lockdown`, `setApprovalForAll(false)`,
  `approve(address(0), tokenId)`; several targets only as one self-call batch on an account already
  delegated to the wallet's delegator) and `solana-revoke` (SPL `Revoke`, up to 10 token accounts);
  the 7702 delegation revokes through `evm-delegation` and TRC-20 through `tron-approve` amount 0.
  Builders re-read the chain before building and refuse when nothing is left to revoke; the built
  call must decode back to exactly the revocation. Type `EvmRevokeTarget`.
- `@qntx/wallet-chains`: `ApprovalChange` variants `approval-cleared` (`approve(address(0), id)` —
  clears an ERC-721/TRC-721 token approval, grants nothing) and `delegate-revoked` (SPL `Revoke`).
  The kernel prompt describes both as revocations instead of an allowance to the zero address or no
  line at all.
- Gateway: `POST /v1/approvals/:caip2` — display-only approval candidates (token, spender or
  operator, block) from Alchemy `eth_getLogs` over the owner's `Approval`, `ApprovalForAll` and
  Permit2 `Approval`/`Permit` events, on chains where Alchemy allows an unbounded log range;
  `404 unsupported` elsewhere. One `eth_blockNumber` plus four `eth_getLogs` per call, metered on
  the existing `alchemy` account.
- `@qntx/wallet-engine`: `StakePosition` gains `staker` and `withdrawer`; the TRON account schema
  carries `owner_permission`, `active_permission` and `witness_permission`;
  `TransactionController.addressOf` and `prepareSolanaRevoke`.
- `@qntx/wallet-engine`: `engine.nfts` (`NftController`) — NFT inventory per owner and network
  from the gateway: ERC-721 and ERC-1155 on the 22 built-in EVM mainnets the gateway's NFT
  provider covers, and Solana (Metaplex Token Metadata, programmable, Core and compressed NFTs).
  `load` / `loadMore` page the inventory (100 items a page, at most 20 pages), `refresh` re-reads
  the loaded pages, `setVisible` polls every 5 minutes while visible, `detail`, `collection` and
  `floor` answer one item, one collection and its marketplace floors without storing them.
  Inventory data is display-only: nothing that builds or signs a transaction reads it
  (lint-enforced: only the composition root may import `src/nfts`).
- `@qntx/wallet-engine`: NFT metadata is hostile input. Media come out as `NftMedia` descriptors
  (`https`, `ipfs`, `ar` or `data:image/*` up to 64 KiB; everything else dropped) with an `active`
  flag for SVG, HTML and animations of unknown type; the engine never fetches media and leaves
  IPFS gateway rewriting to the host. Names that carry hidden characters or markup are dropped,
  descriptions are plain-text excerpts (20 lines, 2,000 code points), attributes are capped at 50.
- `@qntx/wallet-engine`: NFT spam reasons — `gateway`, `airdrop` (the wallet's own verified
  history shows the item only arriving, never touched), `lookalike` (a collection name that folds
  to a trusted held collection's), `link-in-name` and `deceptive-text`. Flagged items are hidden by
  default; `nfts.setHidden(network, id, "hidden" | "shown" | undefined)` persists the user's
  override in the engine store (collection `nfts`).
- `@qntx/wallet-engine`: after an NFT transfer is included, the controller re-reads the items it
  moved from chain (`ownerOf` / `balanceOfBatch` / the Solana token account or Core asset) and
  updates or drops them — the gateway is not consulted.
- `@qntx/wallet-engine`: `nfts.inscriptions(group, network)` lists the Bitcoin UTXOs the spend
  path already protects as possible inscription carriers — read-only, no new read.
- `@qntx/wallet-engine`: ERC-1155 batch transfers: `evm-nft-send` with several `items` builds one
  `safeBatchTransferFrom`, balances checked with a corroborated `balanceOfBatch`.
- `@qntx/wallet-engine`: `solana-nft-send` sends plain SPL NFTs (Metaplex Token Metadata,
  Token or Token-2022) with an associated-token-account transfer, and Metaplex Core assets.
  Programmable NFTs are refused with `NftTransferError` reason `programmable`; compressed NFTs
  stay read-only.
- `@qntx/wallet-engine`: `NftTransferError` (a `ChainError` with code `invalid-request`) carries
  `reason`: `not-nft`, `not-owned`, `insufficient-balance`, `programmable`, `frozen` or
  `not-found` — every one decided from corroborated chain reads.
- `@qntx/wallet-engine/gateway/contract`: the NFT routes `POST /v1/nfts/items/:caip2`,
  `/v1/nfts/item/:caip2`, `/v1/nfts/collection/:caip2` and `/v1/nfts/floor/:caip2` with bounded
  schemas and the network-fit helpers `nftAddressFits`, `nftItemFits`, `nftPageFits`,
  `nftCollectionFits`.
- Gateway: the four NFT routes over the existing Alchemy account (NFT API v3 for EVM, DAS for
  Solana), metered per call, cached at the edge without client identity (items 60 s, item and
  collection 1 h, floor 10 min). Floors are served on Ethereum, Arbitrum and Base.
- `@qntx/wallet-engine`: push notifications. `engine.notifications` (`NotificationsController`)
  keeps one gateway subscription per opted-in wallet and served chain family:
  `setToken(platform, token)` registers the APNs or FCM device token, `enable(walletId)` /
  `disable(walletId)` opt a wallet in or out, and `receive(message)` opens a delivered message into
  a display-only `NotificationEvent` (`received`, `sent`, `failed` or `reverted`) and reloads that
  wallet's history and balances — the activity list changes only through that reload, never from
  the push. Subscriptions follow the wallet tree, the enabled networks and token rotation, refresh
  weekly, are deleted when a wallet is disabled or removed, and stay active while the vault is
  locked. A submitted outgoing transaction of an opted-in wallet is registered so the gateway can
  report its settlement or on-chain failure. New `EngineOptions.pushKeys` (`PushKeyStore`) hands the
  per-subscription payload keys to the host for its notification extension; at `init` the
  controller deletes every host-stored key whose subscription row is gone (`PushKeyStore.ids()`),
  so a key orphaned by `vault.reset()` cannot keep opening the erased wallets' deliveries during
  the gateway's 30-day retention. A partially pinned external-custody wallet subscribes the groups
  and families it can read. A family whose
  addresses need a hardware device that has not pinned that path reports `device-required` in the
  per-wallet `NotificationStatus` — the same for a card wallet's family with no cached
  material — instead of silently staying pending, and a failing family no
  longer aborts the reconcile for the remaining wallets and families.
- `@qntx/wallet-engine/push`: `openPush(message, keys)`, the dependency-light opener (only
  `@noble/ciphers` and `@scure/base`, no runtime globals) a notification extension or headless task
  bundles to decrypt a delivery; `vectors/push.json` (generated with WebCrypto by
  `scripts/vectors/push.ts`) fixes the format for native implementations.
- `@qntx/wallet-engine/gateway/contract`: the push wire format (`PushMessage`, `PushPlaintext`,
  `parsePushMessage`, `parsePushPlaintext`, `serializePushPlaintext`, `pushEventInput`, `pushAad`,
  the `PUSH_*` constants) and routes `GET /v1/push`, `PUT`/`DELETE /v1/push/:family/subscription`,
  `POST /v1/push/:family/transactions`; `HttpMethod` gains `PUT`. Push routes carry the family's
  client id (`gatewayScope`).
- `apps/gateway`: push notifications. One SQLite `PushObject` Durable Object per chain family holds
  subscriptions (the device token and payload key sealed under `PUSH_SEAL_KEY`, ids derived one-way
  from the subscription secret, 30-day retention), a dedup/re-org state machine that notifies only
  on receipt evidence and follows a vanished transaction with `reverted`, and a delivery queue with
  retries and a one-hour expiry. APNs (ES256 provider token) and FCM HTTP v1 (service-account
  OAuth) senders deliver only an event id and an AES-256-GCM blob, with localisable fallback text.
  EVM addresses are watched through Alchemy Address Activity webhooks (`POST /hooks/alchemy`,
  HMAC-verified, address set reconciled through the webhook API) and verified by receipt through
  the shared forwarder. Configured by the optional secrets `PUSH_SEAL_KEY`, `APNS_KEY`,
  `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `FCM_SERVICE_ACCOUNT`, `ALCHEMY_NOTIFY_TOKEN` and
  `ALCHEMY_WEBHOOKS`; without them `GET /v1/push` advertises nothing. Solana, Bitcoin and TRON
  answer `unsupported`.
- `@qntx/wallet-native/cloud`: the official cloud-backup transports. `createICloudStore({ container })`
  stores backup envelopes in the CloudKit private database (custom zone `QntxWalletBackup`, record
  type `Backup`, one `envelope` asset field) and reports `CKAccountChanged` through
  `onAccountChange`; `createGoogleDriveStore()` stores them in Google Drive's hidden
  `appDataFolder`, with tokens from Google Identity Services `AuthorizationClient`
  (`drive.appdata` scope, no deprecated GoogleSignIn) and `authorize()` for the interactive
  consent. The Nitro objects `CloudKitStore` (iOS) and `GoogleDriveAuth` (Android) only move backup
  ciphertext and a Drive access token, so they are not secret-holding capabilities.
- `@qntx/wallet-engine`: `createGoogleDriveCloudStore({ fetch, setTimer, token, invalidateToken })`,
  the Drive v3 REST transport shared by Android and Web hosts (atomic multipart create, media
  replace, paged list, one token refresh on 401); `CloudStoreError` with codes `unavailable`,
  `auth-required`, `quota`, `invalid`, `failed`; `checkCloudName` / `checkCloudText` and
  `CLOUD_TEXT_MAX_BYTES` for host implementations.
- `@qntx/wallet`: `BackupHeader.keys` lists the imported keys an envelope carries
  (`BackupHeaderKey`).
- `apps/harness`: a cloud-store page (`EXPO_PUBLIC_CLOUD_STORE=1`) that probes the platform store and
  runs the real-device conformance checks.
- **Hardware signers** (`packages/wallet-kernel/src/modules/signers/`): the kernel drives external
  signing devices through `hardware.begin` / `hardware.step` / `hardware.cancel` — a single
  operation coroutine the host pumps frame by frame. The `hardware-wallet` vault record holds only
  public material (device identity, master fingerprint, pinned public keys); `pinnedMaterial`
  serves `wallet.accounts`, including public derivation off the non-hardened tail. A wallet whose
  `custody` is `"hardware"` carries no seed, so no hardware secret ever exists in the kernel.
- `@qntx/wallet`: `HardwareWalletInfo` (see the breaking `custody` union above; `supported` says
  whether this build ships a driver for `device` — a wallet paired under a device kind a later
  build dropped stays inert, not unreadable) and `HARDWARE_DEVICES` (`keystone`, `ledger`,
  `onekey`). Error codes `device-required`, `device-locked`, `device-app-closed`,
  `device-rejected` (the user refused on the device, also an on-device address check) and
  `wrong-device` (another device answered, or it showed a different address).
- `@qntx/wallet/hardware`: `hardware(wallet)` — `start(op, { io, verify? })` runs one operation
  (`pair`, `accounts`, `sign`, `verify-address`) over a host-supplied `DeviceIo` and returns a
  `SignerTask`; `sign` takes the same `verify` factor and re-runs the same result checks as
  `chains().sign`. Fetches that add device material are verification-gated: `pair` requires
  `verify` (`invalid-input` without it), and `accounts` for paths the pin lacks answers
  `approval-required` unless a `verify` is passed; a re-read of pinned paths needs neither.
  `HidPort`/`BlePort` are the host transport contracts the shipped
  `ledgerHidExchange`/`ledgerBleExchange`/`oneKeyHidExchange`/`oneKeyBleExchange` run over.
  `qrParts`/`qrReader` are the UR plumbing for air-gapped transports:
  cyclic uppercase fountain parts and a strict incremental decoder over `@qntx/ur` 4.1.0 (optional
  peer).
- Pinned keys are unconfirmed until the device shows them. Every `ChainAccount` variant carries
  `confirmed` (software-seed and card accounts are always confirmed) and the bitcoin variant the
  sealed `changeMark`. A `verify-address` answered `matched: true` seals the serving path into the
  hardware record's `confirmed` list — confirming one account node confirms every group it
  serves; entries merged without a check stay unconfirmed. `chain.exportAccount` (and the
  engine's `QrExportParams` / `SignStartParams`) refuse unconfirmed material with
  `approval-required` unless `acknowledgeUnconfirmed: true` is passed, which adds one danger row
  per unconfirmed node to the approval prompt. A Bitcoin output on an unconfirmed entry is never
  your own address: the prompt shows it as an ordinary send with a danger row, and the
  `hardware.begin` `sign` operation refuses it with `approval-required` unless
  `acknowledgeUnconfirmed: true` is passed — the engine's signing path passes it once the
  `bitcoin-unconfirmed-output` danger finding was acknowledged at `approve`. Bitcoin history reads
  a transfer to an unconfirmed account as a send, never `self`; a host-wired
  `HistoryControllerOptions.chains.account` answers the xpub variant with `changeMark` and
  `confirmed`. A hostile transport at first fetch can therefore pin foreign receive keys only as
  visibly unconfirmed ones; a counterfeit device confirms its own keys and is not detectable
  host-side. (MIGRATION §34, §35)
- Hardware prompts lead with the device line — `clear` (check the request on the device) or
  `blind` — ahead of the chain prompt's rows, its room reserved by the prompt bound. For Ledger the
  kernel strips the wallet's own BIP-32 derivations from every PSBT output the prompt shows:
  app-bitcoin hides a change-chain output carrying the policy's fingerprint with no index bound, so
  an unusual-path own-key output the phone shows would otherwise be hidden on the device.
  (MIGRATION §34)
- **Keystone 3 Pro over QR** (`modules/signers/keystone/`): pairing from the sync
  `crypto-multi-accounts`, per-group account keys via `qr-hardware-call` key derivation (firmware
  path allow-list enforced before any QR is shown), signing for every supported request kind —
  EVM legacy/EIP-1559/EIP-7702/personal/typed-data, TRON transaction/message, Solana
  transaction/message, Bitcoin PSBT (incl. taproot) and legacy message — and on-device address
  verification, allow-listed to what its Receive menu can show (EVM and TRON bip44-style accounts,
  Solana groups 0–49, BTC mainnet account-0 receive addresses — BTC testnet/signet, BTC group > 0
  and Solana group ≥ 50 answer `unsupported` and can never be confirmed on a Keystone). Every UR it exchanges — including
  `btc-sign-request`, `btc-signature` and `qr-hardware-call` — is encoded and decoded through
  `@qntx/ur` 4.1.0; digest self-checks before display, request-id binding (a `btc-signature`
  without its request id is malformed, `integrity`), `samePsbtContent` on returned PSBTs.
  `vectors/keystone/` + `scripts/vectors/keystone.ts` pin sync, sign and hardware-call frames
  against the vendor encoders and the firmware 3.2.2 sources. **Coverage:** written from the
  Keystone 3 firmware 3.2.2 and ur-registry sources and checked against vendor encoders only — not
  run on a device or an emulator.
- **OneKey hardware wallets over USB or BLE** (`modules/signers/onekey/`). **Coverage:** verified
  on the vendor emulators of Classic 1S firmware 3.21.0 and Pro firmware 4.21.0; Classic, Mini and
  Touch follow the same protocol under firmware gates written from source and are untested; no
  model has been tested on hardware. `"onekey"` in
  `HARDWARE_DEVICES` and a Protocol-V1 wire client with the driver over it. Pairing pins six
  secp256k1 account nodes (BIP-44/49/84/86, EVM, TRON) and the SLIP-10 ed25519 Solana leaf with
  root-fingerprint agreement and host-side address cross-checks; `sign` re-probes the pinned
  account node and re-checks the live device display against the confirmed one before any
  signing exchange. EVM legacy/EIP-1559/EIP-7702 (both stages)/personal/typed-data, Solana
  transaction/message, TRON transaction/message, Bitcoin PSBT (streaming `SignTx`, incl.
  taproot) and legacy/BIP-322 messages (BIP-322 on Pro ≥ 4.9.3). `@qntx/wallet/hardware` exports
  `oneKeyHidExchange` (64-byte report writes, whole-sequence answers), `oneKeyBleExchange`
  (MTU-split writes, concatenated notifications) and `oneKeyIo` — the host half of the OneKey
  transport; both collect an answer to its announced length exactly (a short HID report, an empty
  read or a BLE stream past the declared payload is `integrity`). `vectors/onekey/` pins
  emulator recordings at
  protocol and driver level for Classic 1S 3.21.0 and Pro 4.21.0; `onekey.yml` re-records them
  in CI.
- `@qntx/wallet-chains/evm`: `evmSigningPreimage` — the unsigned EIP-155/EIP-2718 bytes whose
  keccak is the signer's digest; `typedDataHashes` — the domain separator and struct hash of an
  EIP-712 document, for signers that take the two hashes; `@qntx/wallet-chains/bitcoin`:
  `legacyMessageHash`.
- **Ledger Nano S Plus / Nano X / Stax / Flex** (`modules/signers/ledger/`, device literal
  `"ledger"`). **Coverage:** verified on Speculos emulating the Nano S Plus with the pinned app
  releases (Bitcoin 2.5.1, Ethereum 1.24.0, Solana 1.16.0, Tron 0.8.2); Nano X, Stax and Flex run
  the same apps and APDU protocols but are untested, and no model has been tested on hardware.
  Pairing from the Bitcoin app (the only Ledger app that reveals the BIP-32 master
  fingerprint) with the four group-0 Bitcoin account keys pinned; per-family account keys from the
  Ethereum (chain-code public key), Tron and Solana apps, one app per `accounts` call; on-device
  address display for every family; signing of EVM legacy / EIP-2930 / EIP-1559 / personal_sign /
  EIP-712, TRON transaction / message / TIP-712, Solana legacy / v0 transaction and formal off-chain
  message, Bitcoin PSBT (P2PKH, P2SH-P2WPKH, P2WPKH, P2TR key path) and legacy message. Every
  device payload is recomputed from the request and checked against the plan digest before an APDU
  leaves the kernel; requests the device can only blind-sign read the app configuration first and
  fail `blind-signing-disabled` when the app's setting is off (the Tron app hash-signs personal messages, so they are blind too); the prompt says whether the device
  shows the request in full or signs blind. Refused before any prompt (`unsupported`): EIP-7702
  (not in the Ethereum app's default build since 1.24.0), raw Solana messages that are not formal
  off-chain documents, BIP-322 (Bitcoin app 2.6.0 is not released to devices), mixed-template
  PSBTs, non-mainnet Bitcoin. Fetching a non-bitcoin family's accounts re-proves the live device's
  identity first — those apps cannot reveal the master fingerprint, so one already-pinned key of
  the same family is re-fetched and must match byte for byte (`wrong-device` otherwise); the first
  fetch of a family is trust-on-first-use, like pairing, until an on-device address check
  confirms it.
- The Ledger protocol client (`modules/signers/ledger/protocol/`): a pure, Hermes-safe implementation of
  the documented APDU protocols of the Bitcoin (v2: merkleized PSBTv2, default wallet policies,
  bounded interactive client), Ethereum (incl. EIP-712 full mode and the legacy safe-chunk rule),
  Solana and Tron apps; no vendor SDK (none runs in the bare kernel runtime). Exact reply parsing:
  on-curve keys, addresses bound to the returned key, xpub depth and child checked, wallet
  addresses re-derived locally, PSBT yields bound to the input's own derivation under the policy
  key.
- `@qntx/wallet/hardware`: `ledgerHidExchange` (64-byte HID reports), `ledgerBleExchange` (BLE
  with MTU negotiation) and `ledgerIo` — the host half of the Ledger transport; framing violations
  fail `integrity`.
- `@qntx/wallet-chains/tron`: `tronTypedDataHashes` (domain separator and message hash of a TIP-712
  document, for signers that take the two hashes).
- Vectors: `vectors/ledger/framing.json` (the vendor's framing vectors) and
  `vectors/ledger/{bitcoin,ethereum,solana,tron}.json` (APDU transcripts recorded from the pinned
  device releases on Speculos, replayed byte for byte in unit tests). CI `ledger.yml` builds the
  pinned apps (`scripts/ledger/apps.json`) and re-checks the transcripts and the end-to-end
  signing flow live on Speculos.
- `@qntx/wallet-engine`: `EngineOptions.deviceIo` — the host's per-device-kind `DeviceIo`
  factory, wired once at `createWalletEngine` and the one transport seam for every hardware
  signature whatever the request's origin (absent, hardware signatures fail `unsupported`) — and
  `engine.signers`, the engine's
  external-signer orchestration. `getState`/`store.subscribe` reports the one `SignerActivity`
  allowed at a time (a card operation publishes the kernel's `card` steps, a hardware operation
  `device` exchanges); a second start refuses `conflict` without touching the running operation;
  a vault lock cancels it. `cancel()` ends the running operation; `verifyAddress` shows an
  address on the device's screen; `fetchAccounts` pulls one family's pinned accounts (Bitcoin
  once per enabled network, the others once; it takes the same `verify` as `hardware.begin`
  `accounts`) and re-runs that family's discovery check. Every
  engine signature routes through it — vault material signs directly, a card request runs a card
  task, a hardware request a device operation — and the typed refusals (`unsupported` for
  sessions/Spark/Nostr, `invalid-input` for a Fiat24 session grant) land before any activity
  publishes. `SignersController`, `SignerActivity`, `SignerFamily` and `SignersState` are
  exported. (MIGRATION §32)
- `@qntx/wallet-engine`: the account tree knows external custody. Wallet entries carry
  `custody` and `state` — an `incomplete` card wallet (still waiting on a member card) holds no
  groups and no addresses: `nextReceiveAddress` and sends on it throw until it is `ready`.
  `AccountGroup.signer` marks a family only the signer can answer as `device-required` — neither
  used nor an error in discovery, and a group whose every chain family waits on the signer ends
  the scan. (MIGRATION §32)
- `@qntx/wallet`: `chain.exportAccount` / `chains(wallet).exportAccount` — the selected account's
  public keys (the EVM account node with its chain code, per-family leaf keys, the Bitcoin
  account xpub), behind user verification, from derived (vault) or pinned (hardware) material.
- `@qntx/wallet-engine/qr`: QR signer mode — `createQrScanner` folds scanned UR frames into a
  payload, `readQrRequest` decodes and re-checks it, `inspectQrRequest` decodes without binding,
  `qrSigner({ engine, wallet }).prepare` binds it (per-family network binding, account match,
  refuse-list) into an ordinary engine request (`prepare` → approve → `respond`) and `exportAccount`
  produces the pairing QR (`crypto-hdkey`, `crypto-account`, `crypto-multi-accounts`) with a
  `discloses` list for the prompt, `qrFrames` animates the answer. A scanned SIWE sign-in is the
  `qr-sign-in-unverified` `danger` finding — `approve` needs it acknowledged. `inspectQrRequest`
  reports `displays`, one `QrDisplay` per network encoding a frame can mean (a coin-type `1'` PSBT
  yields `tb1…` testnet/signet and `bcrt1…` regtest displays; mixed or missing coin types are
  `network-ambiguous`), and `shownBy` is set only where a device display has a primary source.
  The export prompt is rendered from the requested nodes — one row per key the QR discloses.
  The counterpart side:
  `readQrExport`, `qrSignRequest`, `readQrSignature` and the `QrLink`/`QrSignInput`/
  `QrSentRequest`/`QrSignature` types. `WatchAccount.qr` persists a phone link on a watch-only
  account so a Web session can sign through it without holding keys. The signer serves vault,
  card and hardware wallets (imported keys stay refused), resolves the request's own family only
  and surfaces a family with no pinned material as `device-required`; the master fingerprint is
  the device's for hardware and the group's `btc.bip84` mainnet fingerprint for vault and card.
  `QrEngineSurface` includes `signers: { apis }`. A request scanned this way carries the origin
  `{ kind: "qr", declared? }`, attributed to the counterpart's self-declared label (display-only,
  untrusted). (MIGRATION §33)

### Changed

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
- `@qntx/wallet`: every kernel prompt shown through the keystore is bound to the platform it
  reports (`PROMPT_BOUNDS`: iOS 8 lines / 400 code points, Android a 60-code-point title and 12
  lines / 640 code points); a prompt that cannot fit shows the blind title and a line counting
  the withheld lines — never clipped text.
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
  staging and production gateway deploys are isolated and roll back on a failed smoke; `.github/rulesets/`
  defines the branch, tag and environment protection an admin applies with `apply.sh`.
- `verified` is also true for a token-list entry whose list decimals equal the
  on-chain decimals (it was true only for the built-in table).
- EVM token metadata (`decimals`, and `symbol` for custom tokens) is read once per unlock in batched
  `aggregate3` calls of at most 300, instead of two `eth_call`s per token per refresh.
- `@qntx/wallet-chains`: EIP-712 `domain` keeps only the keys `types.EIP712Domain` declares; an
  undeclared `chainId`, `verifyingContract`, `name` or `salt` is neither shown nor used for
  recognition, the execution-grant refusal or the chain-id check (signatures are unchanged).
- `@qntx/wallet-engine`: the engine opens one `EngineStore` per unlock session and hands it to
  every controller; controllers no longer open stores of their own, and the store is closed on
  lock.
- `@qntx/wallet-engine`: relay metadata sync (`metaSync`) starts in the background at unlock; the
  request pipeline and transaction recovery no longer wait for the relays.
- `@qntx/wallet-engine/gateway/contract`: a history `cursor` above
  `HISTORY_CURSOR_MAX` (2^63 − 1) and quote amounts wider than uint256 (EVM swap,
  bridge) or u64 (Solana swap) are `400 invalid-request` before any upstream call.
- `@qntx/wallet-engine/gateway/contract`: RPC cost scales with caller-sized arrays: per started 10
  elements of `getMultipleAccounts` / `getSignatureStatuses` (1 each) and `eth_getProof` storage
  keys (3 each); `eth_simulateV1` pays 3 per simulated block or call, whichever is more.
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
- Multicall3 is per network; ZKsync Era and ZKsync Sepolia use 0xF9cda624FBC7e059355ce98a31693d299FACd963.
- Snapshot votes (snapshot.js Vote types) are a decoded family.
- Solana: SPL `Transfer`, `Burn`/`BurnChecked` and Stake `Split` signed by the account are decoded.
- `TrackedTransaction` gains `durableNonce?: { account: string | undefined; value: string }`.
- gateway: an upstream `429` is no longer an outage: it cools the whole provider account down for
  `min(Retry-After, 30 s)` (5 s default) and fails over. An attempt timeout counts against the
  breaker only when the provider's liveness probe (`eth_chainId`, `getHealth`, Esplora tip height,
  CoinGecko `ping`) also fails. Nothing a client sends can open a breaker for other users.
- gateway: IPv6 clients are charged on their `/64` and `/48` (IPv4 `/24`).
- gateway: the flood limiters count requests and batch entries; cost lives in the share limiter.
- `requests.prepare({ method: "evm-sign" })`: `origin` is optional; without it the request is the
  wallet's own and only `evm.typed-data` is accepted.
- `@qntx/wallet-engine`: a Spark sats payment becomes `failed` only when the operator lists its
  transfer as expired or returned. An id the operator does not list stays `unknown` at any age
  (previously `failed` at once on a complete listing, or after 30 minutes) — operator lag can no
  longer turn a committed payment into "failed" and invite a second payment. A shortfall is
  checked against the balance before anything is recorded and fails `insufficient-funds`.
- `@qntx/wallet-chains` / kernel prompt: a 32-byte message (digest-length hazard, still blind)
  shows its bytes as `Data 0x…`, and its text only when every code point prints plainly; the same
  in every family. Message decoders keep a leading BOM, so a 32-byte message starting with EF BB BF
  no longer measures 29 bytes and escapes the digest-length rule.
- `@qntx/wallet`: the `solana.transaction` `message` transport bound is 4096 bytes (was 1232).
- `@qntx/wallet-kernel`: `chain.sign` signs v1 `solana.transaction` requests under the same
  blind-signing policy (was `invalid-input`); a v1 message as `solana.message` is still refused.
- `@qntx/wallet-engine`: a definite broadcast refusal is stored durably as `failed`; if the store
  cannot take it (vault locked, write error) the row is retried by its own loop and replayed at the
  next unlock. A `signed` row recovered at unlock becomes `submitted` with `rebroadcast: false` —
  watched on chain, never resent. `lock()` clears transaction rows and call batches from memory.
- **gateway:** client shares, POLICY budgets and flood limiters (IP 3,000 / RPC 1,500 / default 400 per 60 s) are sized from measured engine usage so a fresh all-family cold start uses at most a third of one client prefix's allowance; the README states the concurrency target and its arithmetic.
- **ci:** the gateway deploy workflow checks required secrets before deploying, rolls back only when the previous version shares the Durable Object migrations (Cloudflare refuses rollbacks across a migration) and alerts otherwise; a new `gateway-workerd` job boots the real worker with Durable Object and rate-limit bindings and runs the smoke plan and budget scenarios against stub upstreams, plus `wrangler deploy --dry-run` for both environments.
- `@qntx/wallet-chains`: Velora/Paraswap Delta orders deliberately stay blind: the verifying contract is an owner-upgradable module adapter, so the order bounds are not fixed by the signed bytes. 1inch Fusion orders stay blind: their extension's amount getter decides the taking amount and is only hash-committed in `salt`.
- `@qntx/wallet-chains`: a raw `personal_sign` whose text begins with `I agree to access my
  profile.` or `I agree to access my Fiat24 profile.` is now blind with `"fiat24-session-grant"`,
  whatever its origin. The wallet signs Fiat24 grants only when it builds them itself.
- `@qntx/wallet-chains`: an ERC-7821 batch's `DisplayIntent.warnings` now includes the warnings of
  its inner calls. The kernel prompt now also shows the warnings of each Safe inner call.
- **build:** gzip size budgets for every new entry (engine `apps`, `apps-fiat24`,
  `apps-hyperliquid`, `apps-polymarket`, `push`, `qr`, `walletconnect`; chains `tron`) and a
  raised chains `bitcoin` budget, each set from measurement by `scripts/size-check.ts`.
  `scripts/check-kernel-budget.ts` records the owner decision of 2026-11-22 keeping the
  `hyperliquid-l1-agent` scheme at 16 384 B and sets the decoder lines from measurement with ≥ 5 %
  headroom (hyperliquid, polymarket, fiat24).
- `@qntx/wallet-engine`: one recipient rule for every request. Outflows, swap and bridge settlement
  recipients, staking withdrawals and delegations, nested calls, and the typed-data order
  receivers, Seaport consideration recipients, Safe destinations and Hyperliquid user-signed
  destinations are assessed for `first-recipient` / `address-poisoning`, except the signer itself
  and burned outputs. `solana-sign` transactions and `bitcoin-sign` PSBTs are assessed too.
  `PreparedRequest.signer` carries the resolved signing address.
- `@qntx/wallet-chains/evm`: a typed-data `bytes` value must be even-length hex; no decoder accepts
  an odd-length one (ox left-pads it when hashing, so the display would not match the signed
  bytes).
- **@qntx/wallet-chains** — signing is split into `plan → backend → assemble`. Each family entry
  exports a pure planner and assembler: `planEvm`/`assembleEvm` (`/evm`), `planTron`/`assembleTron`
  (`/tron`), `planSolana`/`assembleSolana` (`/solana`), `planBitcoinPsbt`, `planBitcoinMessage`,
  `assembleBitcoinPsbt`, `assembleBitcoinMessage` (`/bitcoin`). A plan is plain, serialisable data
  (`SignTask[]`: scheme `ecdsa-secp256k1` | `bip340` | `ed25519`, path, public key, digest or
  message, BIP-86 tweak) and carries no key material; EIP-7702 is a two-stage plan
  (`Assembled.kind === "next"`). Assemble verifies every 64-byte signature against the task key
  (ECDSA by key recovery; BIP-340 under the tweaked output key; Ed25519 under strict RFC 8032) and
  refuses anything else with the new `ChainErrorCode` `invalid-signature`. A high `s` is
  normalised to low `s` rather than refused, since the qntx card returns `s` unnormalised
  (protocol §12.1); both are owner decisions.
- **@qntx/wallet-chains** — the `*/sign` entries add one local task signer per family
  (`signEvmTask`, `signTronTask`, `signSolanaTask`, `signBitcoinTask`); the raw-key functions
  (`signEvmTransaction`, `signBitcoinPsbt`, …) keep their signatures and outputs and now run
  plan → task signer → assemble. Legacy P2PKH sighashes still come from `@scure/btc-signer`.
- **Kernel** — `chain.sign` prepares with public keys only (`PublicMaterial`), keeps the plan
  across the verification prompt, and signs it through a `SigningBackend` (today the vault seed /
  imported key). `wallet.accounts` derives addresses and xpubs through the same `PublicMaterial`.
  Software-wallet signatures are byte-identical (every existing vector unchanged).
- **Kernel** — PSBT inputs and other requests that today failed only after approval (taproot
  input without its internal key or with a non-default sighash, a sighash outside the allow-list,
  undecodable typed data) are refused before the prompt with `invalid-input`. A taproot input
  carrying `tapLeafScript` or `tapMerkleRoot` is refused instead of also receiving a script-path
  signature.
- `@qntx/wallet-native`: the library's Android manifest declares nothing for card wallets —
  `android.permission.NFC`, `android.permission.HIDE_OVERLAY_WINDOWS` and the optional
  `android.hardware.nfc` feature are the host app's to opt into (the package README lists the
  exact entries; the harness declares them itself). The iOS pod weak-links CoreNFC. Host apps that
  offer card wallets on iOS add the NFC tag-reading entitlement, `NFCReaderUsageDescription` and
  the ISO 7816 select identifiers `F0716E74780101`, `D2760000850101` (see the package README).
  (MIGRATION §30)
- **gateway:** client addresses are parsed strictly: IPv4-mapped IPv6 addresses are keyed by their embedded IPv4 /24, and a deployed gateway answers `400 invalid-request` to a request without a usable `cf-connecting-ip`.
- `@qntx/wallet-engine`: a Bitcoin balance read derives UTXOs from the `/scripthash/:h/txs` page
  when it is complete and remembers templates verified unused for the discovery interval, skipping
  them until it expires — except `btc.bip84`, the default receive template, which is always
  re-scanned for deposits. Both chains of a scanned template are walked, the change chain out to
  the sealed change mark's reach.
- `@qntx/wallet-engine`: a held Solana mint with 0 decimals and a supply of 1 is an NFT and no
  longer appears in the token list (custom tokens excepted).
- Gateway: `PriceCache` / `priceCacheOf` become the shared `EdgeCache` / `edgeCacheOf(origin, open)`;
  `GatewayOptions.nfts.cache` is required.
- `@qntx/wallet-chains`: `PublicMaterial` gains `fingerprint()` (seed material: hash160 of the
  master public key's first four bytes; imported keys fail `integrity`), and `signStages` splits
  `signPlan` so an external signer can drive one stage per device exchange.
- `@qntx/wallet-engine`: the account tree skips seed-bound services for `custody !== "vault"`
  wallets — `discoverSpark`/`refreshTotals`/`driveSpark` never touch Spark, a `device-required`
  family counts as unused rather than an error — and meta sync signs only for vault wallets.
- Docs: `docs/incident-response.md`, `docs/device-checklist.md` and `apps/gateway/OPERATIONS.md`
  ship; SECURITY.md rewrites the threat model per attacker and platform and states the rule that
  an upgrade never discards persisted user data from the first production release on. Fenced
  TypeScript blocks in README.md, MIGRATION.md and every package/app README compile under
  `bun run typecheck`.
- `@qntx/wallet-engine`: `BitcoinPsbtInput.sign[].template` accepts all four account templates —
  a QR counterpart may name `btc.bip44`/`btc.bip49` where a dApp only uses `btc.bip84`/`btc.bip86`.
  Hosts switching on the template need the new members. (MIGRATION §33)
- Every CI and release tool resolves from the lockfile or an exact pin. Bun is pinned once by the
  root `packageManager` field (`bun@1.4.4`): every `setup-bun` step reads it, and the reusable
  `ci-bun`/`ci-hermes` workflows receive the same version from a `toolchain` job. CI runs Vitest
  through the locked `vp test`, never a registry-resolved `bunx vitest`; the publish job pins
  Node 24.22.3 and with it npm 11.19.1. Locally the field documents the version; nothing refuses
  another Bun. `scripts/check-toolchain.ts`
  (in `lint`) fails a `bunx`/`npx`/`npm exec` of a bin no root or working-directory manifest
  declares, a reusable-workflow call without the pinned Bun input, and a non-exact `setup-node`
  version; `scripts/check-dist-deps.ts` (in `check:pkg`) also fails a declared runtime
  dependency no packed file imports. The checker also covers composite actions (any
  `action.yml`), Dockerfiles (`FROM` by digest, `RUN` through the command rules) and every
  `uses:` ref (a 40-hex commit, reusable workflows included); it fails `curl … | sh` installers,
  `npm install`/`bun add`/`pnpm dlx`/`yarn dlx`, `bun install` without `--frozen-lockfile`,
  `pip install` without `--require-hashes`, tool words inside quoted `sh -c` bodies, container,
  service and `docker run` images without a digest, a non-exact `setup-java` or
  `foundry-toolchain` version, a multi-line `minimumReleaseAgeExcludes` entry that is not an exact
  pin, and a `bun.lock` with no `bunfig.toml` cooldown beside it; its header lists what it does
  not cover. CI pins Temurin 25.0.5+8 and Foundry v1.10.0, the OneKey emulator images install
  hash-pinned Python requirements, `apps/harness` gets the 7-day cooldown, and the Browser
  workflow's consumer smoke installs its third-party closure from a committed
  `package-lock.json` with lifecycle scripts disabled. `bun run test` now also runs the root
  `scripts/**/*.test.ts` suite (the gate scripts' own tests), which no gate ran before.
  `bunfig.toml`'s `minimumReleaseAgeExcludes` lets exactly `@qntx/fiat24@0.1.0` (published 2026-11-23) and
  `@qntx/ur@4.1.0` (published 2026-11-25), coordinated first-party releases with SLSA provenance,
  skip the 7-day cooldown; each entry is removed once its release is a week old (2026-11-30 and
  2026-12-02).
- SECURITY.md is rewritten for the shipped surfaces (card ops, external signers, the sealed
  change mark); every source citation is a `file.ts` + symbol pair that
  `scripts/check-security-anchors.ts` verifies in `lint` — a line-number anchor or a dangling
  path/symbol fails the gate.

### Fixed

- `@qntx/wallet-native`: the kernel bytecode is compiled with `-Xes6-block-scoping`. hermesc
  leaves ES6 block scoping off by default, so on React Native a closure over a loop-scoped
  `let`/`const` in kernel code saw the last iteration's value. The kernel now refuses to start in
  a runtime without block scoping.
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
- `@qntx/wallet-engine` balances: timed refreshes called `refresh` with the wrong arguments; bip44, bip49 and
  bip86 balances no longer read 0 and a watched Bitcoin address no longer throws; Solana token
  balances sum every token account per mint (Token and Token-2022); built-in tokens show on every
  network that lists them without being added; watch accounts persist across unlocks.
- `@qntx/wallet-engine` sends: an ambiguous broadcast no longer leads to a double payment — the id
  comes from the signed bytes, the EVM nonce and Bitcoin inputs are held before the network call,
  and the tracker rebroadcasts the same bytes until the outcome is known, including after a
  restart. A Bitcoin transaction's inputs are released on every terminal state, and one whose
  input a confirmed foreign transaction spends settles `replaced`.
- `@qntx/wallet-engine` Bitcoin fee bumps: replacements spend only the original's inputs and the
  original account; coin selection spends only confirmed outputs and the wallet's own unconfirmed
  change, and replacements never add unconfirmed inputs; replacement and CPFP fees use a
  per-template vsize estimate and the replacement's own size for the BIP-125 rule-4 floor; a
  cancel that cannot pay its fee is refused.
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
- `@qntx/wallet-engine` Solana tracking: a transaction ends `dropped` only on a proof. A blockhash
  transaction needs the block height (read first) past `lastValidBlockHeight`, the polling
  endpoint's own `isBlockhashValid` saying the blockhash is dead, no entry at any commitment, a
  status from a bank at least as far along, and the answering node's history reaching back before
  the submission (`getFirstAvailableBlock` and its `getBlockTime`, which cover the blockstore and
  BigTable the status lookup searches) — otherwise it stays `submitted`. A durable-nonce
  transaction (first instruction `AdvanceNonceAccount`, from the wallet or a dApp) is never
  dropped by block height: only when the nonce account (read at `finalized`) no longer holds its
  nonce, a bank at least as fresh has no status entry, and the nonce account's signature history
  covering the time since submission does not list it (a listed signature settles the row); one
  whose nonce account was loaded from a lookup table stays tracked until it lands. Every read of a
  drop proof comes from one pinned upstream, and a configured host endpoint must prove the same
  drop — without one, three consecutive polls spanning more than one blockhash processing age
  (150 blocks × 400 ms) — and the upstream the poll is pinned to never corroborates itself (after
  a gateway failover to a host endpoint the host-only rule applies); the self-corroboration rule
  also governs TRON drops and reorgs. A transaction landing between the reads, a lagging
  endpoint, a single gateway upstream or a long time offline can no longer end a landed
  transaction `dropped`.
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
- EVM sends now fill a nonce freed by a refused or dropped transaction before signing anything
  higher: `EvmNonces.next` answers the lowest free nonce at or above the chain count, a prepared
  request sitting above a freed nonce is stale at approval, `reserve` refuses to sign above a gap,
  and a transaction already broadcast above a gap carries an explanatory `error` note on its tracked
  row until a send fills it.
- A storage failure after a transaction's bytes may have left the device no longer fails the
  request: the durable pre-broadcast record stays the source of truth, the row stays tracked in
  memory and the write is retried on the next poll. `wallet_sendCalls` bookkeeping writes are
  best-effort for the same reason.
- A broadcast settling after lock→unlock no longer writes into the new session's transactions or
  re-arms its timers.
- Spark payments that throw after the commit call are no longer reported failed unless the Spark
  operator's own listing shows no such transfer; otherwise they stay `unknown` (WebLN `-32010`).
  Spark errors are categorized by class before message text (a 502 mentioning "rejected" is a
  network failure).
- Meta sync and token metadata writes started before a lock no longer land in the next session;
  `addToken`/`setTokenHidden` refuse while locked.
- `@qntx/wallet`: the type-level guard that every bytes-carrying RPC param field is classified
  secret or public now sees bytes in union members, nullable array elements, `ArrayBuffer`s and
  `Map`/`Set` values.
- scripts: the source boundary checker no longer skips `.js`/`.cts` files, nested
  `generated`/`dist`/`node_modules` directories or symlinks, and refuses `#imports`, tsconfig
  `paths`, absolute specifiers, `require()` and `import.meta.glob` in library source.
- Speeding up or cancelling a legacy (type-0) EVM transaction re-signed it at the original, un-bumped gas price.
- `@qntx/wallet-engine`: RPC answers missing a field the spec guarantees (Solana
  `lastValidBlockHeight`, `blockhash`, `absoluteSlot`, `blockHeight`, rent, lamports, epoch; EVM
  nonce, gas estimate, gas price, fee history, receipt `status`) are malformed answers, never read
  as 0. A missing `lastValidBlockHeight` previously made a live transaction look expired; a receipt
  without `status` looked successful.
- `@qntx/wallet-engine`: Bitcoin UTXO lock snapshots are written in order and a failed write is
  logged instead of an unhandled rejection; a restart re-locks the inputs of live tracked
  transactions, so a lost snapshot cannot make spent outputs selectable.
- **scripts:** the bundle boundary check builds kernel entries exactly like the kernel build (same resolve conditions, nothing external) and judges workspace code reached through third-party packages; `new URL(literal, import.meta.url)` and `import.meta.resolve(literal)` are judged as module references.
- `@qntx/wallet-chains`: the Solana max fee now counts the signatures that ed25519, secp256k1 and
  secp256r1 precompile instructions verify (`data[0]` per instruction, legacy, v0 and v1), as
  Agave charges them; the displayed bound was up to 65 000 lamports below the fee charged on
  pinned mainnet transactions. A Solana instruction with empty data now parses (it is valid on
  chain) and is classified like any other undecoded instruction.
- `@qntx/wallet-chains`: EIP-712 and TIP-712 documents whose `string` values (domain or message,
  nested structs, arrays) contain hidden or reordering characters are blind `message-bytes`,
  exactly like text messages; the kernel prompt leads with the hidden-characters warning. RGI
  emoji sequences stay described.
- Importing a single private key now triggers a backup upload (coverage counted only HD wallets).
- A restore into a fresh vault that skipped a wallet needing its BIP-39 passphrase no longer lets
  the first sync overwrite the only cloud copy of that wallet.
- A Web passkey restore asserts with the envelope's credential ids, not the destination vault's
  (a fresh vault has none, so the ceremony failed).
- `@qntx/wallet-engine`: a refused broadcast whose follow-up lookup of whether the network
  holds the bytes itself fails resolves `unknown`, not `failed` — the row stays `submitted`
  instead of latching a refusal that invites a paying retry.
- `@qntx/wallet`: a zh-Hant locale tag or a Traditional region (zh-TW, zh-HK, zh-MO) no longer
  gets Simplified-Chinese verification prompts — the tag parses as BCP-47 (an explicit script
  maps Hans to zh-Hans and anything else to English; without one, TW/HK/MO map to English, else
  zh-Hans).

### Security

- `@qntx/wallet-kernel`: a request whose secret field (`password`, `prf`, `prfWallet`,
  `prfBackup`, `mnemonic`, `passphrase`, `secret`, `answers` — now exported as `SECRET_FIELDS` from
  `@qntx/wallet/protocol`) shares memory with another field fails `invalid-input` before anything
  runs. Structured clone keeps shared objects and views of one buffer, and the kernel wipes a
  secret in place once it is consumed: a verification password aliasing a `chain.sign` message
  zeroed the message between the prompt and the sign pass, so the kernel signed zeros while the
  prompt had shown the original bytes; a mnemonic aliasing its passphrase derived another wallet.
- `@qntx/wallet-kernel`: a whole vault image put back to an earlier committed state (a deleted
  wallet or retired backup key restored, blind signing re-enabled) and a zeroed password failure
  counter are detected through the vault anchor above, within the limits SECURITY.md lists per
  host.
- `@qntx/wallet-kernel` + `@qntx/wallet-native`: the backup password is collected inside the
  kernel runtime through `SecureInput` on React Native — the main runtime sees only
  `idle | empty | filled | submitted`, never the characters; a compromised runtime can still draw
  a look-alike field, which the kernel's own labels and the pending-request gate tell from the
  real one (SECURITY.md).
- `@qntx/wallet-chains/solana`: an account the prompt names that resolves through an address
  lookup table is no longer shown as verified — a v0 signature binds only the compiled bytes
  while the table contents are caller-supplied; any recorded table substitution makes the intent
  blind `lookup-table-account`, and engine-built transactions pin named accounts back to static
  metas so the prompt stays described.
- `@qntx/wallet-chains`: an EIP-7702 authorization or `eip155` id with chain id 0 — the
  chain-universal form that replays on every chain — is refused before any prompt, and only
  canonical eip155 ids parse.
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
- `@qntx/wallet-engine`: a dApp `solana-sign` transaction is bound to the session's cluster before
  the prompt — Wallet Standard `solana:signTransaction` (one or many) and
  `solana:signAndSendTransaction`, WalletConnect `solana_signTransaction`,
  `solana_signAllTransactions` and `solana_signAndSendTransaction`. A recent blockhash must be
  valid on the selected cluster under the same corroboration rule a wallet send uses; a
  durable-nonce transaction's nonce account must exist on that cluster holding exactly the
  message's nonce (a nonce account loaded from a lookup table cannot be checked and is refused).
  Anything else fails with the new `SolanaClusterBindingError` (`ChainError` `invalid-request`,
  `reason: SolanaBindingReason`); a gateway-only mainnet binding adds `reads-unverified`. A devnet
  session previously signed transactions that were valid on mainnet.
- `@qntx/wallet-engine`: a user-set custom RPC is the primary endpoint, never its own corroborator.
  The host endpoints of the network cross-check it, or the gateway when there are none; with
  neither, the network is treated like a gateway-only one (TRON and Solana testnet sends are
  refused, mainnet reads are `reads-unverified`). `Independent` (the `NetworkController`
  cross-check client) gains `source: "host" | "gateway"`; history marks entries verified only when
  a host endpoint answered.
- `@qntx/wallet-engine`: a Spark cooperative exit is assessed against known bitcoin addresses
  (`first-recipient`, `address-poisoning`). Approval and permission grantees — token and operator
  spenders, Solana stake authorities, TRON permission keys, Morpho `authorized` and Aave
  `delegatee` — are assessed like recipients; revocations name nobody.
- `@qntx/wallet-chains`: hidden or reordering characters in a typed-data type name, field name,
  field type or `primaryType` make the document blind (`message-bytes`), like the same characters
  in a value.
- `@qntx/wallet-kernel`: card `add` requires a `verify` factor (`invalid-input` without one), like
  hardware `pair` — it adopts a card's whole wallet as confirmed own material, and before it a
  holder of an unlocked phone and their own genuine card could plant that wallet presence-free.
  `card.begin` re-checks the session after every verification, before change marks commit or the
  first tap. (MIGRATION §30)
- `@qntx/wallet-engine`: a hostile Esplora endpoint could seal a far change mark through the
  wallet's own send — claim the change chain used out to an invented coin near
  `BITCOIN_SCAN_LIMIT` and have the user spend it, leaving every later scan of that template
  walking ~2000 change addresses. A send, replacement or CPFP that would spend a change coin past
  the sealed scan reach now reads that coin's transaction on the second endpoint first and
  refuses (`invalid-request`) when that endpoint does not serve it; with a single endpoint the
  ratchet remains a documented residual (SECURITY.md). (MIGRATION §35)
- `@qntx/wallet-engine`: accounts whose serving entry is unconfirmed are no longer subscribed for
  push notifications and no longer count as known addresses for the history's
  `address-poisoning` flag. (MIGRATION §35)

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

[Unreleased]: https://github.com/qntx/wallet/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/qntx/wallet/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/qntx/wallet/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/qntx/wallet/compare/v0.10.0...v0.11.0
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
