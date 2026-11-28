# Security Policy

This project handles private keys. Please do not report vulnerabilities in
public issues.

Report a vulnerability through GitHub's private vulnerability reporting
(Security → Advisories → Report a vulnerability on this repository), or by
emailing **<x@qntx.org>**, with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- the affected versions and platforms.

We aim to acknowledge reports within 72 hours and will coordinate a fix and
disclosure timeline with you. What happens after a report — triage, severity,
a bad release, a key compromise, user notification — is in
[docs/incident-response.md](docs/incident-response.md).

## Trust boundary

Secrets (seed, private keys, the vault DEK) exist only inside the kernel —
a Web Worker on web, an isolated Hermes runtime on React Native, a child
worker on Node. The main runtime carries no signing secrets except user
exports and the data key. The kernel accepts one serialised command queue
and validates every message: protocol version, request id, whitelisted
fields, a 1 MiB cap (`MAX_REQUEST_BYTES`), and only `status`/`vault.reset`
while the vault is unhealthy — the request path is `handle`/`dispatch` in
`packages/wallet-kernel/src/kernel.ts`.

The gated commands run one live user verification per request inside the
kernel (`verifyFactor` in `packages/wallet-kernel/src/vault/vault.ts`):
`chain.sign`, `chain.exportAccount`, `hardware.begin` (sign, pair, and an
`accounts` fetch that adds material — a re-read of pinned paths needs none),
the verify-bearing `card.begin` ops (`verifyGate` in
`packages/wallet-kernel/src/modules/card/ops/index.ts`: add, create, sign,
transfer, reseal, erase, change-access, forget-access), `sessions.create` /
`sessions.open`, `wallet.delete`, `wallet.exportMnemonic`,
`keys.export`/`keys.remove`, `backup.enable`/`backup.disable`/
`backup.restore`, `nostr.exportKey`, factor and policy changes
(`addFactor`/`removeFactor`/`enrolVerification`/`setAppLock`/
`setBlindSigning` in `packages/wallet-kernel/src/commands/vault.ts`), and
`spark.approve`. `keys.import` (secret admission) runs no verification by
design (`importKey` in `packages/wallet-kernel/src/commands/keys.ts`): its
method is only marked presence, which re-arms the Web idle timer and
nothing else. Value-moving sessions verify at `sessions.create`/
`sessions.open`, then sign within their approved limits until the next
lock. A `device` factor can open the vault for everyday use but proves no
presence — it can never verify (`verifyFactor` rejects it).

Verification prompts are rendered by the kernel and bound to
`PROMPT_BOUNDS` (`packages/wallet-kernel/src/prompts.ts`). The bounds
are policy values, not platform facts — neither OS documents a limit — and
are still to be confirmed on real devices (`docs/device-checklist.md`). A
`chain.sign`, `hardware.begin` or `spark.approve` prompt that does not fit
signs blind (or fails `blind-signing-disabled`) instead of letting the OS
clip it: every warning and caveat row is rendered first and is never cut —
only detail rows give way to a closing "N more lines" row — and a prompt
whose warnings alone do not fit is refused `unsupported` whatever the blind
policy (`boundPrompt` in
`packages/wallet-kernel/src/modules/chains/prompt.ts`).
Session-approval and watch-only export prompts are never cut: limits or a
node list whose text does not fit are refused `invalid-input` before any
verification. The core prompts are fixed strings whose fit the prompt-bound
tests pin. Face ID and WebAuthn ceremonies show no kernel text at all — the
OS dialog is all the user sees — so on those flows approval proves presence
only; the signed content is bound by the decoder and policy, not by text
the user read. The one exception is a value-moving session's limits, which
React Native shows on a kernel surface on every platform (below).

**Blind signing** is a kernel-enforced vault setting, off by default: a
request the chain decoder can neither display nor bound fails
`blind-signing-disabled` before any prompt, on every host.

Summary, per platform — details in the sections below:

