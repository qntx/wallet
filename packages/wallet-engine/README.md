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
  Every recipient a decoded intent names — outflows, the settlement terms
  (`minimumReceived`, bridge refunds, Hyperliquid deposits, staking withdrawals and
  delegations), typed-data order/consideration/Safe/Hyperliquid destinations and any
  nested calls — is assessed against the contacts and paid history, except the signer
  itself: an unseen recipient warns `first-recipient`, a lookalike of a known address
  raises `address-poisoning`.
- `engine.history` — one newest-first activity list per account group
  (state keyed `${walletId}:${groupIndex}`). `load`/`loadMore` page backwards while `hasMore`;
  entries carry `verified`, `origin` and `flags`; `truncated` lists the networks whose provider
  left unpagable gaps.
- `engine.approvals` — the standing-authority inventory (`load`, `unload`, `refresh`,
  `setVisible`, `exposure`) and revocations (`revoke`, `revokeBatch`); see
  [Approvals](#approvals).
- `engine.nfts` — an owner's NFT inventory on one network from the gateway (`load`/`loadMore`
  page it, `refresh` re-reads the loaded pages, `detail`/`collection`/`floor` answer one item,
  collection or its marketplace floors). Inventory data is display-only — a send never builds
  from it. Media are `NftMedia` descriptors with an `active` flag: render them as images or in a
  sandbox that runs no script, never as documents. Flagged items (`spam` non-empty) are `hidden`
  by default; `setHidden(network, id, "hidden" | "shown" | undefined)` persists the override.
  `inscriptions(group, network)` lists the Bitcoin UTXOs the spend path already protects as
  possible inscription carriers — read-only. NFT sends go through `requests`: `evm-nft-send`
  takes `{ contract, items: [{ tokenId, amount? }], to }` — one entry for ERC-721, up to
  `EVM_BATCH_LIMIT` distinct ids for one ERC-1155 batch — and `solana-nft-send` takes
  `{ asset, to }` where `asset` is a Metaplex Core asset or an SPL NFT mint. Preparation
  re-reads ownership from chain and a refusal throws `NftTransferError` with a `reason`
  (`not-nft`, `not-owned`, `insufficient-balance`, `programmable`, `frozen`, `not-found`).
- `engine.addressBook` — contacts, synced through `metaSync`.
- `engine.connections` — dApp sessions and trusted origins; pass it to `createBrowserBridge`
  (`checkOrigin`, `invalidateOrigin`).
- `engine.eip1193`, `engine.nip07`, `engine.webln`, `engine.solanaWallet`,
  `engine.bitcoinWallet`, `engine.tronWallet` — the injected provider handlers for each wallet
  standard (`handle`, and `subscribe` where the standard has events).
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

Transaction tracking: a send whose outcome is unknown is never declared `dropped` by a timer.
On EVM a transaction ends on its own receipt, on its nonce being consumed without its receipt
(cross-checked against the host endpoint), or on a replacement; on Bitcoin only on inclusion or
on one of its inputs being spent by another confirmed transaction. When no endpoint has known a
transaction for thirty minutes the row turns `stuck: true` — still `submitted`, still holding its
nonce or inputs, polled at the finality interval — and the host should offer `speed-up` /
`cancel`. A row recovered from a broadcast whose outcome never settled carries
`rebroadcast: false`: watched, never resent. TRON and Solana keep proof-based expiry (chain
expiration, blockhash / durable-nonce validity), and neither trusts one upstream's word for an
absence: every read of a poll is pinned to a single upstream (the gateway is pinned to one
provider once it answers), and `dropped` is reached only when a configured host endpoint's own
pinned client proves the same drop, or — without one — after three consecutive matching polls.
On Solana the streak must span more than one blockhash processing age (~60 seconds): a
blockhash transaction is `dropped` only when its blockhash is past its last valid height, the
status ledger holds no entry, and the status bank is no older than the reads that expired it;
a durable-nonce transaction only when the nonce account has provably moved past the submitted
nonce (a status bank behind the nonce read proves nothing) and the account's signature
history covers the window since submission without listing the transaction — a trimmed
ledger can make a landed send read absent.

Chain binding on the gateway path: when the gateway serves a TRON or Solana network, the value
that binds the signed bytes to the chain — TRON's reference block, Solana's recent blockhash —
must be confirmed by a host endpoint, and the answering node must report the configured
network's genesis. A gateway-only testnet send is refused rather than signed on one
party's word — a binding taken from the mainnet would produce a signature valid on the
mainnet — while a gateway-only mainnet send builds flagged `reads-unverified`: a wrong-chain
binding makes the signature invalid on the mainnet and nothing of more value can move.

L1 data fees on OP Stack and Scroll move with the L1's own fee market, so the `l1Data` amount an
intent displays is a bound, not the raw oracle read: the read plus three L1 price updates of at
most ×9/8 (two for the inclusion window, one of review headroom). Approval re-reads the oracle
before signing, and broadcast re-reads it again whenever the signature took longer than one
12 s L1 slot; when the current price outgrows what the shown maximum covers the request ends
(`the L1 data fee rose — start over`) — the host re-prepares and the user approves the new bound.

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
`reads-unverified` flag marks a prepare whose cross-check could not run. Two reads are binding
rather than flaggable: the reference block — what binds the signed bytes to the chain — must be
confirmed by a host endpoint when the gateway serves the network — on a testnet a gateway-only
TRON send is refused, on a mainnet it proceeds flagged `reads-unverified`; and the answering
node itself must report the network's genesis block, so a gateway provider on another chain is
refused before anything is signed.

