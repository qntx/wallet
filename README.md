<!-- markdownlint-disable MD033 MD041 -->

# wallet

Self-custodial wallet SDK for TypeScript: an isolated secret enclave (Web Worker, React Native kernel runtime) with HD derivation, a unified vault, Nostr, Spark and multi-chain signing (EVM, Solana, Bitcoin, TRON), hardware signers (Keystone 3 Pro over QR, Ledger and OneKey over USB or Bluetooth — see the [`@qntx/wallet` README](packages/wallet/README.md) for which models and firmware are verified), and qntx card wallets whose seed never leaves the cards. Card wallets are not usable in 0.14.1: no production card certificate anchor is pinned yet, so every card is refused as `card-not-genuine`.

Changes are tracked in [CHANGELOG.md](CHANGELOG.md); the upgrade guide from 0.13.0 lives in [MIGRATION.md](MIGRATION.md); contributor invariants and the local gate live in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT License ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project shall be dual-licensed as above, without any additional terms or conditions.

---

<div align="center">

A **[QuantX](https://qntx.org)** open-source project.

<a href="https://qntx.org"><img alt="QuantX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx.svg" /></a>

Code is law. We write both.

</div>
