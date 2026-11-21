# @qntx/wallet-engine

App-side controllers over a [`@qntx/wallet`](https://www.npmjs.com/package/@qntx/wallet) `Wallet`:
the account tree, Spark payments, zaps, encrypted metadata sync and cloud backup. Controllers
expose read-only Zustand stores; every I/O dependency (`fetch`, randomness, clock, storage,
relays, cloud) is injected. The engine never holds signing keys — every wallet-owned outflow goes
through the enclave's per-operation approval.

Peer dependencies: `@qntx/wallet` (the exact release — engine and wallet must agree on the
protocol), `@qntx/wallet-chains` (exact), `@qntx/spark` and `@qntx/nostr`. The exact ranges are
this package's `peerDependencies`.

```bash
npm install @qntx/wallet-engine @qntx/wallet @qntx/wallet-worker @qntx/wallet-chains @qntx/spark @qntx/nostr
```

```ts
import { createWalletEngine } from "@qntx/wallet-engine";
// in-app-browser provider injection and the WebView bridge:
import { injectedScript, createBrowserBridge } from "@qntx/wallet-engine/connect";
import { openIndexedDbEngineStore, openIndexedDbPublicStore } from "@qntx/wallet-engine/idb";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const engine = createWalletEngine({
  wallet, // from createWebWallet / createNodeWallet / createNativeWallet
  verifyEvent, // the host's native verifier, the same one given to the wallet
  sparkNetwork: "mainnet",
  fetch: globalThis.fetch.bind(globalThis),
  random,
  now: () => Date.now(),
  weblnAlias: "Example",
  lightningMaxFee: (amountSats) => Math.max(10, Math.floor(amountSats / 100)),
  logger: { warn: (message, error) => console.warn(message, error) },
  openStore: async () =>
    openIndexedDbEngineStore({
      name: "app-engine",
      dataKey: await wallet.dataKeys.get("wallet-db"),
      random,
    }),
  showCallsStatus: ({ origin, txIds }) => showCallsSheet(origin, txIds),
  publicStore: await openIndexedDbPublicStore({ name: "app-public" }),
});
```

`EngineOptions.gateway: { url }` is the wallet gateway: tried first for RPC and Esplora on the
networks it serves, and the only source of prices, swap and bridge quotes and EVM history. The
engine sends it a fresh `x-client-id` per session and per scope.

The engine follows the wallet's lock state: unlocking opens the encrypted `EngineStore` and starts
the selected account group; locking flushes pending writes, closes every Spark client, stops
polling, and ignores late results from the old session. Transaction and request state stays
readable until the next unlock reloads it.

## Surface

Each controller member is a `HostController<…>` facade: the host methods listed for it plus a
read-only `store` (`getState`, `getInitialState`, `subscribe` — use it with zustand's `useStore`).
Lifecycle, wiring between controllers and `setState` stay inside the engine. Name a member's type
as `WalletEngine["spark"]`; every type in these signatures (`AccountRef`, `TrackedTransaction`,
`PrepareParams`, `RequestResult`, the request displays, `SparkTokenBalance`, …) is exported from
the package root.

- `engine.networks` — configured chain networks (`enabled`, `info`, `endpoints`), their read
  clients (`client`, `solanaRpc`, `esplora`) and custom RPC endpoints (`addRpc`).
- `engine.assets` — token and balance reads per account. A Bitcoin balance counts outputs
  protected as possible inscription or rune carriers in `protected`, apart from `native`; user
  freezes are not part of the balance (a frozen coin still counts in `native`).
- `engine.prices` — fiat spot prices and valuations, display-only.
  `setVisible` gates polling on app visibility; `setCurrency` switches the persisted quote
  currency and refetches.
- `engine.portfolio` — `portfolio.group({ walletId, groupIndex })` values one account group:
  a `Valuation` with an exact decimal `total`, a `stale` flag and the `unpriced` holding count.
- `engine.transactions` — tracked transactions (`store`, `txById`) and coin control; it builds,
  signs and records nothing itself — sends, replacements and dApp signatures go through
  `requests`. A broadcast whose outcome is unknown resolves `submitted` and the engine
  rebroadcasts the same signed bytes — never re-send it. Inclusion is not finality: a
  transaction in a block carries `block` (hash and height — EVM block number, Bitcoin height,
  Solana slot) and stays tracked at a low frequency until `final` — EVM `finalized` tag, six
  Bitcoin confirmations, Solana `finalized` commitment. A reorg returns it to `submitted`
  (polling and rebroadcast resume) and a `final` transaction is never polled again. Coin
  control: `setUtxosFrozen` / `frozenUtxos` persist per-account freezes, and `inputs` on a
  send picks the outpoints (naming a UTXO protected as a possible inscription carrier is the
  opt-in to spend it).
- `engine.requests` — every wallet-owned outflow becomes a request here (`prepare`, `approve`,
  `reject`, `outcome`, the sign log).
  `approve(id, method, { verify, acknowledged })` — `requiredAcknowledgement(request)` returns
  the `danger` findings and checks the host must have shown; approving without them throws
  `AcknowledgementRequiredError`. If a re-simulation changes the outcome at approval it throws
  `SimulationChangedError` and the request stays approvable. A blind request throws
  `BlindSigningDisabledError` — enable `wallet.vault.setBlindSigning` and approve it again.
- `engine.history` — one newest-first activity list per account group
  (state keyed `${walletId}:${groupIndex}`). `load`/`loadMore` page backwards while `hasMore`;
  entries carry `verified`, `origin` and `flags`; `truncated` lists the networks whose provider
  left unpagable gaps.
- `engine.addressBook` — contacts, synced through `metaSync`.
- `engine.connections` — dApp sessions and trusted origins; pass it to `createBrowserBridge`
  (`checkOrigin`, `invalidateOrigin`).
- `engine.eip1193`, `engine.nip07`, `engine.webln`, `engine.solanaWallet`,
  `engine.bitcoinWallet` — the injected provider handlers for each wallet standard (`handle`, and
  `subscribe` where the standard has events).
- `engine.phishing` — the phishing list (`check`, `sync`, `trust`, `untrust`); its lifecycle is
  independent of the lock state.
- `engine.spark` — Spark reads and receives, with token balances (`SparkAccountState.tokens`); it
  has no send method — every payment, token sends included, goes through `requests`. Token sends
  are `pay` with `token` and resolve `"token"`. Every payment is recorded before it is sent; a
  `pending` result carries that record (`SparkPaymentRecord`) when the commit response was lost —
  show it in flight, never failed, and never pay again. The engine reconciles open records against
  the Spark operator (after unlock, then on a backed-off poll) and lists them in
  `SparkAccountState.payments` and in `engine.history` until they settle or fail. Cooperative
  exits take `amountSats` (what arrives at the Bitcoin address, the debit adds the quoted fee)
  and require `maxFeeSats`.
- `engine.accounts` — wallets and account groups, selection, names,
  hidden groups, Spark group discovery and social identity bindings.
- `engine.watch` — watch-only accounts: `add`, `rename`, `remove`, `list` and per-network
  `assets`.
- `engine.metaSync` — NIP-78 (kind 30078) metadata documents, NIP-44 encrypted to the wallet's
  group-0 Nostr identity; pull before publish. Merge is not plain per-entry LWW: a record's
  identity is immutable, deletes are terminal, and remote stamps too far in the future are
  refused.
- `engine.backup` — cloud backup over an injected `CloudStore`. The backup password is
  Argon2id-stretched, needs at least 12 characters and must reach zxcvbn's top score — rate a
  draft with `backupPasswordStrength(password)`, a refused one throws `weak-password`. A
  restore adopts the file's backup key only on a React Native kernel passkey restore; every
  other restore leaves backup off until it is enabled again.
- `engine.zaps` — `prepare` only: signs the NIP-57 request with any `NostrSigner` and fetches the
  invoice; the invoice itself is paid through `requests` like any other outflow.
- `engine.names` — `resolve` forward-resolves an ENS name for a send on a network.
- `engine.delegation` — an account's EIP-7702 delegation state on a network.
- `engine.bridges` — gateway Across bridge `quote`/`status`, display-only; `quote` requires
  `maxFeeBps`, the relay-fee ceiling in basis points of the input amount.
- `engine.keys` — imported single private keys held in the vault; passthrough to `wallet.keys`.
- `engine.swaps` — gateway swap quotes (0x on EVM, Jupiter on Solana), display-only.
- `engine.lido` — Lido liquid staking on Ethereum mainnet: stETH position and withdrawal
  requests.
- `engine.staking` — Solana stake positions and the current validator set.
- `engine.payments` — `parse` (pure, never throws), `resolve` (LNURL lookups) and
  `withdrawLnurl`.
- `engine.unsubscribe` — stops listening to the wallet and the phishing-list refresh.

The engine store from `@qntx/wallet-engine/idb` names rows by a keyed hash of the collection and
key, authenticates every value it reads back (a row that fails authentication reads as absent),
and rebuilds a database keyed by another data key empty.

## TRON

The engine serves TRON mainnet (`tron:728126428`) and the Shasta (`tron:2494104990`) and Nile
(`tron:3448148188`) testnets: TRX, TRC-10 and TRC-20 sends, staking operations, TRC-20
approvals, balances and resources, fiat prices, and history.

Host `rpc` entries are full-node HTTP base URLs — the engine appends the `/wallet/*` and
`/walletsolidity/*` paths itself and reads both heads on the same base:

```ts
createWalletEngine({
  // …
  rpc: {
    "tron:728126428": ["https://api.trongrid.io"],
    "tron:3448148188": ["https://nile.trongrid.io"],
  },
});
```

When the gateway serves the network it is tried first (route `POST /v1/tron/:caip2/*`, an
allow-list of node-API paths plus the TronGrid indexer feeds); every decisive read is still
cross-checked against a second provider before anything is built or signed, and a
`reads-unverified` flag marks a prepare whose cross-check could not run.

Request methods are `send`, `tron-stake` and `tron-approve`. A TRON `send` takes the token as a
TRC-10 decimal id or a TRC-20 `T…` address; `tron-stake` carries one action — `freeze`,
`unfreeze`, `withdraw-expired`, `cancel-unfreeze`, `delegate` (with an optional `lockBlocks`),
`undelegate`, `vote` or `claim-rewards` — checked against the java-tron actuator rules before
signing; `tron-approve` builds the TRC-20 `approve` call (amount `0n` revokes). A pending request
carries `tronFee`, a `TronFeeQuote` with the expected and maximum burn, the bandwidth source
(`staked`/`free`/`burn`/`activation-staked`/`activation-fee`), energy details for contract
calls, the activation charge for a first send to an absent account, and warnings
(`recipient-not-activated`, `token-recipient-empty`).

Tracking follows the chain's own rule: the signed bytes bind to the solidified head and stay
`submitted` — rebroadcast as needed — until the solidified node reports them (solidified
inclusion is `final`, a failed receipt is `failed`) or its timestamp passes the transaction's
`expiration`, which is `dropped`. Broadcast answers the node does not classify are never
guessed: only a definite refusal fails a request.

History is display-only indexer data: the gateway's TronGrid feeds, verified entry by entry on
the node (the raw data hash must equal the txid and every claimed leg must decode to the claim)
— an entry the node contradicts is flagged `chain-mismatch`, one it cannot prove stays
unverified.

Not offered: `AccountPermissionUpdate` (multi-sig/permission changes), transaction memos, and a
dApp provider — there is no `engine.tronWallet` like `eip1193`/`solanaWallet`.

## Hyperliquid

`@qntx/wallet-engine/apps` is a separate entry point: the app providers (Hyperliquid today) and
their controller. A host that never touches it pays nothing — the SDK, the WebSocket transport
and the eligibility client live only in this entry's bundle.

```ts
import { createWalletEngine } from "@qntx/wallet-engine";
import { createApps } from "@qntx/wallet-engine/apps";

const engine = createWalletEngine({/* … */});
const apps = await createApps({
  wallet, // the same Wallet the engine was built on
  requests: engine.requests, // user-signed actions open approval requests here
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  random,
  logger: { warn: (m, e) => console.warn(m, e) },
  openStore: async () => openIndexedDbEngineStore({ name: "app-apps", dataKey /* … */ }),
  // a separate EngineStore from the engine's own
  socket: (url) => new WebSocket(url), // browser, RN or Node ≥ 22 — one socket for all views
  gateway: { url: "https://api.example.com" },
  // the wallet gateway — /v1/eligibility is fetched here
  hyperliquid: {
    network: "Mainnet", // or "Testnet"
    agentName: "my-app", // ^[A-Za-z0-9._-]{1,16}$ — part of the kernel's agent binding
    builder: { address: "0x…", feeRateTenthsBps: 10 }, // optional builder fee — see below
  },
});
await apps.destroy();
```

`apps.controller` is a `HostController<AppsState>` (the usual `store` facade) with
`acknowledgeTerms`, `enable`, `renew`, `disable`, `cancel` and `refreshEligibility`; the provider
itself is `apps.hyperliquid`. The full composition — engine, apps, approvals, orders, live views —
is in `tests/migration/hyperliquid.ts`.

### Enabling

Each account group enables the app once: `acknowledgeTerms(group, "hyperliquid")` records the
terms acknowledgement, then `enable(group, "hyperliquid")` creates a kernel-held agent key and
opens an `ApproveAgent` approval request on `engine.requests`. The group's
`AppGroupState` tells the host what to show:

- `status: "enabling"` — a flow is running; `step` narrows it
  (`"approve-agent"`, `"verify"`, `"approve-builder"`) and `requestId` names the request to render.
  A flow interrupted by a lock or a reload resumes where it stopped on the next unlock.
- `status: "enabled"` — trades sign with `agent` (address, `validUntil`, `renewalDue` when the
  180-day validity window is close enough that a host should offer `renew`).
- `status: "needs-reauthorization"` — the agent is gone, expired or rejected by Hyperliquid;
  `renew` re-authorizes.
- `status: "unavailable"` — eligibility says the app is blocked in this jurisdiction. The
  overlay only ever covers `disabled`; an enabled group stays enabled so the user can still
  disable it.
- `status: "disabled"` — nothing enabled.

`enable` and `renew` throw `HyperliquidError("unavailable")` unless the gateway's eligibility
answer is `ready` and reports the app `available` — an unanswered or malformed check refuses too.
`disable` (delete the agent, `revoke: true` to also unapprove it on Hyperliquid) and `cancel`
(abort a running flow) are never gated. Call `apps.controller.refreshEligibility()` on foreground;
unlock already refreshes.

**Eligibility is display-only — it is not a security boundary.** The platforms enforce their own
restrictions; the gateway answer only decides what the UI offers.

### Trading

`apps.hyperliquid` is platform-neutral: `markets` (meta, mids, perp/spot asset lookup),
`account` (clearinghouse, spot, orders, fills), `quote` (price/size rounding and previews),
`clock` (the skew/nonce clock), `trade` (signed L1 actions), `fund` and `transfer` (user-signed),
`live` (WebSocket views).

- `quote.limit`/`quote.market` build a preview — wire price, size, notional, minimum-check. For a
  market order the preview's price is the slippage cap the exchange will fill against;
  `trade.place` requires `slippageBps` (there is no default — the host must show the computed
  cap it is about to sign).
- `trade.place`/`close` answer `{ outcomes, price }`; each outcome is `resting`, `filled`,
  `rejected`, `not-placed` or `unknown` per cloid. `unknown` means the POST's result is
  unknowable and the action may have committed — the engine reconciles it by cloid and
  **nothing is ever re-sent**. Give every order a stable `cloid` so reconciliation can find it.
- `trade.modify`/`batchModify`/`cancel`/`cancelByCloid`/`cancelAll`/`scheduleCancel`/`twap`/
  `twapCancel`/`setLeverage`/`adjustMargin`/`close` round out the action set.

### Live views

`live.book`, `live.trades`, `live.candles` for markets and `live.account`, `live.spotState`,
`live.openOrders`, `live.fills` for a group (resolved to its owner, closed on lock). A view's
`LiveState` is `{ status: "connecting" | "live" | "stale", data, updatedAt }`: data only renders
as `live` after a post-confirmation snapshot; any disconnect flips to `stale` — keep the data
visible but marked, never as live.

### Funding

`fund.deposit(group, { amount, fee, dex? })` prepares the CCTP deposit — a USDC
`depositForBurnWithHook` on Arbitrum's TokenMessengerV2 that Circle's CctpForwarder mints on
HyperEVM into the Hyperliquid account (destination domain 19, confirmed finality;
`HYPERLIQUID_DEPOSIT` has the contracts per network and `dex` defaults to `"perps"`). The
provider reads the Circle forward fee from Iris, refuses a deposit the fee would consume or
that exceeds the on-chain per-message burn limit, and opens an exact-amount USDC approve
request first only when the allowance is short — the result's `approval` is then present.
`transfer.{toPerp,toSpot}` move USDC between the owner's spot and perp accounts, `usdSend`/
`spotSend` send to another address and `withdraw` sends USDC back to the owner's Arbitrum
address. Every one opens an approval request: the returned `HyperliquidPendingAction` carries
the `requestId` to render and an `outcome` promise (`ok`, or `unknown` — may have committed).

### Builder fees

An optional `hyperliquid.builder` attaches `{ b, f }` to signed order actions — but only after
the user approved it on Hyperliquid (`approveBuilderFee` runs inside enable when configured) and
this session confirmed `maxBuilderFee` still covers it. There is no default fee, the attached
rate is never above the approved one, and `feeRateTenthsBps` is 1–100 (tenths of a basis point,
0.1–10 bp).

### Scope

Sub-accounts, vaults and referral codes are out of scope for this phase: the kernel's agent
signature allow-list covers only the owner account's actions.

### Security

> An unlocked agent and a compromised main runtime can place, modify and cancel any order,
> change leverage, adjust isolated margin, set a scheduled cancel and trade for sub-accounts or
> vaults — including filling against an attacker's resting orders at extreme prices in an
> illiquid market, which "trades" funds to the attacker; it can attach a builder fee up to the
> rate the main account approved. It cannot withdraw, transfer or deposit into vaults: the
> kernel does not sign those actions. The window is the unlocked period plus nonces pre-signed
> up to 5 minutes before the lock.

## React Native hosts

The engine runs on the RN main runtime (Hermes) with no polyfills. Verified on 2026-11-02 in an
iOS simulator Release build and on 2026-11-03 in an Android API 30 emulator Release build (both
RN 0.88.0, Expo 58, Hermes), with and without `react-native-quick-crypto`'s `install()`, using a
hardware-factor wallet: engine
creation, the gateway's `/v1/networks`, a Sepolia balance read, a send request prepared and
rejected, signet and Solana devnet reads through the gateway, `payments.parse`, and a lock that
invalidates open requests.

What the host must provide:

- `random`: a CSPRNG, injected as an option. Hermes has no `crypto.getRandomValues`, so use a native
  source such as `react-native-quick-crypto`'s `randomBytes`:
  `random: (n) => new Uint8Array(randomBytes(n))`.
- Nothing else. `globalThis.crypto`, `crypto.subtle` and `Buffer` are all absent in that run and
  not needed; `fetch`, `TextEncoder`, `URL`, `AbortSignal.timeout` and `structuredClone` are built in.

A host that already calls `install()` from `react-native-quick-crypto` (as Meowl does) also works;
the same smoke passes with those globals installed.

### In-app browser

`createBrowserBridge` attributes every page message to the origin of the URL the host passes as
`topUrl`, and drops it unless that origin is the current top-level page. The host must therefore
pass the URL of the frame that sent the message, never the top-level URL, or a cross-origin frame
inside a connected dApp (an ad, a widget) could request accounts and signatures under the dApp's
origin. Use react-native-webview 13.13.5 or later, which reports the sending frame in
`nativeEvent.url` (the message's `frameInfo` on iOS, the `WebMessageListener` source origin on
Android). On an Android system WebView without `WEB_MESSAGE_LISTENER`, react-native-webview falls
back to `addJavascriptInterface`, which reaches every frame and reports the top-level URL; the
in-app browser is not safe there. The injected provider installs itself only in the top-level
document.

## License

MIT OR Apache-2.0