Request methods are `send`, `tron-stake` and `tron-approve`. A TRON `send` takes the token as a
TRC-10 decimal id or a TRC-20 `T…` address and an optional `memo` (1–256 UTF-8 bytes, no line
breaks or hidden characters — it becomes `raw_data.data` and costs the chain's flat memo fee,
quoted as `tronFee.memo`); `tron-stake` carries one action — `freeze`,
`unfreeze`, `withdraw-expired`, `cancel-unfreeze`, `delegate` (with an optional `lockBlocks`),
`undelegate`, `vote` or `claim-rewards` — checked against the java-tron actuator rules before
signing; `tron-approve` builds the TRC-20 `approve` call (amount `0n` revokes). A pending request
carries `tronFee`, a `TronFeeQuote` with the expected and maximum burn, the bandwidth source
(`staked`/`free`/`burn`/`activation-staked`/`activation-fee`), energy details for contract
calls, the activation charge for a first send to an absent account, and warnings
(`recipient-not-activated`, `token-recipient-empty`).

A built TRON request is fresh for 20 seconds before its `expiration`: approve with less left — or
after the reference block left the solidified chain — and the route rebuilds the same contract on
a fresh head before signing, never signing stale bytes; a rebuild whose fee bound grows is refused
instead. DApp-built transactions get no rebuild: under 20 seconds they are refused and the dApp
must build again.

The in-app browser gets the TronLink surface — `window.tron`, `window.tronLink` and
`window.tronWeb`, installed immutable in the top frame only and announced over TIP-6963.
`tronWeb` covers what real dApps call: `defaultAddress`, `ready`, `trx.sign`,
`trx.signMessageV2`, `_signTypedData`/`signTypedData`, `trx.sendRawTransaction`,
`getBlockByNumber(0)` (the network genesis), `addressChanged` and the node setters as no-ops;
every other member — `transactionBuilder`, `utils`, `event`, `plugin`, the rest of `trx` — is a
refusal that rejects with code `4200` rather than a wrong answer, and there are no `isTronLink`
flags. `trx.sign` on a hex string is refused: a digest is signed with `signMessageV2`, and
multi-signature is not offered.

A dApp transaction is signed only when it can be shown exactly: `raw_data` must bind the session's
own account as owner, a single modeled contract, `Permission_id` 0, an `expiration` between 20
seconds and 24 hours out, and a reference block proven on the chain (full node or, within its
head, the solidity node, cross-checked against the independent endpoint when one is configured);
the page's `txID` must be sha256 of `raw_data` and a supplied `raw_data` JSON must re-encode to the
same bytes. The wallet never broadcasts a dApp transaction itself — approve creates a `submitted`
entry carrying `tron.dappSignature` and no `raw`, so the poll can only observe: when the dApp's
broadcast lands the entry goes `confirmed`/`final`, and if the head passes `expiration` with no
inclusion it is `dropped`. `trx.sendRawTransaction` hands the wallet-signed bytes back through
`submitDappTron` — the signature must match the observed entry's — for the one wallet broadcast.
`tron_signMessageV2` signs TIP-191 bytes, `tron_signTypedData` a TIP-712 document the page
supplies as `domain`/`types`/`message`, and `wallet_watchAsset` accepts TRC-20 only.

Tracking follows the chain's own rule: the signed bytes bind to the solidified head and stay
`submitted` — rebroadcast as needed — until the solidified node reports them (solidified
inclusion is `final`, a failed receipt is `failed`) or its timestamp passes the transaction's
`expiration`, which is `dropped`. A poll never trusts one upstream's word for an absence: every
read of a poll is pinned to a single upstream (the gateway is pinned to one provider once it
answers), and `dropped` or `reorged` is reached only when a configured host endpoint agrees, or
— without one — after three consecutive matching polls spanning more than one solidification
period (~57 seconds). Broadcast answers the node does not classify are never guessed: only a
definite refusal fails a request.

History is display-only indexer data: the gateway's TronGrid feeds, verified entry by entry on
the node (the raw data hash must equal the txid and every claimed leg must decode to the claim)
— an entry the node contradicts is flagged `chain-mismatch`, one it cannot prove stays
unverified.

Not offered: `AccountPermissionUpdate` (multi-sig/permission changes).

## Approvals

`engine.approvals.load(account, network)` returns a view key; `ApprovalsState.views[key]` is one
`ApprovalsView` — every standing authority the account holds over that network, as rows:

- EVM: ERC-20 allowances, Permit2 allowances (amount and expiration), ERC-721 and ERC-1155
  operators, ERC-721 single-token approvals, and the account's own EIP-7702 delegation.
- Solana: SPL delegates, foreign close authorities, mint freeze authorities and Token-2022
  permanent delegates, and stake account authorities.
- TRON: TRC-20 allowances and the account's permission keys.

Kernel session keys that may sign for the owner are linked in `view.sessions`, not listed as
rows — a session key is revoked through the app that owns it, not through `revoke`.

**Trust.** A row is never shown on a discovery source's word. Sources — the gateway's
`POST /v1/approvals/:caip2` (an EVM `eth_getLogs` scan; a TRON indexer where one exists) and the
engine's own recorded transactions — yield candidate keys only. Every candidate is then read on
chain at `view.at.height` on the primary endpoint and cross-checked on the independent one: a
candidate the chain does not confirm is `dropped`, a disagreement between the endpoints hides the
row and counts it in `disputed`, a candidate that could not be read is `unread`, and a row
confirmed on only one upstream carries `verified: false`. `view.sources` lists each source's
status and the height it answered at. `view.exhaustive` names the kinds the chain itself
enumerates (the EVM delegation, Solana token-account delegates, close and mint authorities, TRON
permissions); every other kind is a _known_ approval — indexers can miss a spender, so label those
lists accordingly. Discovered candidate keys persist in the session store (collection
`approvals`), so an approval outlives the source that found it; keys no longer confirmed on chain
are pruned.

