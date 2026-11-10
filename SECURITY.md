# Security Policy

This project handles private keys. Please do not report vulnerabilities in
public issues.

Report a vulnerability by emailing **<x@qntx.org>** with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- the affected versions and platforms.

We aim to acknowledge reports within 72 hours and will coordinate a fix and
disclosure timeline with you.

## Threat model by platform

- **React Native:** secrets, the password and the passkey PRF output stay
  inside the isolated kernel runtime, and every fund-moving signature is
  confirmed on a kernel-rendered system prompt.
- **Web:** the kernel Worker holds seed, keys and the DEK, but the password and
  PRF output pass through the page's main thread, because WebAuthn is
  main-thread only. The Web wallet is a hot wallet: it resists passive leaks,
  not an active attacker running script in the page (XSS, malicious
  dependencies). Reports that need such an attacker are in scope only where
  they defeat the Worker boundary itself.