| Attacker                   | Web                                                                                                                                                                                                                                   | React Native                                                                                                                                                                            | Node                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Compromised main runtime   | page-level attacker — the Web wallet is a hot wallet (session limits are whatever the page asked for); in scope only where it defeats the Worker boundary                                                                             | deception and phished fields possible; no secrets, no unverified gated signature; open sessions bounded by limits shown on a kernel surface                                             | same as RN minus keystore prompts; dev host              |
| Malicious dApp or caller   | deceptive requests; nothing the decoder cannot display or bound                                                                                                                                                                       | same — on iOS session limits still appear on the kernel secure-input view; other prompts are presence-only under Face ID                                                                | same                                                     |
| QR counterpart             | chooses every signed byte (EVM nonce and fees included); sign-in domains are unverifiable and need an explicit acknowledgement; nothing the decoder cannot display or bound                                                           | same                                                                                                                                                                                    | same                                                     |
| Storage writer             | whole-vault rollback caught only if the anchor store (Cache Storage) is untouched                                                                                                                                                     | whole-vault rollback caught (anchor outside the app container); record-level tamper impossible                                                                                          | store and anchor are process memory; neither outlives it |
| Compromised gateway / RPC  | wrong display data, withheld broadcasts; cannot change signed bytes where a second endpoint exists                                                                                                                                    | same                                                                                                                                                                                    | same                                                     |
| Stolen unlocked device     | unlocked session scope: social actions, DMs, open sessions within limits — nothing verification-gated                                                                                                                                 | app lock off: social/DMs only — value-moving sessions refuse `app-lock-required`; app lock on: open sessions within limits until the next lock (15 min presence idle, 24 h, background) | unlocked session scope, as Web                           |
| Stolen locked device       | offline attack on vault/backup at PBKDF2 / Argon2id cost                                                                                                                                                                              | same, plus keystore wrapping                                                                                                                                                            | same                                                     |
| Malicious external signer  | foreign keys a transport injects land unconfirmed until an on-device address check, and Bitcoin prompts never treat them as your own; a counterfeit or malicious device is not detectable host-side — its check confirms its own keys | same                                                                                                                                                                                    | same                                                     |
| Lost card (production)     | no card exists in production builds — `PRODUCTION_ANCHORS` is empty, so every card is refused                                                                                                                                         | same                                                                                                                                                                                    | same                                                     |
| Malicious upstream package | versions pinned, `abiVersion` checked at kernel start; release controls are defined in the repo and must be applied by the owner                                                                                                      | same                                                                                                                                                                                    | same                                                     |

## Per attacker

### Compromised main runtime (malicious dependency, tampered host app)

- **Cannot** read kernel memory, run code inside the kernel, or make a
  `device` factor pass verification; **cannot** sign a `chain.sign`, export
  secrets, delete the wallet, or enable backup without one live
  verification.
- **Can**, inside an unlocked vault, drive every session-wide grant:
  sign arbitrary Nostr events and encrypt/decrypt any DM —
  `nostr.signEvent`, `nostr.nip04Encrypt`/`nip04Decrypt` and
  `nostr.nip44Encrypt`/`nip44Decrypt` take no per-call factor
  (`packages/wallet-kernel/src/modules/nostr/ops.ts`
  `sign`/`nip04Encrypt`/`nip04Decrypt`/`nip44Encrypt`/`nip44Decrypt`;
  only Nostr key export verifies —
  `packages/wallet-kernel/src/modules/nostr/keys.ts` `exportKey`).
- **Can** present its own UI and get approved whatever the user is willing
  to confirm — on Face ID and WebAuthn there is no kernel text to compare
  against (presence is proven; content is not shown). Value-moving session
  limits are the exception on React Native (see below).
- **Can** draw a look-alike input field and phish secrets the user types
  into it — the same residual as any prompt the kernel does not render.
  The kernel secure input
  (`SecureInput`, `@qntx/wallet-native/secure-input`) exposes only
  `idle|empty|filled|submitted` to the main runtime — the RN backup
  password reaches the kernel through it and never over the wire
  (`packages/wallet-kernel/src/commands/backup.ts` `ask`) — but the
  kernel cannot stop a decoy field on the same screen.