**Risk and exposure.** Rows carry `risk` flags — `unlimited`, `eoa-spender`, `spender-no-code`,
`address-poisoning`, `foreign-delegation` — and an `exposure` naming what the spender can take
right now. `engine.approvals.exposure(key)` values the view's exposures at current quotes. Both
are display-only; nothing about them changes what a request may do.

**Freshness.** A loaded view re-reads every `APPROVALS_POLL_MS` while `setVisible(true)` — gate it
on the approvals screen being shown — on `refresh(key)`, and after a transaction carrying an
approval intent confirms on the network; that re-read answers at the confirming block or later,
never from before it.

**Revoking.** `engine.approvals.revoke(key, rowId, fee?)` prepares an ordinary request through the
request pipeline — approve it like any other. The request's display intent describes a revocation
(an allowance set to 0, a Permit2 lockdown, an operator cleared, a delegation removed), never a
grant, and the builder re-reads the chain before building: when nothing is left to revoke the
prepare is refused. `revokeBatch(key, rowIds, fee?)` puts several rows in one transaction — EVM
rows (`erc20`, `permit2`, `operator`, `nft`; up to `EVM_BATCH_LIMIT`) only on an account already
delegated to the wallet's delegator, the batch a single self-call with no authorization, or
several `spl-delegate` rows (up to 10). Rows with `revoke: "none"` — a foreign close authority, a
mint authority, a stake authority, a TRON permission key — cannot be removed from this wallet.
Prepare one revocation request at a time: nonces are reserved at commit, so a second prepared
request would go stale. A row is never removed optimistically; it disappears when the chain read
after inclusion no longer shows it. Authorities an app's venue holds outside the approvals
inventory — the Hyperliquid builder-fee approval on HyperCore — are listed by
`AppsController.authorities` (see [Writing an app provider](#writing-an-app-provider)).

## Writing an app provider

An app provider is an `AppDefinition<Id, Api, D>`: a small factory the host lists in
`createApps({ apps: […] })`. `tests/migration/app-provider.ts` is a complete example — a
`"example-notes"` provider that registers a per-group handle — importing only the public
package entries.

```ts
export const exampleNotes = (
  config,
): AppDefinition<"example-notes", ExampleNotesApi, ExampleNotesDetail> => ({
  id: "example-notes", // ^[a-z][a-z0-9-]{1,31}$
  enableWhen: ["available"],
  create: (context) => ({ api, provider }),
});
```

- `id` is validated at `createApps` — it must match `^[a-z][a-z0-9-]{1,31}$` — and so is
  `enableWhen`: the eligibility answers under which `enable`/`renew` may start. `"blocked"` is
  never allowed, and an unknown, error or absent answer refuses too (eligibility fails closed).
- `create(context)` runs once per `createApps` and returns `{ api, provider, unlock?, lock?,
  close? }`. `api` is whatever the host calls (`apps["example-notes"]`); `provider` is the
  lifecycle contract below; the hooks fire on vault unlock, lock and teardown.

**Group state.** The controller owns `AppGroupBase` — `status`, `termsAcknowledged`,
`requestId`, `error` — and merges the app's detail `D` flat on top:
`AppGroupState<D> = AppGroupBase & Partial<D>`. `D` must satisfy `AppDetail`: a detail key may
not redefine a controller field. A `flow.write({ … })` patch may carry `undefined` to clear a
field; `termsAcknowledged` is the host's alone — providers cannot write it. The controller
persists only that flag per group and never reads detail; the eligibility overlay rewrites
`disabled` ↔ `unavailable` only, so an enabled group stays enabled when a region blocks.

**Provider.** `{ error, groups, reconcile, enable, renew, disable, cancel }`:

- `error(category, message)` maps the controller's categories (`"unavailable"`,
  `"unlock-required"`, `"busy"`, `"invalid-input"`) to the app's own error class.
- `groups` lists the groups that may hold state (usually `context.storage.groups`).
- `reconcile(group, flow)` derives status from app storage after unlock — it owns what a reload
  cannot prove.
- `enable(group, flow)`/`renew` run the enabling flow under `enableWhen`;
  `disable(group, options, flow)` (`options.revoke` for server-side revocation) and
  `cancel(group, flow)` (reject a pending `requestId`, then reconcile) are never gated.
- Every provider method receives an `AppFlow<D>`: `flow.current()` is the live group state,
  `flow.write(patch)` merges it, `flow.stale()` reports the flow lost the group. Only one flow
  per group + app runs at a time — a second call throws `busy` — and a lock or a newer flow
  silently drops a stale write.

**Context.** `create` receives an `AppContext<D>` with injected I/O — `requests`, `networks`,
`fetch`, `now`, `setTimer`, `random`, `logger`, `socket`, `storage` — so a provider touches no
globals. Requests it opens are stamped `{ kind: "app", id }`; an app cannot choose its origin.
`storage` is the `apps.<id>` collection of the store the host supplies: group-scoped keys
(`get`/`put`/`delete(group, name)`), closed while the vault is locked, pruned with deleted
wallets. `context.availability()` is the app's value under the last ready eligibility answer —
it outlives a lock, so market views keep working — `context.groupState(group)` is the live
`AppGroupState<D>` (`undefined` while locked or absent), and `context.flow(group, run)` runs an
api action under the same unlock and busy guards the provider methods get.

**Signing.** An app signs only through the request pipeline — requests attributed to it with
origin `{ kind: "app", id }`, approved by the user and decoded by the kernel — or through a
kernel session scheme; it never holds a private key. Credentials that cannot authorize moving
value (API keys, HMAC secrets, bearer tokens) may live in `storage`.

**Inside this repo** providers live under `src/apps/<app>/` and may import only
`src/apps/spi.ts` — enforced by the check-boundaries `app-provider-spi` rule, type-only edges
included. Every runtime value the SPI re-exports is also a public export of
`@qntx/wallet-engine` or `@qntx/wallet-engine/apps`, so an external provider loses nothing;
`createAppSocketCore` is the one exception and stays in-tree until the providers leave the
package.

A provider may also expose `authorities(group)`: the standing authorities its venue holds over
the group's funds outside the kernel's session keys — the Hyperliquid builder-fee approval on
HyperCore, Polymarket's trading approvals on the deposit wallet, Fiat24's owner-EOA allowances.
`AppsController.authorities(group)` collects every app's rows — display-only, one
`{ app, error }` row per failed read.

## Hyperliquid

`@qntx/wallet-engine/apps` is a separate entry point: the `AppsController` and the composition
host apps build on. Each provider ships in its own sub-entry —
`@qntx/wallet-engine/apps/hyperliquid`, `@qntx/wallet-engine/apps/polymarket` — so a host bundles
only the apps it lists.

```ts
import { createWalletEngine } from "@qntx/wallet-engine";
import { createApps } from "@qntx/wallet-engine/apps";
import type { AppSocket } from "@qntx/wallet-engine/apps";
import { hyperliquid } from "@qntx/wallet-engine/apps/hyperliquid";
import { polymarket } from "@qntx/wallet-engine/apps/polymarket";

const engine = createWalletEngine({/* … */});
const apps = await createApps({
  wallet, // the same Wallet the engine was built on
  requests: engine.requests, // user-signed actions open approval requests here
  networks: engine.networks, // chain reads (the Hyperliquid CCTP deposit's allowance/burn limit)
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  random,
  logger: { warn: (m, e) => console.warn(m, e) },
  openStore: async () => openIndexedDbEngineStore({ name: "app-apps", dataKey, random }),
  // a separate EngineStore from the engine's own
  socket: (url) => new WebSocket(url) as AppSocket, // browser, RN or Node ≥ 22 — one socket for all views
  gateway: { url: "https://api.example.com" },
  // the wallet gateway — /v1/eligibility is fetched here
  apps: [
    hyperliquid({
      network: "Mainnet", // or "Testnet"
      agentName: "my-app", // ^[A-Za-z0-9._-]{1,16}$ — part of the kernel's agent binding
      builder: { address: "0x…", feeRateTenthsBps: 10 }, // optional builder fee — see below
    }),
    polymarket({
      builder: { code: "0x…", sign: myBuilderEndpoint }, // Remote Builder Signing — see below
    }),
  ],
});
await apps.destroy();
```

`apps.controller` is a `HostController<AppsState>` (the usual `store` facade) with
`acknowledgeTerms`, `enable`, `renew`, `disable`, `cancel` and
`refreshEligibility`; the providers are `apps.hyperliquid` and `apps.polymarket`. A group's
entry in the controller's `groups` map is typed by the listed app —
`HyperliquidGroupState` for Hyperliquid, `PolymarketGroupState` for Polymarket. The full
composition — engine, apps, approvals, orders, live views — is in `tests/migration/hyperliquid.ts`
and `tests/migration/polymarket.ts`.

### Enabling

Each account group enables the app once: `acknowledgeTerms(group, "hyperliquid")` records the
terms acknowledgement, then `enable(group, "hyperliquid")` creates a kernel-held agent key and
opens an `ApproveAgent` approval request on `engine.requests`. The group's
`HyperliquidGroupState` tells the host what to show:

- `status: "enabling"` — a flow is running; `step` narrows it
  (`"approve-agent"`, `"verify"`, `"approve-builder"`) and `requestId` names the request to render.
  A flow interrupted by a lock or a reload resumes where it stopped on the next unlock.
- `status: "enabled"` — trades sign with `agent` (address, `validUntil`); `renewalDue`, written
  once the group is enabled, is true when the 180-day validity window is close enough that a
  host should offer `renew`.
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
  `rejected` or `unknown` per cloid. `unknown` means the POST's result is unknowable and the
  action may have committed — the engine reconciles it by cloid and **nothing is ever
  re-sent**. Give every order a stable `cloid` so reconciliation can find it.
- `unknown` is never proven "not placed": no documented consistency between an info read and
  L1 state means an `unknownOid` answer cannot rule out a committed order. `trade.corrections`
  is the follow-up channel — `subscribe` gets `{ group, cloid, outcome }` every time a pending
  cloid is proven later: by `orderStatus` re-asks for ten minutes after the call returned
  (every 10 s, bounded set of 64), or by live user-view frames — an `openOrders` frame carrying
  the cloid corrects to `resting` immediately, a `fills` frame carrying it triggers an
  immediate `orderStatus` check (a fill alone cannot prove a full fill). Locking the vault
  drops the pending set.
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
provider reads the Circle forward fee from Iris and refuses a deposit the fee would consume or
that exceeds the on-chain per-message burn limit. It is a two-call flow: when the messenger's
USDC allowance is short the result is `approval-required` carrying only an exact-amount approve
request (the burn call cannot be prepared while the approval is unmined — its `eth_estimateGas`
reverts); the host approves it and calls `deposit` again, and the re-read allowance then yields
the `deposit` variant carrying the burn request.
`transfer.{toPerp,toSpot}` move USDC between the owner's spot and perp accounts, `usdSend`/
`spotSend` send to another address and `withdraw` sends USDC back to the owner's Arbitrum
address. Every one opens an approval request: the returned `HyperliquidPendingAction` carries
the `requestId` to render and an `outcome` promise (`ok`, or `unknown` — may have committed).

### Builder fees

An optional `hyperliquid({ builder })` attaches `{ b, f }` to signed order actions — but only
after the user approved it on Hyperliquid (`approveBuilderFee` runs inside enable when configured)
and this session confirmed `maxBuilderFee` still covers it. Declining the approval still finishes
`enabled` with `builder: "declined"` (orders carry no builder); the decline persists across
unlock, renew and re-enable until `apps.hyperliquid.approveBuilder(group)` obtains an
approval. There is no default fee, the attached rate is never above the approved one, and
`feeRateTenthsBps` is 1–100 (tenths of a basis point, 0.1–10 bp).

### Scope

Sub-accounts, vaults and referral codes are out of scope for this phase: the kernel's agent
signature allow-list covers only the owner account's actions.

### Security

> An unlocked agent and a compromised main runtime can place, modify and cancel any order,
> change leverage, adjust isolated margin, set a scheduled cancel and trade for sub-accounts or
> vaults — including filling against an attacker's resting orders at extreme prices in an
> illiquid market, which "trades" funds to the attacker; it can attach a builder fee up to the
> rate the main account approved. It cannot withdraw, transfer or deposit into vaults: the
> kernel does not sign those actions. The window is the unlocked period plus at most 60 seconds —
> each agent signature carries an `expiresAfter` at most 60 s after it was made and Hyperliquid
> rejects the action afterwards. Both bounds are on the device clock (the kernel has no trusted
> time): `assertClock()` refuses to sign when the device is more than 5 s off Hyperliquid's server
> time, but a compromised main runtime can skip that check, so a device clock running S ahead
> stretches the window by S (Hyperliquid accepts nonces up to a day ahead); actions already submitted keep their effects (resting
> orders, a scheduled cancel); deleting the local agent does not revoke it on Hyperliquid (it stays
> valid until `validUntil`), but nothing can sign with it again.

## Polymarket

Polymarket support lives under `apps.polymarket` when `createApps` lists `polymarket(config)` from
`@qntx/wallet-engine/apps/polymarket`. The provider trades from the account's **deposit wallet** —
a Polymarket smart contract wallet the relayer deploys to a deterministic CREATE2 address derived
from the group's `evm.bip44` signer. Everything else is discovered, not persisted: credentials
live in the engine's encrypted apps store, deployment is proven on-chain (relayer answers are
hints only), approvals from the Data API.

