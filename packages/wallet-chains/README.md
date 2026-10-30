# @qntx/wallet-chains

Chain semantics for the qntx wallet: wire-safe `SignRequest` types, request
normalization, display decoding (verifiability, outflows, fee caps) and signing
for three families, plus public-key account derivation.

## Entries

| Subpath          | Contents                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`              | `SignRequest`, `AccountRef`, `EvmTransaction`, `DisplayIntent`, `Verifiability`, `ChainError`                                                                     |
| `./evm`          | `normalizeEvm`, `decodeEvm`/`verifiabilityEvm`, `isEvmAddress`/`checksumEvmAddress`, `evmAddressFromPublicKey`, `recoverEvmSigner`, token table                   |
| `./evm/sign`     | `signEvmTransaction` (legacy/2930/1559), `signEvmPersonalMessage` (EIP-191), `signEvmTypedData` (EIP-712)                                                         |
| `./solana`       | `normalizeSolana`, `decodeSolana`/`verifiabilitySolana`, `isSolanaAddress`, `solanaAddressFromPublicKey`, `verifySolanaSignature`, `SOLANA_NETWORKS`, token table |
| `./solana/sign`  | `signSolanaMessage` (ed25519, 64-byte signature)                                                                                                                  |
| `./bitcoin`      | `normalizeBitcoin`, `decodeBitcoin`/`verifiabilityBitcoin`, `bitcoinAddressFromXpub`, `BITCOIN_NETWORKS`                                                          |
| `./bitcoin/sign` | `signBitcoinPsbt` (P2WPKH/P2SH-P2WPKH/P2PKH/P2TR key path), `signBitcoinMessage` (BIP-322 simple, legacy)                                                         |

`/sign` subpaths are for the signer kernel only — the host runtime uses the
plain entries. No network, storage or entropy inside; every crypto primitive
comes from noble/scure or `@solana/*` codecs.

License: MIT OR Apache-2.0.