- **Value-moving sessions:** every session signature needs the session
  open — a verifying factor after each lock (`sessions.open`); on a
  keystore host whose vault holds a `device` factor (app lock off), create
  and open answer `app-lock-required`, so a session cannot be silently
  re-armed
  (`packages/wallet-kernel/src/modules/sessions/sessions.ts` `assertAppLock`). While
  a session _is_ open, `sessions.sign` still signs — but bounded:
  - `hyperliquid-l1-agent` enforces the approved `limits` — a notional
    budget buys charge (sum of max(price, triggerPx) × size in each
    market's quote currency), a `maxLeverage` cap, and a per-asset size
    cap buys and sells share (ids 0..99999; builder-dex HIP-3 ids ≥ 100000
    are never admissible) — `meterHyperliquid` in
    `packages/wallet-kernel/src/modules/sessions/schemes/hyperliquid-l1-agent/meter.ts`,
    validated by
    `packages/wallet-kernel/src/modules/sessions/schemes/hyperliquid-l1-agent/params.ts`
    `hyperliquidL1Params`/`hyperliquidL1Spent`.
    `spent` is committed to the vault record before
    the signature returns, so relaunching cannot reset it. **The limits
    are the bound on loss**: the kernel cannot know market prices, so a
    sell's self-declared price never bounds it — buys lose at most
    `notional`; sells (and shorts) dispose of at most `size` of each
    listed asset at any price the exchange accepts (its far-from-oracle
    price bands are unverified and not relied on). Cancels are free but
    stay inside the allow-list so a session cannot strip protection on
    positions it never touched, and at most two live metered sessions may
    share one account and network (`MAX_METERED_PER_OWNER`), so the
    aggregate exposure is the sum of at most two approvals. TWAP orders
    cannot be metered and are refused. **Asset ids, not names:** the
    approval prompt labels each market by its numeric asset id rendered
    `#id`, split perp/spot at id 10000 — the kernel keeps no trusted
    id→name map, so the host must display the id next to its own market
    name. Residual: a compromised runtime can label its own screen with a
    different market name — the user's check is the id itself.
    **Where the limits are shown:** on RN iOS — where Face
    ID/Touch ID renders no prompt text — create and open first show them
    on the kernel's secure-input view, as the label above a kernel-drawn
    4-digit confirmation code the user re-enters; the main runtime never
    learns the code, so a submitted code shows the kernel-rendered label
    was on screen, then the factor ceremony still runs. Residual: the code
    line is the label's last line for the view's own sizing, but ancestors
    laid out by the main runtime can clip from the top or draw an overlay —
    neither is prevented (same residual as the phishing note above). On
    Android the bounded kernel text is what
    BiometricPrompt shows, so no code step is needed. On the Web there is
    no such surface: the limits are whatever the page asked for — the
    Web wallet is a hot wallet. The revoke flow's throwaway agent stays
    (Hyperliquid has no revoke action without a new agent —
    nonces-and-api-wallets §API wallet pruning) and goes through the same
    approval, so a full-limit `create` cannot masquerade as a revoke:
    the limits differ on the kernel-rendered text. Each agent
    signature also stays inside a 60 s document window (`expiresAfter`,
    nonce, device clock — the kernel has no trusted time; a clock running
    S ahead stretches post-lock exposure to S + 60 s, and the engine's
    `assertClock()` 5 s check
    (`packages/wallet-engine/src/apps/hyperliquid/exchange.ts`
    `assertClock`) runs in the main runtime and can be skipped
    by one that is compromised).
  - **Polymarket** holds no kernel session key: orders are EIP-712 signed
    through the per-request pipeline (each needs verification). The L2
    HMAC credentials can only read positions/orders and cancel — annoying,
    not value-moving
    (`packages/wallet-engine/src/apps/polymarket/trade.ts`
    `createPolymarketTrade`,
    `packages/wallet-engine/src/apps/polymarket/account.ts`
    `createPolymarketAccount`).
  - **Fiat24** holds no session key: the grant text is signed via
    `chain.sign` per request with a kernel-enforced deadline ≤ 20 minutes
    (`FIAT24_SESSION_WINDOW` in
    `packages/wallet-kernel/src/modules/chains/evm.ts`, checked at prepare
    and re-checked after verification before the device or the software
    path signs). Within a granted window the holder can view card
    details and act as the card; it cannot move the signing key.
  - `SESSION_SCHEMES`
    (`packages/wallet-kernel/src/modules/sessions/schemes/index.ts`)
    contains exactly `hyperliquid-l1-agent` — there is no other kernel
    session-key path.
- **Spark:** transfers out move only under a live approval the user
  verified — `spark.approve` decodes the intent, renders it inside the
  prompt bounds, then runs the factor check
  (`packages/wallet-kernel/src/modules/spark/index.ts` `approve`). An
  approval lives at most 60 s (`APPROVAL_TTL_MS`), at most 8 are live per
  account (`APPROVAL_MAX_PER_ACCOUNT`), and coverage is matched per kind:
  a transfer intent binds the receiver set and per-receiver amounts,
  lightning/exit intents spend a cumulative budget deduped by leaf public
  key. **Residual:** an outflow classified
  `swap` — every leaf paying the SSP identity — carries only `transferId`
  and `totalSats`, so the signer's `authorize` callback cannot tell who it
  pays or bound the amount, and lets every swap through unapproved.
  Until the upstream signer binds the leaf set or the
  swap intent into the signed payload, a compromised runtime can move any
  amount to the SSP with no approval; the swap is redeemable only through
  SSP cooperation, which contains the practical damage.
- On **React Native**, kernel secrets additionally sit behind the platform
  keystore; the password and passkey PRF output never cross to the main
  runtime. On **Web** the boundary is weaker by construction — see below.

### Malicious or foreign external signer (Ledger, OneKey, Keystone)

- **The transport is the main runtime.** Every exchange between kernel
  and device crosses host code the kernel does not control, and a
  compromised runtime can drive an honest device directly — **the device
  screen is the control**, not the kernel prompt.
- **Device-chosen ECDSA nonces cannot be audited host-side** — an
  anti-exfiltration protocol does not exist here, so a malicious device can
  leak key material through its signatures undetectably.
- **`clear`/`blind` device lines are source-derived claims** about pinned
  app versions — the kernel does not verify what the device will actually
  render.
- **Pairing and key-adding fetches are verification-gated** (`pair`
  requires a factor; `accounts` requires one when the pin lacks paths, and
  always consumes one when presented — `hardware.begin` in
  `packages/wallet-kernel/src/modules/signers/index.ts`), but a hostile
  transport at first fetch can pin foreign receive keys — the fingerprint
  comparisons replay public values and stop only an accidental second
  honest device. **The on-device address check is the control against
  the transport:** pinned entries land `confirmed: false` until
  `verify-address` matches on the device (`servingPath`/`mergePin`;
  `confirmed` is committed on a match only). `confirmed` tells "this
  device's keys" from "keys the transport injected" — it says nothing
  about the device itself: a counterfeit or malicious device holds the
  foreign keys, shows the pinned address and is confirmed; no host-side
  check can detect it. `wallet.accounts` reports `confirmed` per account,
  and `chain.exportAccount` refuses unconfirmed material unless the caller
  passes `acknowledgeUnconfirmed`, which adds a danger row per node
  (`exportAccount` in
  `packages/wallet-kernel/src/modules/chains/export.ts`).
- **Unconfirmed keys are never "your own address".** A Bitcoin output
  whose key an unconfirmed entry serves is never hidden as change and
  never worded as an own-address send — but an internal request's
  discoverable output on such a key still raises the change mark after
  the factor verifies, which only widens the wallet's own scan (at most
  `BITCOIN_GAP_LIMIT` per approved signature): the
  prompt shows it as an ordinary send with a danger row
  (`bitcoinOwn` in `packages/wallet-kernel/src/modules/chains/bitcoin.ts`),
  and the `hardware.begin` `sign` operation refuses `approval-required`
  before any prompt unless the caller passes `acknowledgeUnconfirmed`
  (`prepareApproval` in `packages/wallet-kernel/src/modules/chains/index.ts`).
  The engine's dApp, QR and own-send previews apply the same rule and
  raise a `bitcoin-unconfirmed-output` danger finding, and its history
  reads transfers to such keys as sends, never as `self`. On Face ID and
  WebAuthn ceremonies no kernel text is shown (trust boundary, above), so
  the danger row is not either: there `acknowledgeUnconfirmed`, which the main
  runtime supplies, is the only gate, and the device screen and the host's
  own UI are the only places the user can see the warning.