```ts
const apps = createApps({
  wallet,
  requests,
  networks,
  fetch,
  now,
  setTimer,
  random,
  logger,
  openStore,
  socket,
  gateway: { url },
  apps: [
    polymarket({
      // The host's Remote Builder Signing oracle — see "Builder signing" below.
      builder: {
        code: "0x…", // optional attribution written into orders; absent = zero code
        sign: async ({ method, path, body }) => postToYourBuilderEndpoint({ method, path, body }),
      },
    }),
  ],
});
```

### Account model

Enablement resolves exactly one wallet per group: the beacon or UUPS deposit-wallet candidate,
preferring a deployed one. An account that only ever had the legacy Polymarket **Safe** reports
`needs-migration` — it is displayed read-only and no trading path runs for it (the Safe cannot be
upgraded by the relayer). Trading directly from the owner EOA is not offered: Polymarket allows
EOA orders only for allow-listed accounts, and the deposit wallet covers everyone else.

`account.locate(group)` returns `{ signer, wallet, kind, deployed, legacySafe? }`; a deposit wallet
that coexists with a deployed Safe surfaces `legacySafe` for display.

`locate` never trusts the unauthenticated relayer's `/deployed` answer: it reads `eth_getCode` on
all three CREATE2 candidates over the Polygon RPC — cross-checked byte-for-byte against the host
endpoint when the gateway serves the network — requires a deposit wallet's code to equal the
template's expected runtime exactly (the Safe's CREATE2 address already commits to its init-code
hash, so any code proves it), and then insists every relayer hint agree. Any disagreement, or a
deposit-wallet-shaped candidate carrying other code, is `PolymarketError("deployment-mismatch")`
and nothing is chosen; a host endpoint that cannot answer fails closed with `unavailable`. A
deposit — or any trading path — therefore never targets a wallet the chain does not prove.

