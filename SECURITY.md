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
fields, a 1 MiB cap, and only `status`/`vault.reset` while the vault is
unhealthy (`packages/wallet-kernel/src/kernel.ts:407-511`).

The gated commands run one live user verification per request inside the
kernel: `chain.sign`, secret and key exports, wallet deletion, factor and
policy changes, backup enable, Nostr key export and `spark.approve`.
Value-moving sessions verify at `sessions.create`/`sessions.open` instead,
then sign within their approved limits until the next lock. A `device`
factor can open the vault for everyday use but proves no presence — it can
never verify (`packages/wallet-kernel/src/vault/vault.ts:401`).

Verification prompts are rendered by the kernel and bound to
`PROMPT_BOUNDS` (`packages/wallet-kernel/src/prompts.ts:254`). The bounds
are policy values, not platform facts — neither OS documents a limit — and
are still to be confirmed on real devices (`docs/device-checklist.md`). A
`chain.sign`, `hardware.begin` or `spark.approve` prompt that does not fit
signs blind (or fails `blind-signing-disabled`) instead of letting the OS
clip it: every warning and caveat row is rendered first and is never cut —
only detail rows give way to a closing "N more lines" row — and a prompt
whose warnings alone do not fit is refused `unsupported` whatever the blind
policy (`packages/wallet-kernel/src/modules/chains/prompt.ts:1888`).
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

| Attacker                   | Web                                                                                                                                                                         | React Native                                                                                                                                                                            | Node                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Compromised main runtime   | page-level attacker — the Web wallet is a hot wallet (session limits are whatever the page asked for); in scope only where it defeats the Worker boundary                   | deception and phished fields possible; no secrets, no unverified gated signature; open sessions bounded by limits shown on a kernel surface                                             | same as RN minus keystore prompts; dev host              |
| Malicious dApp or caller   | deceptive requests; nothing the decoder cannot display or bound                                                                                                             | same — on iOS session limits still appear on the kernel secure-input view; other prompts are presence-only under Face ID                                                                | same                                                     |
| QR counterpart             | chooses every signed byte (EVM nonce and fees included); sign-in domains are unverifiable and need an explicit acknowledgement; nothing the decoder cannot display or bound | same                                                                                                                                                                                    | same                                                     |
| Storage writer             | whole-vault rollback caught only if the anchor store (Cache Storage) is untouched                                                                                           | whole-vault rollback caught (anchor outside the app container); record-level tamper impossible                                                                                          | store and anchor are process memory; neither outlives it |
| Compromised gateway / RPC  | wrong display data, withheld broadcasts; cannot change signed bytes where a second endpoint exists                                                                          | same                                                                                                                                                                                    | same                                                     |
| Stolen unlocked device     | unlocked session scope: social actions, DMs, open sessions within limits — nothing verification-gated                                                                       | app lock off: social/DMs only — value-moving sessions refuse `app-lock-required`; app lock on: open sessions within limits until the next lock (15 min presence idle, 24 h, background) | unlocked session scope, as Web                           |
| Stolen locked device       | offline attack on vault/backup at PBKDF2 / Argon2id cost                                                                                                                    | same, plus keystore wrapping                                                                                                                                                            | same                                                     |
| Malicious upstream package | versions pinned, `abiVersion` checked at kernel start; release controls are defined in the repo and must be applied by the owner                                            | same                                                                                                                                                                                    | same                                                     |

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
  (`packages/wallet-kernel/src/modules/nostr/ops.ts:15-55`; only Nostr key
  export verifies, `modules/nostr/keys.ts:119-126`).
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
  (`packages/wallet-kernel/src/commands/backup.ts:392-449`) — but the
  kernel cannot stop a decoy field on the same screen.