- **Per-driver confirmation ability:** Ledger and OneKey display the
  address on-device. Keystone has no host-initiated display — the user
  compares against the device's Receive menu, which covers only the
  allow-listed paths (`confirmable` in
  `packages/wallet-kernel/src/modules/signers/keystone/driver.ts`): EVM
  and TRON bip44-style groups, Solana groups 0–49
  (`KEYSTONE_SOLANA_GROUP_MAX` — the firmware pre-derives only those), and
  BTC mainnet account-0 receive addresses — BTC testnet/signet, BTC
  group > 0 and Solana group ≥ 50 can never be confirmed on a Keystone.
- **Residual:** a runtime still compromised at check time can forge the
  verdict — the confirmation marks that a check happened, not that the
  transport was honest.

### Malicious dApp or caller

- **Cannot** get a request signed that the decoder cannot display or bound
  (blind signing off by default); **cannot** get an EIP-7702 authorization
  with `chainId = 0` signed — refused before the prompt
  (`packages/wallet-chains/src/evm/transaction.ts` `normalizeEvmTransaction`);
  **cannot** order or cancel through a session scheme outside its approved
  limits.
- **Cannot** hide a Bitcoin output as change the wallet cannot find
  again. The hidden-change bound is the kernel-sealed change mark, never
  anything in the PSBT: per (wallet, group, purpose, network) a monotonic
  mark lives in a `change-marks` vault record
  (`CHANGE_MARKS_KIND`/`commitChangeMarks`/`marksHooks` in
  `packages/wallet-kernel/src/modules/chains/marks.ts`). Only
  `origin: "internal"` requests — the ones the engine built — raise it,
  before signing, to the highest change index they hide; signed inputs
  never raise it for any origin, so neither an invented nor a real coin
  far out on the change chain moves the mark. An external request may
  hide change inside the current window but commits no raise at all, so
  no outside caller can ratchet the mark (and the scan cost behind it) by
  getting signatures it never broadcasts. An own-key output is
  hidden only on the change chain, under a purpose a signed input shares,
  at an index at most `BITCOIN_GAP_LIMIT` (20) past that mark and below
  `BITCOIN_SCAN_LIMIT` (`isDiscoverableChange`). The engine scans the
  change chain out to `changeScanReach(mark)` — every hidden index is
  re-discoverable. `changeAddressOf`
  (`packages/wallet-engine/src/transactions/bitcoin.ts`) places the change
  of the engine's own sends at the lowest index above the sealed mark that
  the in-flight picks and the output addresses of tracked rows that reached
  `signed` leave free (a `draft` or `rejected` row never produced bytes,
  or its sign call failed after the marks commit — which had already
  moved the mark past that index); when the window to
  `changeScanReach(mark)` holds none it reuses the address at the reach —
  at the scan limit the mark itself — so no send, sweep, replacement or
  CPFP is ever refused for want of a change address; reuse costs privacy
  only. It never reads an endpoint's "used" answers. Every
  other own-key output is shown as a send to the user's own address at its
  unusual path, with a warning that the wallet may not display those
  funds. **Residuals:** a fully compromised runtime can claim `internal`
  and hide change up to the window's edge, raising the mark by up to
  `BITCOIN_GAP_LIMIT` per signature — coins stay on the user's keys and
  inside the scan; same class as hiding a balance in its own UI. A change
  chain whose used addresses walk the gap scan to `BITCOIN_SCAN_LIMIT`
  (2000) makes that template's scan fail (`scanChainWithHistory` in
  `packages/wallet-engine/src/chains/bitcoin-scan.ts`), and a mark at the
  limit leaves no fresh index: every send with change from that template
  reuses the address at index 1999 of the change chain. The mark is not in the backup
  (entropy only): a seed-only restore starts it at 0, and the same seed on
  two devices carries two independent marks, so such a device places
  change on indexes the seed already used — address reuse that costs
  privacy — except for a mark ratcheted under 0.14.0 (its endpoint could
  walk the mark one gap limit per send): that mark is kept, so change
  keeps landing at mark + 1 and beyond, past a seed-only restore's
  gap-limit-20 scan; such coins stay visible on this device and to a
  restore that scans with a gap of at least mark + 20, but a default
  restore does not show them, and no command lowers a mark. Each internal
  send whose factor verified but that never confirms — signed and never
  broadcast, or declined on the device after the marks commit — consumes
  one change index; twenty in a row leave a 20-address gap that this
  device's scan (which follows the mark) still crosses but a
  gap-limit-20 wallet restored from the seed stops at, until it scans
  with a larger gap. Every such index costs a user approval — the factor
  verification that precedes the marks commit; a sign attempt that fails
  before it (a cancelled prompt, a wrong password, a pre-verify refusal)
  consumes none.