### What works without a builder

| Capability                                                                           | Without a builder                                    | Why                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Market data, search, book, history, positions/trades/value (Gamma/CLOB/Data, public) | works                                                | no authentication                                                                 |
| Locating an existing deposit wallet (derivations + `eth_getCode`, relayer as hint)   | works                                                | public reads                                                                      |
| Deploying the deposit wallet                                                         | `builder-required`                                   | relayer `WALLET-CREATE` only accepts builder credentials                          |
| `ClobAuth` → L2 credentials                                                          | works                                                | the CLOB does not require a builder                                               |
| The 8-call approvals batch, withdraw, future redeems                                 | `builder-required`                                   | all are relayer `WALLET` transactions                                             |
| Placing/cancelling orders                                                            | works when the wallet is already deployed + approved | the CLOB needs only L2 + the order signature; `builder` field zero = unattributed |
| Deposit (EOA → deposit-wallet pUSD)                                                  | works                                                | an ordinary Polygon transaction, user pays POL gas                                |

### Builder signing

Relayer submissions are HMAC'd by a builder API key **the app never holds**: `builder.sign`
receives `{ method, path, body }` and must return the four `POLY_BUILDER_API_KEY /
POLY_BUILDER_PASSPHRASE / POLY_BUILDER_SIGNATURE / POLY_BUILDER_TIMESTAMP` headers — the engine
sends the exact `body` string it signed. The host endpoint must authenticate its caller and should
restrict `path` to `/submit`. Builder secrets belong on the host's server — never in the app, and
never proxied through the gateway.

### Enablement

`enable` runs five steps — `locate-wallet` → `deploy-wallet` (only when undeployed; builder
required) → `credentials` (one `ClobAuth` typed-data signature serves `POST /auth/api-key` and, if
needed, `GET /auth/derive-api-key`) → `approvals` (only the rows the Data API reports missing from
a fixed 8-call table, signed as one `DepositWallet` `Batch` and submitted through the relayer) →
`verify` — each writing `{ step, requestId, error }` so a lock or crash resumes without repeating
finished work. Statuses: `disabled`, `enabling`, `enabled`, `needs-reauthorization`,
`needs-migration`, `unavailable`. `renew` does not apply — CLOB credentials do not expire.
`disable({ revoke: true })` asks the CLOB to `DELETE /auth/api-key` first and then drops the
stored credential record; a local delete alone is **not** a revoke — the same wallet re-derives the same credentials,
so always use `revoke: true` to cut the key off server-side.