- **Value-moving sessions:** every session signature needs the session
  open — a verifying factor after each lock (`sessions.open`); on a
  keystore host whose vault holds a `device` factor (app lock off), create
  and open answer `app-lock-required`, so a session cannot be silently
  re-armed
  (`packages/wallet-kernel/src/modules/sessions/sessions.ts:66-86`). While
  a session _is_ open, `sessions.sign` still signs — but bounded:
  - `hyperliquid-l1-agent` enforces the approved `limits` — a notional
    budget buys charge (sum of max(price, triggerPx) × size in each
    market's quote currency), a `maxLeverage` cap, and a per-asset size
    cap buys and sells share (ids 0..99999; builder-dex HIP-3 ids ≥ 100000
    are never admissible). `spent` is committed to the vault record before
    the signature returns, so relaunching cannot reset it. **The limits
    are the bound on loss**: the kernel cannot know market prices, so a
    sell's self-declared price never bounds it — buys lose at most
    `notional`; sells (and shorts) dispose of at most `size` of each
    listed asset at any price the exchange accepts (its far-from-oracle
    price bands are unverified and not relied on). Cancels are free but
    stay inside the allow-list so a session cannot strip protection on
    positions it never touched, and at most two live metered sessions may
    share one account and network, so the aggregate exposure is the sum of
    at most two approvals. TWAP orders cannot be metered and are
    refused. **Where the limits are shown:** on RN iOS — where Face
    ID/Touch ID renders no prompt text — create and open first show them
    on the kernel's secure-input view, as the label above a kernel-drawn
    4-digit confirmation code the user re-enters; the main runtime never
    learns the code, so a submitted code shows the kernel-rendered label
    was on screen, then the factor ceremony still runs. Residual: the main
    runtime sizes the view and can draw over part of it — the code is the
    label's last line, so clipping hides it first, but an overlay of the
    rows above it is not prevented. On Android the bounded kernel text is what
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
    `assertClock()` 5 s check runs in the main runtime and can be skipped
    by one that is compromised).
  - **Polymarket** holds no kernel session key: orders are EIP-712 signed
    through the per-request pipeline (each needs verification). The L2
    HMAC credentials can only read positions/orders and cancel — annoying,
    not value-moving (`packages/wallet-engine/src/apps/polymarket/
    trade.ts:613,746`, `account.ts:627`).
  - **Fiat24** holds no session key: the grant text is signed via
    `chain.sign` per request with a kernel-enforced deadline ≤ 20 minutes.
    Within a granted window the holder can view card details and act as
    the card; it cannot move the signing key
    (`modules/chains/evm.ts` `FIAT24_SESSION_WINDOW`).
  - `SESSION_SCHEMES` contains exactly `hyperliquid-l1-agent`
    (`modules/sessions/schemes/index.ts:10`) — there is no other kernel
    session-key path.
- **Spark:** transfers out move only under a live approval the user
  verified — `spark.approve` decodes the intent, renders it inside the
  prompt bounds, then runs the factor check
  (`packages/wallet-kernel/src/modules/spark/index.ts:564-586`). An
  approval lives at most 60 s (`APPROVAL_TTL_MS`), at most 8 are live per
  account (`APPROVAL_MAX_PER_ACCOUNT`), and coverage is matched per kind:
  a transfer intent binds the receiver set and per-receiver amounts,
  lightning/exit intents spend a cumulative budget deduped by leaf public
  key (`index.ts:333-345,377-413`). **Residual:** an outflow classified
  `swap` — every leaf paying the SSP identity — carries only `transferId`
  and `totalSats`, so the signer's `authorize` callback cannot tell who it
  pays or bound the amount, and lets every swap through unapproved
  (`index.ts:491`). Until the upstream signer binds the leaf set or the
  swap intent into the signed payload, a compromised runtime can move any
  amount to the SSP with no approval; the swap is redeemable only through
  SSP cooperation, which contains the practical damage.
- On **React Native**, kernel secrets additionally sit behind the platform
  keystore; the password and passkey PRF output never cross to the main
  runtime. On **Web** the boundary is weaker by construction — see below.

### Malicious dApp or caller

- **Cannot** get a request signed that the decoder cannot display or bound
  (blind signing off by default); **cannot** get an EIP-7702 authorization
  with `chainId = 0` signed — refused before the prompt
  (`packages/wallet-chains/src/evm/transaction.ts:206`); **cannot** order
  or cancel through a session scheme outside its approved limits.
- **Cannot** hide a Bitcoin output as change unless the wallet can find it
  again: an output to this group's own key is hidden only on the change
  chain, under a purpose a signed input shares, at an index no further than
  the gap limit (20) past the highest change index the signed inputs prove
  (`packages/wallet-chains/src/bitcoin/own.ts:37-55`). Every other own-key
  output is shown as a send to the user's own address at its unusual path,
  with a warning that the wallet may not display those funds.