- **Can** craft deceptive requests. Solana named accounts loaded through
  address lookup tables cannot be verified on-device — there are no state
  proofs for table contents — so a prompt that would name one is handled
  under the blind rule
  (`solanaLookupTable` in
  `packages/wallet-kernel/src/modules/chains/prompt.ts`).
  On Face ID / WebAuthn flows the user sees no kernel text at all, so
  approval there proves presence only.

### QR counterpart (desktop coordinator or watch-only wallet)

A scanned request is one more request origin (`{ kind: "qr" }`): it goes
through the same pipeline, decoder, blind-signing policy and per-request
verification as a dApp request (`packages/wallet-engine/src/qr/bind.ts`),
and the kernel cannot tell the two apart.

- **Can** choose every byte it asks the wallet to sign: an EVM transaction
  is signed exactly as scanned, nonce and fees included (they are shown as
  checks, never rebuilt), because the counterpart broadcasts it — the
  wallet never broadcasts a QR request.
- **Cannot** get a domain verified: a sign-in message from a QR origin has
  no page origin to check, so it carries the `danger` finding
  `qr-sign-in-unverified`, which the user must acknowledge before approval
  (`packages/wallet-engine/src/requests/controller.ts`).
- Hardware-wallet accounts sign QR, dApp and internal requests through the
  same signing seam; the device shows its own rendering on top of the
  kernel's.
