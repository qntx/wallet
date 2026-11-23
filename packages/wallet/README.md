# @qntx/wallet

Public API surface of the qntx wallet: the `Wallet` interface, the immutable `WalletSnapshot`,
`WalletError`, the core API groups (vault, wallets, dataKeys), the host/kernel wire protocol, and
the `@qntx/wallet/nostr` subpath — the first protocol module (`./spark`, `./chains`,
`./sessions`, `./hardware` and `./card` are the other module subpaths). This package contains no runtime of
its own — a `Wallet` comes from a host package that spawns the kernel, currently
[`@qntx/wallet-worker`](https://www.npmjs.com/package/@qntx/wallet-worker) for Web and Node and
[`@qntx/wallet-native`](https://www.npmjs.com/package/@qntx/wallet-native) for React Native.

```bash
npm install @qntx/wallet @qntx/wallet-worker
```

## Usage

```ts
import { createWebWallet } from "@qntx/wallet-worker/browser";

const wallet = await createWebWallet({
  passkey: {
    rpId: "wallet.example.com", // a wallet-only domain — see the notes on its trust boundary
    rpName: "Example",
    walletSalt: "example/wallet",
    vaultSalt: "example/vault",
    backupSalt: "example/backup",
  },
  autoLock: { platform: "web", idleMinutes: 15 },
  // Verifies every event the kernel signs; pass your app's native verifier where one exists.
  verifyEvent,
});

// First run: create the wallet and register its passkey.
const created = await wallet.wallets.createWithPasskey({ name: "Example Wallet" });

// Later runs: unlock with the passkey (or a password factor).
await wallet.vault.unlock({ kind: "passkey" });

// The Nostr module lives in its own subpath — the root entry never pulls @qntx/nostr.
import { nostr } from "@qntx/wallet/nostr";

const key = await nostr(wallet).deriveKey(created.walletId, 0);
// A proxy NostrSigner — resolves the kernel key per call and survives lock/unlock.
const signer = nostr(wallet).signer(key.ref);
const event = await signer.signEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  pubkey: key.publicKey,
  tags: [],
  content: "gm",
});
```

`@qntx/wallet/sessions` manages the kernel-held session keys: `sessions(wallet).create` derives a
secp256k1 key inside the enclave for one HD account under a named scheme and returns its address,
`list`/`delete` manage the set, and `sign` produces the key's signature over the document its
scheme defines — for `hyperliquid-l1-agent`, the phantom-agent signature over an allow-listed L1
action. A Hyperliquid agent only becomes valid once the owner approves it on Hyperliquid — the
kernel binds that signature's `agentName` to the recorded validity window — and the private key
never leaves the enclave. For `hyperliquid-l1-agent` every signature must carry an `expiresAfter`
at most 60 s after it is made and a nonce within ±60 s, both measured on the device clock, and a
`scheduleCancel` time cannot outlive the session's `validUntil`. The kernel has no trusted time: a
device clock running S ahead of real time stretches the 60 s to S + 60 s of real time. The engine
refuses to sign when the device is more than 5 s off Hyperliquid's server time, but that check runs
in the main runtime.

`@qntx/wallet/hardware` drives external signers — currently the Keystone 3 Pro over QR — that keep
their seed entirely off the device running the wallet. `hardware(wallet)` exposes `pair`,
`accounts`, `sign` and `verifyAddress`; each takes a host `DeviceIo` that transports the kernel's
requests (for a Keystone: animate `qrParts(request.show)`, fold scanned frames through
`qrReader(request.scan)`). The kernel validates every frame, checks every returned signature, and
a `sign` re-runs the same verification as `chains().sign`; the host only moves bytes and shows
prompts. `@qntx/ur` is an optional peer required only by this subpath.

`@qntx/wallet/card` drives qntx card wallets (React Native only; Web and Node answer
`unsupported`). A card wallet's seed lives only on its one to three cards — `WalletInfo.custody`
is `"card"` — so `chains(wallet).sign` answers `device-required` and the host runs the request as a
card task instead:

```ts
import { card } from "@qntx/wallet/card";

const task = card(wallet).start({ kind: "sign", request }, { verify: { kind: "hardware" } });
task.observe((step) => {
  // "input": mount SecureInput from @qntx/wallet-native/secure-input
  // "tap": show the hold-the-card instruction; "done": the result is ready
});
const outcome = await task.result; // { kind: "sign", result: ChainSignResult }
```

The host only starts, observes and cancels: the kernel reads the access code from the secure
field, exchanges the APDUs with the native NFC reader and sets the NFC sheet's text from the
request it decoded. `create`, `add`, `accounts`, `health`, `change-access`, `erase`, `transfer`
and `reseal` run the same way.

### React

`getSnapshot` and `subscribe` are bound properties, safe to pass unbound:

```tsx
import { useSyncExternalStore } from "react";

const snapshot = useSyncExternalStore(wallet.subscribe, wallet.getSnapshot);
// snapshot.vault: "uninitialized" | "locked" | "unlocked" | "corrupted" | "unsupported" | "unavailable"
// snapshot.lockReason: "cold-start" | "user" | "idle" | "background" | "expired" | "crashed" | "invalidated"
```

What to do with each vault state:

- `corrupted` — stored ciphertext or a public header failed authentication. Confirm it is real
  (a reload that keeps reporting `corrupted`), then `wallet.vault.reset()` is the only way
  forward and destroys the vault. Never reset on a single sighting.
- `unsupported` — the vault was written by a newer build. Update the app; do not reset.
- `unavailable` — the vault store failed transiently. Retry; the kernel retries a load on the
  next request itself.

Resetting requires the live session while the vault is open and healthy; a locked or unhealthy
vault resets without one. On Web/Node reset is not an authentication boundary — same-origin code
can delete IndexedDB directly — so hosts must put their own confirmation UX in front of it. On
React Native the device owner proves presence before anything is erased.

## Security notes

- Seed, keys and the DEK exist only inside the kernel's Web Worker. The password and the
  passkey PRF output, however, necessarily pass through the host thread: WebAuthn runs only on
  the main thread, and for a passkey wallet the PRF output _is_ the wallet entropy.
- The Web host is a **hot wallet**. The Worker keeps secrets away from passive leaks (logs, error
  reports, third-party scripts reading globals) and from reads of in-session memory. It does not
  protect against an active attacker on the main thread: XSS or a malicious dependency can capture
  the next password or PRF output and decrypt the same-origin IndexedDB vault, which is equivalent
  to stealing the wallet. Ship a strict CSP, review dependencies, and steer large balances to the
  mobile or hardware wallet.
- Your CSP must allow the bundled worker: `worker-src 'self'` (the worker loads from your own
  origin — a stricter policy breaks the wallet).
  With Trusted Types enforced, also allow the kernel worker in a `default` policy; see the
  `@qntx/wallet-worker` README.
- Vite users: set `optimizeDeps.exclude: ["@qntx/wallet-worker"]` so the worker URL survives dev;
  production builds need nothing — `vite build` emits `kernel.worker.js` as an asset.
- `@qntx/wallet/host` is reserved for host packages — applications must not use it.
- `wallet.vault.lock()` resolves immediately and terminates the worker — it never waits on the
  kernel queue. A kernel request that stalls at the head of the queue surfaces `crashed` after
  60 s and the worker respawns; requests still queued behind it are not timed.
- Password unlock is rate-limited inside the kernel: five counted misses arm a backoff
  (30 s → 60 s → 300 s), a `rate-limited` error carries `retryAt`, and retrying during backoff
  does not push the deadline. Passkey unlocks are never gated by it.
- Sessions idle-lock after 5, 15 or 60 minutes (`autoLock.idleMinutes`, worker-enforced) with an
  absolute maximum of 12 hours on Web and Node and 24 hours on React Native, measured on a
  monotonic clock — a wall-clock jump can neither extend nor shorten a session. On the Web only
  user presence refreshes the idle timer (input events and tab visibility, throttled to one
  `session.touch` per 30 s); signing and other background traffic cannot hold a session open. On
  Node every successful request counts.
- `WalletInfo.backup` tells the UI whether the wallet survives losing this device: `"mnemonic"`
  (the user passed the quiz, imported a phrase, or exported it at least once — `exportMnemonic`
  upgrades the record), `"passkey"` (a synced passkey — still lost with the password-manager
  account, so prompt to export), or `"none"` (a device-bound passkey — lost with the device).
- Blind signing is a vault setting, off by default. A request is blind only when the chain
  decoder marks it so: a raw-byte or digest-shaped message (exactly 32 bytes, hidden or
  deceptive characters, or text that encodes raw bytes), typed data too large or misformed
  to show or carrying a hash or raw-bytes leaf the signature does not name, typed data a
  recognised family claims in an unknown shape or a Seaport order over the item limit, a call
  into an unrecognised function of a listed token, calldata that runs the signing account's own
  code, an undecoded instruction of a core Solana program the signer signs, an undecoded Solana
  program handed the signature whose reachable accounts cannot be listed, or a Safe
  delegatecall or unbounded refund. `chains(wallet).sign` fails a blind request with
  `blind-signing-disabled` — before any verification — until `vault.setBlindSigning(true, verify)`;
  `snapshot.blindSigning` reports the setting. Requests the wallet can describe but not verify —
  an unknown contract call, readable unrecognised typed data that fits the display budget,
  a decoded 1inch, UniswapX or CoW order, an unknown Solana program or a core instruction the
  signer does not sign, a multi-party PSBT — sign without the setting and their prompt carries
  a "cannot verify" line. Through the dApp surface the engine still creates the pending request
  and `requests.approve` throws `BlindSigningDisabledError` while the setting is off — enable it
  and approve the same request again. Which requests are blind follows the rules above;
  blind never means hidden — readable message text is shown, and 32-byte,
  hidden-character or byte-encoding text is blind but still shown.
- `verify` parameters take a `VerifyFactor` — `hardware`, `passkey` or `password`. The silent
  `device` factor proves no user presence: only `vault.unlock` accepts it (`UnlockFactor`). On
  React Native `vault.enrolVerification()` registers the verifying factor and `vault.setAppLock`
  makes every unlock verify — see the `@qntx/wallet-native` README.
- Changing the password or removing a factor rotates the vault DEK: sessions in other tabs lock
  with reason `invalidated` and must re-unlock. Adding a passkey factor keeps the current DEK.
- **The `rpId` scope is the wallet's trust boundary.** WebAuthn binds a credential and its PRF
  to the RP id, not to an origin, and a passkey wallet's seed is the PRF over `walletSalt`. A
  script on any origin that may claim the RP id — each of its subdomains, each origin listed in
  `/.well-known/webauthn`, each app associated with it — can derive that seed from one passkey
  prompt that looks like a sign-in. Use a domain that serves only the wallet
  (`wallet.example.com`), never a registrable parent shared with other pages, user content or
  third-party scripts, and treat every related origin and associated app as part of the wallet.
- `passkey.rpId`, `walletSalt`, `vaultSalt` and `backupSalt` are permanent identifiers — changing
  any of them makes every existing passkey factor and passkey-derived wallet unrecoverable, and
  the salts must differ. Moving domains requires WebAuthn related origins
  (`/.well-known/webauthn`); offer `exportMnemonic` for passkey-derived wallets so they survive an
  RP migration. `connectKernel` rejects an empty or colliding config before the worker spawns.
- Every Nostr key the vault holds is derived from a wallet — a `NostrKeyRef` is always
  `{ kind: "derived", walletId, index }`, so keys come back with the wallet's own backup and
  `nostr(wallet).removeKey` drops one. `nostr.exportKey` re-verifies on every call, and the
  `ncryptsec` export always carries NIP-49 key-security byte `0x02` at scrypt logN 16.
- Cloud-backup envelopes leave the device, so the backup password is stretched with Argon2id
  (64 MiB, 3 passes, 4 lanes) and must be at least 12 characters. `backup.restore` adopts the
  file's backup key only when the restore establishes the vault through a kernel-run passkey
  ceremony (React Native); every other restore leaves backup off until it is enabled again.
- A card wallet's seed, access code, access-code hashes and card session keys exist only on the
  cards and in the kernel; no message to the host carries them. Each tap checks the card's
  certificate against a pinned anchor and its identity against the vault record before any
  access-code hash is sent, so an unknown or swapped card never learns anything.
- Requests are capped at 1 MiB on both sides of the channel; larger calls fail `invalid-input`
  without reaching the kernel.
- `dist/kernel.manifest.json` in `@qntx/wallet-worker` records the protocol version, vault
  format, pinned dependency versions/integrities and the SHA-256 of each kernel bundle.

## License

MIT OR Apache-2.0