Eligibility: `enable` accepts `available` **and** `close-only` jurisdictions (close-only users need
credentials to sell and withdraw); `blocked` and unknown/error answers fail closed with
`PolymarketError("blocked")`.

### Credential custody

The `apiKey`/`secret`/`passphrase` the CLOB answers are written into the app's encrypted
collection on the session store (`apps.polymarket`, key `<walletId>/<groupIndex>/eip155:137`,
encrypted under the data key the host's `openStore` holds) — unavailable while locked, pruned when
the wallet is deleted, cleared on `disable`, and never surfaced in controller state, snapshots,
logs, or error strings. Every later authenticated request is HMAC'd by the engine itself
(`l2Headers`) with a ±30 s timestamp window, after checking the stored `owner` still equals the
group's `evm.bip44` signer. The authenticated `/ws/user` channel receives the same credentials in
its subscription frame for live order/trade events. Residual risk: a compromised main runtime
while the wallet is unlocked can read the CLOB credentials: it can cancel orders and read private
CLOB data (orders, trades) until the user disables Polymarket with revoke (server-side
`DELETE /auth/api-key`). It cannot place orders — every order needs a signature the kernel decodes
and the user approves — and cannot move funds (no CLOB path withdraws or transfers).

### Trading

`trade.place` covers limit `GTC`/`GTD` (with `postOnly`) and market `FOK`/`FAK` orders. Rounding is
directional — price to the tick in the user's favour, size down to the 2-decimal grid — so the
signed order is never worse than the requested limit, and a market quote's shown worst-price bound
is the signed bound. GTD `expiration` and the displayed fee fields are **unsigned** (the V2 struct
has no such fields) and shown as such. `orderId` is the order's EIP-712 hash, known before
approval.

Outcomes: `resting`, `matched`, `delayed`, `unmatched`, `rejected` (classified reason), `canceled`,
and `unknown`. An `unknown` — timeout, network error, 5xx, or an answer that cannot be tied to the
hash — is reconciled by reads at 0/+2 s/+5 s and **never re-posted**: a V2 order has no expiry, so
a lost-but-valid order could still be submitted by whoever holds it. An order no reconcile read
saw is **not** proven absent, so the engine attempts `DELETE /order` by id before resolving — the
attempt's result rides the outcome as `cancel` — and registers the id for the late reconcile:
`trade.corrections` re-asks `order` every 10 s for 10 minutes and emits the eventual status once.
`unknown` means the order may or may not exist — it MUST NOT be blindly re-placed, because a
later-landing first order plus the retry is a duplicate position. A `canceled` outcome or
correction carries `making`, the row's `size_matched`: `making` > "0" is a partial fill taken
before the cancel landed, so only the unfilled remainder is free to re-place — and
`unknown.cancel.kind === "canceled"` only says the defensive DELETE removed the _remaining_ size,
never that nothing filled. Cancels
(`cancel`, `cancelMany` ≤ 500, `cancelAll`, `cancelMarket`) are never eligibility-gated.

### Close-only

BUY orders — and BUY quotes — are refused (`close-only`) when the gateway reports the app
`close-only`/`blocked`, when eligibility is unknown, or when the account's own `closed_only` flag
is set (a failed check fails closed). SELLs, cancels and withdrawals are always allowed.

### Funding

`fund.deposit(group, { amount, fee })` prepares a pUSD `send` from the owner EOA to the located
**deployed** deposit wallet — it is not eligibility-gated (a deposit opens nothing).
`fund.withdraw(group, { amount })` submits a one-call relayer `Batch`, `pUSD.transfer(owner)`, so
the destination is always the owner's own address; a lost submit resolves `unknown` and is never
auto-resubmitted. Only pUSD moves through this lane this round: USDC/USDC.e wrapping and
cross-chain bridging are not offered because Polymarket's collateral is pUSD on Polygon and
wrapping paths belong to the swap/bridge lanes, not this app.

### Live views

`live.book(assetId)` streams the public market channel (`custom_feature_enabled` for
best-bid/ask and resolution events): a `book` snapshot turns the view `live`, `price_change`
deltas apply only on top of it (size `"0"` removes the level), and every disconnect marks the view
`stale` while keeping the last data. `live.account(group)` streams the authenticated user channel
(`/ws/user`): the group's credentials go out as the first frame, order events upsert/remove the
open-orders list and trade events debounce into a REST re-read. A disconnect keeps the data as
`stale` and falls back to a 10 s REST poll (`source: "poll"`) until the socket reconnects and the
view returns to `live`/`stream`; a lock or a missing-credential stop closes the view for good.

## Fiat24

Fiat24 support lives under `apps.fiat24` when `createApps` lists `fiat24(config)` from
`@qntx/wallet-engine/apps/fiat24`. The provider is built on the `@qntx/fiat24` SDK (Arbitrum One
only): the account read and the resumable flows run over a viem client built from
`engine.networks` — with an independent endpoint configured every pinned read must agree on both
sides, and the SDK's own deployment check stays on, so a drifted deployment reports the typed
status `contract-changed` rather than signing against unexpected code. The REST API is optional:
`fiat24({ fetch })` is for `api.fiat24.com` only.

```ts
import { fiat24 } from "@qntx/wallet-engine/apps/fiat24";

const apps = createApps({
  /* … the same options as above … */
  apps: [fiat24({ fetch: fiat24Fetch })], // see "The REST api" — omit for a chain-only build
});
```

- `account(group)` reads the group's account once: `no-account`, an `AccountStatus` (or `stale`
  for a failed read), or `contract-changed`. `live(group)` is the same read as a store facade,
  polled every 15 s (`FIAT24_POLL_MS`) while `setVisible(true)` and unlocked.