- **Watch-only side:** the scanned export is the trust root — a malicious
  export replaces every address, so the user verifies the first receive
  address on the phone. The export itself is verified on the phone with a
  prompt that names every exported node and adds a danger row for each
  unconfirmed one (`exportAccount` above); `evm.account` discloses the EVM
  addresses of every account of the wallet. Inspect-only mode shows the
  digests a device can display, labelled with a device only where a
  primary source says the device shows that digest; it cannot prove the
  desktop sent the device the bytes it shows.

### Storage writer (file-level, not kernel compromise)

- **Cannot** add, remove or alter a single vault record or factor — the
  manifest digest covers every row and is rewritten on each structural
  commit (`assertManifest` in
  `packages/wallet-kernel/src/vault/manifest.ts`).
- **Can** roll the whole vault back to an older consistent image — the
  vault anchor detects this where it is stored honestly
  (`reconcile`/`raiseAnchor` in `packages/wallet-kernel/src/kernel.ts`,
  `readAnchor` in `packages/wallet-kernel/src/vault/anchor.ts`): the
  21-byte anchor holds a revision floor and the
  password failure counters, so a restored older image reads `corrupted`
  and the password backoff is not reset. No platform gives an app a
  hardware monotonic counter, so the floor is only as strong as its
  storage:
  - **React Native**: iOS keychain item (`WhenUnlockedThisDeviceOnly`) /
    Android Keystore alias, outside the app container and never backed up.
    Catches a writer of the app's files who cannot write that store; does
    not stop root/jailbreak, code running as the app, or a whole-device
    restore.
  - **Web**: Cache Storage — a different backend from the IndexedDB vault
    (Chromium keeps all IndexedDB databases of an origin in one LevelDB),
    so restoring the vault database alone is caught; same-origin script,
    an extension, or a whole-profile restore rewrites both. The online
    backoff never slows an attacker who can read storage — the password
    factor is attacked offline at its PBKDF2 cost.
  - **Node**: store and anchor live in process memory; neither outlives
    it.

### Compromised gateway or RPC endpoint

- **Can** return wrong balances, prices and history — all display data; a
  build that could not cross-check a second endpoint is tagged
  `reads-unverified` (`packages/wallet-engine/src/requests/checks.ts`).
  A compromised gateway can withhold or delay broadcasts.
- **Cannot** change what the kernel signs — values used to build or sign
  transactions come from chain RPC and are cross-checked against the
  second endpoint where one exists (nonce, blockhash, Solana lookup
  tables); the relay switches providers only when the submission provably
  never arrived.
- **Cannot** move the sealed change mark beyond the wallet's own sends.
  The change index ignores the endpoint's "used" answers and signed inputs
  never raise the mark, so a lying Bitcoin endpoint — the only one or not
  — advances it by at most one index per send the user signs. It can
  invent coins (the send then fails to broadcast), hide real ones, or
  answer "used" for every scanned address until the scan fails at
  `BITCOIN_SCAN_LIMIT`: each costs availability, not funds or the
  change-discovery bound. The second endpoint is never asked about the
  coins a send spends.
