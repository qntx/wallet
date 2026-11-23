# Security Policy

This project handles private keys. Please do not report vulnerabilities in
public issues.

Report a vulnerability by emailing **<x@qntx.org>** with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- the affected versions and platforms.

We aim to acknowledge reports within 72 hours and will coordinate a fix and
disclosure timeline with you.

## Threat model

- **Passkey wallets:** the seed is the passkey's PRF output, and WebAuthn scopes a
  passkey to its RP id, not to one origin. Every origin and app entitled to the
  configured `rpId` is inside the trust boundary; hosts must use a wallet-only
  domain. A finding that needs script execution on such an origin is in the same
  class as script execution on the wallet's own page.
- **React Native:** secrets, the password and the passkey PRF output stay
  inside the isolated kernel runtime. The silent `device` factor opens the
  vault without user presence for everyday use; every fund-moving signature,
  export and guarded change still needs the presence-proving `hardware`
  factor on a kernel-rendered system prompt, and the optional app lock makes every unlock
  verify too.
- **Blind signing** is a kernel-enforced vault setting, off by default: a
  request the chain decoder can neither display nor bound fails
  `blind-signing-disabled` before any prompt, on every host.
- **Cloud backup** envelopes leave the device; the backup password is
  stretched with Argon2id, and the engine refuses a guessable one when
  backup is enabled.
- **Web:** the kernel Worker holds seed, keys and the DEK, but the password and
  PRF output pass through the page's main thread, because WebAuthn is
  main-thread only. The Web wallet is a hot wallet: it resists passive leaks,
  not an active attacker running script in the page (XSS, malicious
  dependencies). Reports that need such an attacker are in scope only where
  they defeat the Worker boundary itself.
- **Session keys** (`hyperliquid-l1-agent`): the kernel bounds every agent
  signature to an `expiresAfter` at most 60 s out and a nonce within ±60 s, both
  on the device clock — the kernel has no trusted time. A device clock running S
  ahead of real time stretches the post-lock exposure to S + 60 s (Hyperliquid
  accepts nonces up to a day ahead). The engine's `assertClock()` refuses to sign
  when the device is more than 5 s off Hyperliquid's server time, but it runs in
  the main runtime: a compromised main runtime can skip it, so the residual
  exposure is the device's own clock error plus 60 s.
- **Vault rollback** (the vault anchor): the vault manifest authenticates one image, and a
  21-byte record kept outside the vault store holds the revision floor and the password failure
  counters, so an older committed image put back reads `corrupted` and rewriting the store does
  not reset the password backoff. No platform gives an app a hardware monotonic counter (Android
  rollback resistance is platform-only, the Secure Enclave's anti-replay storage serves the
  system), so the floor is only as strong as the storage it sits in:
  - React Native keeps it in the platform credential store — an iOS keychain item
    (`WhenUnlockedThisDeviceOnly`), Android Keystore entry aliases — outside the app container,
    which is never backed up. It catches a writer of the app's files who cannot write that store
    (a file-level replacement, a replay of the vault file alone). It does not stop root or a
    jailbreak, code running as the app, or a consistent restore of the whole device.
  - The Web has no rollback-resistant storage. The anchor sits in Cache Storage, a different
    backend from the IndexedDB vault (Chromium keeps every IndexedDB database of an origin in one
    LevelDB), so restoring the vault database alone is caught; same-origin script, an extension
    with access to the origin, or a restore of the whole browser profile rewrites both. The online
    backoff never slows an attacker who can read storage: the password factor can be attacked
    offline at its PBKDF2 cost.
  - Node keeps the store and the anchor in the host process's memory; neither outlives it.
- **Secret buffers:** every secret field of a kernel request must own its memory; a request whose
  secret shares bytes with another field is refused, because the kernel wipes secrets in place.
- **Gateway privacy:** the gateway sees a fresh client id per session and per scope (one per chain
  family plus `service`), and each scope's requests name only that scope's data — price requests
  are sent per family under that family's id. Each scope's own requests still name its addresses;
  what links one scope to another is the network layer — the client IP and the timing of requests
  a refresh sends together. Hiding those needs an OHTTP-style relay in front of the gateway, which
  this release does not ship.