- `flows` is `start` / `advance` / `list` / `discard` / `payoutSettlement` over the SDK's
  resumable transfer, exchange, payout, top-up, onboarding and card flows. Advances are
  serialised per group, `start` refuses `flow-unresolved` while another flow could still send,
  and an entry that no longer decodes lists as `{ id, invalid: true }` — `discard` is the only
  way out of it, so have the user check the account's activity first.
- `session(group)` is the secured reads (`profile`, `cards`, `cardDisplayToken`,
  `transactions`) through a lazy SDK session. `api` is the unauthenticated reads (`rates`,
  `paymentPurposes`, `countries`, `countryCities`, `banks`, `bankByIban`, `kycUrl`).

**Every SDK write is exactly one `{ kind: "app", id: "fiat24" }` request** on `engine.requests`:
transactions are `evm-sign` `evm.transaction` requests at the SDK-chosen nonce (the engine pins
it — `prepare` fails with `NonceConflictError` if the sender's next nonce moved on), and session
grants are `evm.fiat24-session` requests. A `Fiat24Flow.refusal` on a returned entry says why a
send did not happen. Reconcile — on unlock and every 15 s while visible — only ever advances
records in `sending`/`submitted`/`unknown`, which the SDK resolves by polling receipts and
nonces; it can never sign or broadcast.

**Persistence.** Flow states persist as `encodeFlowState` text in the app's EngineStore
collection — pseudonymous chain fields only, no PII. Payout drafts hold unverified payee data
and stay in memory. Session grants are bearer credentials held only in memory; lock, disable and
wallet removal end them (disable also rejects the group's still-open requests).

**Jurisdiction.** `enable` needs an eligibility answer of `available` or `close-only` — a
restricted jurisdiction still gets the read surface to wind positions down — and onboarding and
top-up refuse when the chain reports the feature `unavailable`.

### The REST api

`api.fiat24.com` sends no CORS headers and the gateway does not proxy it, so the host owns the
transport:

- **React Native:** inject the platform `fetch`, uninstrumented — exclude `api.fiat24.com` from
  logging/Sentry interceptors, disable its HTTP cache, and note RN's fetch follows redirects
  whatever `redirect` says; inject one that does not if that matters.
- **Web:** inject a `fetch` that sends the request to a host proxy for `https://api.fiat24.com`.
  The proxy sees the session grant headers, which are a bearer credential for the account until
  their deadline — treat them accordingly.

Without `fetch` the chain flows still work — transfers, exchanges, top-ups, payouts to a saved
contact, and onboarding up to KYC — while the secured and public REST reads, a bank or Swiss-QR
payout draft's verify step, a card flow's API write, and the onboarding `tourist`/`kyc` steps
throw `Fiat24AppError("api-unavailable")`.

### Security

Residual risks a host must state, from the SDK's README: exact-in FX and top-up have no on-chain
minimum output (the issuer's rate can move between the flow's quote check and inclusion); a
payout's payee is bound off-chain — the signed transaction carries only the contact id and
reference, and Fiat24 resolves the recipient; and a single EOA owns the ProxyAdmin of every
Fiat24 proxy (it can pause, re-wire and upgrade the deployment, which is why writes fail closed
with `contract-changed`). See the [SDK README](https://github.com/qntx/fiat24#residual-risks) for
the full list.

## WalletConnect

`@qntx/wallet-engine/walletconnect` is a separate entry point: the wallet side of WalletConnect
v2 (Reown WalletKit + the sign client). It needs four optional peer dependencies — install them
yourself: `@reown/walletkit`, `@walletconnect/core`, `@walletconnect/types`,
`@walletconnect/utils` (exact pins in `peerDependencies`). No other entry imports them, so a
host that never pairs pays nothing — the SDK and its relay transport live only in this entry's
bundle.

All four packages are under the **WalletConnect Community License Agreement** (Reown, Inc.,
release date 20 August 2025 — see `LICENSE.md` in each installed package). Reading the license:
downloading, installing, integrating or using the packages makes you a Licensee bound by it.
Use for education/non-commercial research and for developing your own apps and wallets is
royalty-free, subject to the limited-commercial-use rule: above **500 monthly active users or
2,500,000 monthly RPC calls** you must pay for a commercial licence. Modifications are allowed
but every modification or derivative work is assigned to Reown (you keep a licence to use it
only in conjunction with the packages while the licence is in effect, must mark changed files,
and must hand Reown the source/binary on request); your own app stays yours. Distribution
requires the notice "Portions © 2025 Reown, Inc. All Rights Reserved" and a copy of the
licence, and as a material condition all use must connect to the proprietary Reown gateway
infrastructure and the WalletConnect messaging protocol.

WalletConnect peers are ordinary dApp origins
keyed `walletconnect:<session topic>`: their sessions live in `engine.connections` alongside
browser sessions, and every `session_request` runs through the same handlers and request pipeline
the in-app browser uses, so the approval UI and risk checks are unchanged.

```ts
import { createWalletConnect } from "@qntx/wallet-engine/walletconnect";

const walletConnect = await createWalletConnect({
  projectId, // from the Reown dashboard — see the checklist below
  metadata: {
    name: "my wallet",
    description: "…",
    url: "https://wallet.example",
    icons: ["https://wallet.example/icon.png"],
    redirect: { native: "mywallet://", universal: "https://wallet.example/wc" },
  },
  storage, // WalletConnectStorage — a host-provided key-value store, required
  wallet, // the same Wallet the engine was built on
  engine, // the WalletEngine
  now: () => Date.now(),
  logger: { warn: (m, e) => console.warn(m, e) },
});
await walletConnect.dispose();
```

`walletConnect.getState().proposals` lists open proposals (peer name/url — self-declared, display
only — Verify status, risk findings, offerable networks). `approve(id, { networks, acknowledged })`
grants a subset of the offered networks and returns the `ConnectionSession`; `reject(id)` answers
USER_REJECTED. Danger findings must be passed back in `acknowledged` or `approve` throws
`"unacknowledged"`. `pair(uri)` accepts a `wc:` URI; `dispose()` tears down the relay connection —
sessions persist in the engine's connection store, not in WalletConnect's.

### Storage

`storage` is mandatory (`WalletConnectStorage`: `getKeys`/`getEntries`/`getItem`/`setItem`/
`removeItem`, JSON values). The SDK persists sessions, pairings, keys and pending requests there;
give it durable storage or every restart loses the pairings.

- **Web:** an IndexedDB-backed key-value store the host provides (a `localStorage` JSON shim works
  for a playground, not for production).
- **React Native:** `import "@walletconnect/react-native-compat"` as the **first** import of the
  app entry — before anything that transitively loads the SDK. Its peer dependencies:
  `@react-native-async-storage/async-storage`, `@react-native-community/netinfo`,
  `react-native-get-random-values`, `expo-application`. Back `storage` with AsyncStorage.

### Globals WalletKit needs

| Global                                                   | Web                                                    | React Native              |
| -------------------------------------------------------- | ------------------------------------------------------ | ------------------------- |
| `WebSocket` (captured once at module load)               | built-in                                               | built-in                  |
| `fetch` (Verify, telemetry off, Echo only if registered) | built-in                                               | built-in                  |
| `crypto.getRandomValues`, `crypto.randomUUID`            | built-in                                               | via `react-native-compat` |
| `TextEncoder`/`TextDecoder`, `atob`/`btoa`               | built-in                                               | via `react-native-compat` |
| `URL`                                                    | built-in                                               | via `react-native-compat` |
| `navigator.product`, `NetInfo`                           | n/a                                                    | via `react-native-compat` |
| `window`/`document`/`localStorage`                       | dApp-side branches only — the wallet never enters them | n/a                       |

### Deep links

A scanned QR or pasted `wc:` URI goes `engine.payments.parse(text)` → `{ kind: "walletconnect",
uri }` → `walletConnect.pair(uri)` — parse only pairs the `walletconnect` result. On mobile,
register the app's universal link (iOS) / scheme (Android) for `wc:` URIs and set
`metadata.redirect` so dApps can return to the wallet.

### Namespaces and methods

| Namespace | Methods                                                                                                                                                                                                                                       | Events                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `eip155`  | `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, `wallet_sendCalls`, `wallet_getCallsStatus`, `wallet_showCallsStatus`, `wallet_getCapabilities`, `wallet_watchAsset`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` | `accountsChanged`, `chainChanged`                            |
| `solana`  | `solana_signMessage`, `solana_signTransaction`, `solana_signAllTransactions`, `solana_signAndSendTransaction`                                                                                                                                 | `accountsChanged`, `chainChanged`                            |
| `bip122`  | `getAccountAddresses`, `signMessage`, `signPsbt`, `sendTransfer`                                                                                                                                                                              | `accountsChanged`, `chainChanged`, `bip122_addressesChanged` |

Limits: `eth_sign`/`eth_signTypedData`(v1/v3)/`eth_signTransaction` are never approved (the
injected provider refuses them too); BIP-322 is the only `signMessage` protocol (`ecdsa`/absent →
4200); `sendTransfer` refuses `memo` (no OP_RETURN); `solana_signAndSendTransaction` ignores
`sendOptions` — the engine broadcasts with its own settings; bip122 sessions advertise only the
payment address (the ordinal address comes back from `getAccountAddresses`). A proposal's embedded
`requests.authentication`/`requests.walletPay` are ignored — approval proceeds without them.

### Verify, phishing, lifecycle

Each proposal carries a WalletConnect Verify result plus the engine's phishing check on the
peer's metadata origin: `isScam` and `INVALID` are `danger` findings (`verify-threat`,
`verify-mismatch`) that block approval unless acknowledged; `UNKNOWN` is neutral. A peer on the
phishing deny list is rejected outright.

A proposal that arrives while the vault is locked is held and judged on unlock; an expired one is
dropped. Session requests requeue on a mid-approval lock, except one-click auth, which is refused.
Pending requests, sessions and pairings survive restarts via `storage`. Sessions expire with the
WalletConnect TTL and reconcile against the connection store; revoking the origin or a dApp
disconnect deletes both.

### One-click auth

`session_authenticate` requests are validated (peer URL, domain = peer host, SIWE URI = peer
origin, every recap chain on the session's network), signed as a SIWE `personal-message` through
the ordinary `evm-sign` pipeline — the existing sign-in parse and risk display apply — and settled
as a Cacao. When the recap carries eip155 methods the auth also creates the session; without
methods it stays an auth.

### One instance

One `createWalletConnect` per JS runtime: Core keeps a global singleton keyed by storage prefix
(`DISABLE_GLOBAL_CORE` opts out). Telemetry is always off.

### Host checklist

- `projectId` from the [Reown dashboard](https://dashboard.reown.com) — not a secret, but configure
  the project's allowed domains/bundle ids there.
- **License:** WalletConnect is under the WalletConnect Community License — Reown's relay is
  mandatory and the free tier covers ≤ 500 MAU and ≤ 2.5 M relay RPC calls/month. Take a
  commercial licence before a public release above that, and never patch or fork the SDK (§1c).
- Register the deep link / universal link and set `metadata.redirect`.
- On RN, `react-native-compat` must be the first import.
- Upgrade `@reown/walletkit` only together with the `@walletconnect/*` packages — WalletKit pins
  core/utils/types exactly.

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