- **Privacy:** the gateway sees a fresh client id per session and per
  scope (one per chain family plus `service`), and each scope's requests
  name only that scope's data. What links scopes is the network layer —
  client IP and request timing; hiding that needs an OHTTP-style relay
  this release does not ship.

### Stolen unlocked device

- With the app lock **off** (the vault holds a `device` factor): the vault
  opens without presence — the holder can act socially and read sealed
  DMs. Value-moving sessions refuse outright: `sessions.create`, `open`
  and `sign` all answer `app-lock-required` on a device-factor vault
  (`assertAppLock` above), and every verification-gated action
  still needs a presence verification.
- With the app lock **on**: every unlock verifies, and an open session
  signs within its approved limits only until the next lock — an explicit
  `vault.lock`; the idle timeout; the max-session deadline; or background
  under the auto-lock policy (`checkTimeouts` in
  `packages/wallet-kernel/src/session/session.ts`). The idle rule
  differs by host: on a **keystore host** (React Native, Node with a
  keystore) only a successful factor verification re-arms the 15-minute
  deadline — `verifyFactor` touches the session itself and the request
  loop counts presence-marked methods only when no keystore exists
  (`handle` in `packages/wallet-kernel/src/kernel.ts`), so
  `session.touch` and other callable methods cannot hold the vault open
  (`NATIVE_POLICY` in `packages/wallet-native/kernel/policy.ts`). On the
  **Web**, presence-marked methods still count — the Web is a hot wallet
  (`idle` in `packages/wallet-worker/src/worker/browser-kernel.ts`).
  Absolute caps: 24 h on native (`NATIVE_POLICY`), 12 h on Web/Node
  (`MAX_SESSION_MS` in `packages/wallet-worker/src/shared.ts`).

### Stolen locked device

- The vault needs a verifying factor; `device` cannot verify. A copied
  vault or backup envelope is attacked offline: the backup password runs
  Argon2id (`packages/wallet-kernel/src/commands/backup.ts`,
  64 MiB). On hosts where the password passes through the main runtime
  (Web/Node) the engine also refuses a guessable one at enable
  (`packages/wallet-engine/src/backup/controller.ts`); on React
  Native the kernel collects it through the secure input and enforces the
  12-code-point minimum (`BACKUP_PASSWORD_MIN` in
  `packages/wallet-kernel/src/vault/factors.ts`).

### Lost card

- `card.begin`/`card.step`/`card.cancel` carry the whole card op life cycle
  (`CARD_METHODS` in `packages/wallet/src/protocol/card.ts`). The verify
  requirement is per op kind (`verifyGate` above): `add`, `create`,
  `sign`, `transfer`, `reseal`, `erase`, `change-access` and
  `forget-access` verify — `add` adopts a card's whole wallet as fully
  confirmed own material, so it is gated like a hardware `pair`; `status`,
  `accounts` and `health` are presence-free by design — they hand out no
  secrets and add no trusted material. The session is re-checked after the
  verification, before change marks commit or the first tap. A `remember` on a verify-bearing op stores a hash of the
  access code keyed to app-lock-on and a hardware verify
  (`rememberGated`); the remembered hash alone never lifts the verify —
  the gate runs first.
- Genuineness is anchored to `PRODUCTION_ANCHORS`
  (`packages/wallet-kernel/src/modules/card/protocol/identity.ts`),
  which is empty today — **a production build refuses every card**; test
  anchors live in tests only.
- Host entropy is mixed into CREATE with no host-side proof the card
  mixed it.
- APDUs never pass through the main runtime: the kernel hands
  record-layer ciphertext straight to the native card reader
  (`__qntx.cardReader`) and the NFC session's text and end are owned by
  the kernel — the main runtime only drives the tap cadence.

### Malicious upstream package