- **Can** craft deceptive requests. Solana named accounts loaded through
  address lookup tables cannot be verified on-device — there are no state
  proofs for table contents — so a prompt that would name one is handled
  under the blind rule
  (`packages/wallet-kernel/src/modules/chains/prompt.ts:634,1254`).
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
  (`packages/wallet-engine/src/requests/controller.ts:2024`).
- Hardware-wallet accounts sign QR, dApp and internal requests through the
  same signing seam; the device shows its own rendering on top of the
  kernel's.
- **Watch-only side:** the scanned export is the trust root — a malicious
  export replaces every address, so the user verifies the first receive
  address on the phone. The export itself is verified on the phone with a
  prompt that names every exported node; `evm.account` discloses the EVM
  addresses of every account of the wallet. Inspect-only mode shows the
  digests a device can display, labelled with a device only where a
  primary source says the device shows that digest; it cannot prove the
  desktop sent the device the bytes it shows.

### Storage writer (file-level, not kernel compromise)

- **Cannot** add, remove or alter a single vault record or factor — the
  manifest digest covers every row and is rewritten on each structural
  commit (`packages/wallet-kernel/src/vault/manifest.ts`).
- **Can** roll the whole vault back to an older consistent image — the
  vault anchor detects this where it is stored honestly
  (`packages/wallet-kernel/src/kernel.ts:263-264`,
  `src/vault/anchor.ts`): the 21-byte anchor holds a revision floor and the
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
  `reads-unverified` (`packages/wallet-engine/src/requests/checks.ts:13`).
  A compromised gateway can withhold or delay broadcasts.
- **Cannot** change what the kernel signs — values used to build or sign
  transactions come from chain RPC and are cross-checked against the
  second endpoint where one exists (nonce, blockhash, Solana lookup
  tables); the relay switches providers only when the submission provably
  never arrived.
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
  (`sessions.ts:66-86,251,377,446`), and every verification-gated action
  still needs a presence verification.
- With the app lock **on**: every unlock verifies, and an open session
  signs within its approved limits only until the next lock — an explicit
  `vault.lock`; the idle timeout (Web 5, 15 or 60 minutes as the host
  configures, native 15 minutes — both count only presence-bearing methods,
  so trading through a session or background traffic cannot hold the vault
  open, `packages/wallet-native/kernel/policy.ts`); the max-session deadline
  (Web and Node 12 h, native 24 h); or background under the auto-lock
  policy (`packages/wallet-kernel/src/session/session.ts:122-137,235-238`).

### Stolen locked device

- The vault needs a verifying factor; `device` cannot verify. A copied
  vault or backup envelope is attacked offline: the backup password runs
  Argon2id (`packages/wallet-kernel/src/commands/backup.ts:529,561`,
  64 MiB). On hosts where the password passes through the main runtime
  (Web/Node) the engine also refuses a guessable one at enable
  (`packages/wallet-engine/src/backup/controller.ts:282-292`); on React
  Native the kernel collects it through the secure input and enforces the
  12-code-point minimum (`packages/wallet-kernel/src/vault/factors.ts:78-81`).

### Lost card

Card wallets are not yet shipped: the card protocol client is a library
and the kernel exposes no `card.*` commands. Design residual, not yet
exercised in code: the access code is the only gate, and a compromised
main runtime can draw a look-alike entry field — the same phishing class
as the secure-input residual above.

### Malicious upstream package

Protocol library versions are pinned exactly and recorded in the kernel
manifest; backend `abiVersion` is checked at kernel start (AGENTS.md
invariants). The release-path controls are defined in the repository —
tag-only OIDC publishing in `publish-npm.yml`, the environment and tag
rulesets in `.github/rulesets/` — but they are settings the repository
owner must apply; until they are applied, any repository writer can tag
and publish. The response to a compromised release is in
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
- **Backup passwords** must be entered into the kernel secure input
  (masked, no autofill/suggestions/IME learning on both platforms —
  `SecureInputIos.mm:136-151`, `SecureInputField.kt:115-311`); never into
  a runtime-drawn field.
- **Secret buffers:** every secret field of a kernel request must own its
  memory — a request whose secret shares bytes with another field is
  refused, because the kernel wipes secrets in place.
- **Persisted data:** an image this build cannot read is surfaced as
  `unsupported` and left untouched — never silently wiped; `vault.reset`
  is an explicit user call. Starting at the first production release (1.0),
  no upgrade discards persisted user data (vault, backup envelope, engine
  store): every format change ships a one-step, tested forward upgrade
  from the previous released format.
