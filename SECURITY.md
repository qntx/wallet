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