Protocol library versions are pinned exactly and recorded in the kernel
manifest; backend `abiVersion` is checked at kernel start (AGENTS.md
invariants). The release-path controls are defined in the repository —
tag-only OIDC publishing in `.github/workflows/publish-npm.yml`, the environment and tag
rulesets in `.github/rulesets/` — and applied as repository and npm
settings; `.github/rulesets/README.md` records them and what a single
admin can still do alone. `scripts/check-toolchain.ts`, run by
`bun run lint` on every PR, is a lint against accidental toolchain drift
— an unpinned tool or an install outside the lockfile introduced by
mistake — not a boundary against a hostile committer: a reviewed change
to the CI files can evade it, and review plus branch protection are that
boundary. Third-party npm
versions are adopted only once seven days old: `bunfig.toml`
`minimumReleaseAge` for bun, and the consumer smoke's npm lockfile is
regenerated by `packages/wallet-worker/scripts/consumer-lock.ts` with
npm's `--min-release-age` under the same `minimumReleaseAgeExcludes`
pins. The response to a compromised release is in
`docs/incident-response.md`. There is no runtime update channel.

## Deployment rules for hosts

- **Passkey rpId:** the seed is the passkey's PRF output and WebAuthn
  scopes a passkey to its RP id, not to one origin — every origin and app
  entitled to the configured `rpId` is inside the trust boundary. Hosts
  must use a wallet-only domain; a finding that needs script execution on
  such an origin is in the same class as script execution on the wallet's
  own page.
- **Web is a hot wallet:** the password and PRF output pass through the
  page's main thread because WebAuthn is main-thread only. The Web wallet
  resists passive leaks, not active in-page script — reports needing that
  attacker are in scope only where they defeat the Worker boundary.
- **RN app lock:** leaving it off stores a `device` factor and disables
  presence enforcement for session create/open (`app-lock-required`); a
  wallet holding value-moving sessions should require the app lock.
- **Unconfirmed signers:** the flag is carried by `wallet.accounts`
  (`confirmed` per account), `TransactionsController.nextReceiveAddress`
  (`{ address, confirmed }`), `chain.exportAccount` and `QrExportParams`
  (`acknowledgeUnconfirmed`), Bitcoin signing (the danger row, the
  `bitcoin-unconfirmed-output` finding and `acknowledgeUnconfirmed` on the
  `hardware.begin` `sign` operation) and Bitcoin history. The engine keeps
  unconfirmed accounts out of push subscriptions (no gateway watches or
  learns their addresses) and out of the history addresses that vouch for
  themselves: an unconfirmed own address is not exempt from the
  `address-poisoning` flag — not even as the recipient of a tracked send:
  an outflow the decode marks `unconfirmed-signer-output` never enters
  the exempt set (`vouchingOutflows` in
  `packages/wallet-engine/src/requests/risk.ts`), in requests and in
  history — but it stays a reference, so a counterparty
  imitating it is flagged like one imitating a confirmed address
  (`assessRecipients` in `packages/wallet-engine/src/requests/risk.ts`). A
  successful `engine.signers.verifyAddress` takes effect at once —
  `SignersState.confirmations` moves, history reloads its loaded groups
  and push reconciles; a confirmation made outside the engine's signers
  controller is seen at the next reload or unlock. It is **not** carried by the
  engine's account tree, asset balances or the accounts a host grants to a
  dApp or WalletConnect session — the host picks those. Show
  an "unconfirmed — verify on the device" state wherever the host presents
  such an account, do not grant one to a dApp without it, and pass every
  `acknowledgeUnconfirmed` deliberately, never silently.
- **Backup passwords** must be entered into the kernel secure input
  (masked, no autofill/suggestions/IME learning on both platforms —
  `packages/wallet-native/cpp/platform/SecureInputIos.mm`,
  `packages/wallet-native/android/src/main/java/com/margelo/nitro/qntxwallet/SecureInputField.kt`);
  never into
  a runtime-drawn field.
- **Hyperliquid market names:** the kernel prompt shows the numeric asset
  id `#id`; hosts must display that id next to the market name they
  render, because the kernel has no trusted id→name map.
- **Secret buffers:** every secret field of a kernel request must own its
  memory — a request whose secret shares bytes with another field is
  refused, because the kernel wipes secrets in place.
- **Persisted data:** an image this build cannot read is surfaced as
  `unsupported` — `reason` `"older"` (a pre-1.0 format) or `"newer"` (a
  newer build wrote it) — and left untouched, never silently wiped;
  `vault.reset` is an explicit user call. Starting at the first
  production release (1.0),
  no upgrade discards persisted user data (vault, backup envelope, engine
  store): every format change ships a one-step, tested forward upgrade
  from the previous released format.
