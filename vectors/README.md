# Vectors

Fixed test vectors for the kernel. **All data here is test-only — never use
it for funds.**

| File             | Contents                                                                                           | Provenance                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bip39.json`     | Official BIP-39 english vectors (entropy, mnemonic, seed; passphrase `TREZOR`)                     | `curl -fsSL https://raw.githubusercontent.com/trezor/python-mnemonic/master/vectors.json`, `english` key kept verbatim                |
| `nip06.json`     | The two NIP-06 spec vectors: mnemonic → `m/44'/1237'/0'/0/0` private/public key (+ nsec/npub)      | Copied verbatim from https://github.com/nostr-protocol/nips/blob/master/06.md                                                          |
| `wallet-id.json` | BIP-32 test-vector-1 master public key → `walletId`                                                | Computed without project code: `{ printf 'qntx-wallet/wallet-id/v1'; printf '0339a36013301597daef41fbe593a02cc513d0b55527ec2df1050e2e8ff49c85c2' \| xxd -r -p; } \| shasum -a 256 \| cut -c1-16` |
| `factors.json`   | Password KEK (`PBKDF2-HMAC-SHA256` of the NFKC password, salt, 600000, 32) and passkey KEK (HKDF)  | Computed with `python3 hashlib.pbkdf2_hmac` and a hand-rolled HMAC HKDF; see below                                                    |
| `envelope.json`  | Fixed key/nonce/context/header → sealed envelope (record and factor contexts)                      | `bun scripts/vectors/envelope.ts` — spells the format out byte by byte, no kernel imports                                              |
| `passkey.json`   | PRF `00..1f` → entropy → mnemonic → seed → NIP-06 group 0 key → `walletId`                         | `bun scripts/vectors/passkey.ts` — uses the libraries directly, no kernel imports                                                      |
| `factor-wrap.json` | KEK → factor public key; fixed DEK/eph/nonce → factor wrap v2 `sealed` (`0x02 ‖ ephPk ‖ binding ‖ envelope`) | `bun scripts/vectors/factor-wrap.ts` — uses noble directly, no kernel imports |
| `records.json`     | Exact public-header texts (entropy, data-key, nostr derived + sync key, both factors, `hl-agent`) and the vault meta object | `bun scripts/vectors/records.ts` — `JSON.stringify` in the documented key order, no kernel imports |
| `protocol.json`    | PROTOCOL_VERSION 3 request envelopes, ok/err responses and events (`{"$bytes": hex}` marks Uint8Array), plus near-miss rejects | `bun scripts/vectors/protocol.ts` — wire shapes spelled out literally, no `@qntx/wallet` imports |
| `native-vault-image.json` | File RecordStore vault images: empty, initialized, records/factors, malformed rejects | `bun scripts/vectors/native-vault-image.ts` — raw cborg, no kernel imports |
| `vault-manifest.json` | Two fixed vault images — one plain, one carrying an `hl-agent` row — the structure digests their manifests commit to (format, keyId, every other record and factor row) and the manifest records sealed under a fixed DEK/nonce | `bun scripts/vectors/vault-manifest.ts` — noble only, no kernel imports |
| `native-frames.json`  | Kernel-channel CBOR frames: accepted values and rejected encodings | `bun scripts/vectors/native-frames.ts` — raw cborg, no package imports |
| `sync-key.json`      | The test mnemonic's metadata sync key: `m/44'/1237'/2147483647'/0/0` private + x-only public key | `bun scripts/vectors/sync-key.ts` — `@scure/bip32` + noble schnorr, no kernel imports |
| `spark-accounts.json` | Spark identity public keys for account groups 0/1 on mainnet/regtest under the public test mnemonic | `bun scripts/spark-accounts-vector.ts` from `packages/wallet-worker` — real `createSparkSigner` on the shipped spark.wasm |
| `chains/evm-zerox.json` | Five real 0x AllowanceHolder `exec` mainnet transactions (block ~26370k) with their expected `DisplayIntent` — ERC-20 and native sells through the taker Settler, a bridge-Settler exec that is not a swap, and a third-party operator | `eth_getTransactionByHash` on chain 1, 2026-11-08 |
| `backup.json`      | Cloud-backup envelopes: fixed inputs and RNG draws → backup key id, factor entries and two update envelopes that must match byte for byte | `bun scripts/vectors/backup.ts` — fixed byte constants, no kernel imports |
| `key-id.json`      | Imported-key ids: `hex(SHA-256("qntx-wallet/key-id/v1" ‖ familyByte ‖ publicKey)[0..8))` per family | `bun scripts/vectors/key-id.ts` — hashes the spelled-out preimage, no kernel imports |
| `chains/evm.json`  | Anvil mnemonic addresses and key, plus expected EIP-1559/legacy/7702 transactions, `personal_sign` and EIP-712 signatures | Addresses from anvil's default mnemonic; signatures cross-checked byte for byte against viem 2.57.8 and eth-sig-util V4 (#34, #138) |
| `chains/bitcoin.json` | BIP-44/49/84/86 addresses, BIP-322 hashes and signatures, a legacy signed message, the network genesis ids | Verbatim from the URLs in the file's `sources` field (BIPs 84/86/322, Electrum `test_signmessage_legacy_address`, Bitcoin Core chainparams) |
| `templates/chains.json` | Account keys and first addresses per chain template for the public test mnemonic | Sources listed in the file's `sources` field (BIP-84/86 texts, published MetaMask/ethers and Phantom/Solflare values); testnet tpub entries are regression values |
| `chains/solana.json` (others) | SLIP-10 keys, mnemonic addresses, Metaplex Core and stake-program messages with their expected intents | SLIP-10 spec vectors; stake and Core messages compiled with `@solana/kit` and recorded with their intents (#35, #143) |
| `chains/evm-across.json` | Two real Across SpokePool mainnet transactions (block ~26375k) with their expected `DisplayIntent` — a bytes32 `deposit` (USDC → Base) and a `depositV3` (native ETH → Arbitrum, SDK data suffix) | `eth_getTransactionByHash` on chain 1, 2026-11-08 |
| `chains/evm-lido.json` | Five real Lido mainnet transactions (block ~26372k) with their expected `DisplayIntent` — two `submit` stakes, `requestWithdrawalsWithPermit`, `requestWithdrawalsWstETHWithPermit` and `claimWithdrawals` — plus three ABI-built request variants (foreign owner, chunked amounts) | `eth_getTransactionByHash` on chain 1, 2026-11-08 |
| `chains/solana.json` (jupiter) | One real Jupiter Swap API V2 `/build` SOL→USDC exact-in v0 message (Metis, block ~44505k): compute-budget, wSOL ATA create + wrap transfer + SyncNative, `route_v2`, wSOL CloseAccount, one lookup table — with expected `DisplayIntent` | `/build` response, 2026-11-08 |
| `chains/solana-wire.json` | Serialized dApp transactions (Wallet Standard unit) — legacy/v0 single-signer, cosigner pre-signed, and sponsored — with each compiled message and the kit partially-signed result | `bun packages/wallet-chains/scripts/solana-wire-vectors.ts` — `@solana/kit` 8.5.0 |
| `chains/tron.json` | TRON derivation (m/44'/195' vectors), Trust Wallet Core and TronLink key/address pairs, invalid addresses, twenty-two transaction vectors (transfer, TRC-10/TRC-20 calls, freeze/delegate/vote, permission update, unsupported and near-miss contracts — each with raw bytes, txid and tronweb signature) and six signed messages | `bun scripts/vectors/tron.ts` — tronweb 6.5.2 (TransactionBuilder offline, signMessageV2); Trust Wallet Core and TronLink test literals asserted in-script |
| `chains/tron-mainnet.json` | 140 real mainnet transactions (blocks 76035000..76050000, TronGrid) grouped by contract type — validates raw_data round-trip, txid = sha256(raw_data), and full field parity with node JSON | `bun scripts/vectors/tron-mainnet.ts` — `https://api.trongrid.io` /wallet/getblockbylimitnext + /wallet/gettransactionbyid |
| `chains/hyperliquid.json` | Hyperliquid user-signed typed data (`HyperliquidSignTransaction` domain: transfers, withdrawals, spot sends, class transfers, staking, delegation, `ApproveAgent`, `ApproveBuilderFee`) and L1 phantom-agent `Agent` signatures (`userSigned` 20 cases, `l1` 48 incl. excluded python dummy layouts): each with the typed-data document, keccak `connectionId`, digest, fixed key and signature | `bun scripts/vectors/hyperliquid.ts` — documents, `connectionId`s and signatures from `@nktkas/hyperliquid` 0.33.3, digests from `@metamask/eth-sig-util`; asserts the published nktkas (`tests/signing/mod.test.ts`) and python-SDK (`tests/signing_test.py`) values |
| `chains/polymarket.json` | Polymarket typed data: CTF/Neg Risk/Exchange V3 orders, proxy and Safe funding, ERC-7739 deposit-wallet `TypedDataSign`, `ClobAuth`, and `Batch` calls — 14 cases, each with document, digest, signature, expected content and the on-chain `hashOrder` result (`onchain: "unavailable"` where no `hashOrder` exists) | `bun scripts/vectors/polymarket.ts` — `@polymarket/clob-client-v2` `OrderBuilder` with a capturing viem `WalletClient` (stubbed `Math.random`/`Date.now` for determinism), digest cross-checked viem ↔ eth-sig-util, `hashOrder` queried at Polygon/Amoy public RPCs (blocks recorded per case) |
| `chains/signing-classes.json` | EVM, Solana and TRON sign requests across the signing classes — everyday dApp calls (WETH deposit, Aave V3 supply/withdraw, Universal Router execute, USDC transfer), the claimed order protocols (CoW GPv2 Order, 1inch LOP v4 Order, a UniswapX V3DutchOrder Permit2 witness, a Snapshot Vote, a 0x claim near miss), Mail EIP-712 documents at and over the display budget, personal_sign byte/text messages and message hazards (a UTF-8 digest, hidden characters, a hex-rendered text), synthetic Solana legacy messages (SPL Transfer/Burn, Stake Split, an unknown program taking the signer with a listed authority set, program-authority blind over the writable-account bound), plus the blind reasons (token-function, account-code, message-bytes, typed-data-commitment, typed-data-variant for EIP-3009 and 0x near misses, typed-data-oversize for a Seaport order over the item limit), plus every TRON transaction vector (transfer, TRC-10/20 calls, freeze/delegate/vote, permission update), three tron messages, and the Hyperliquid and Polymarket documents from `chains/hyperliquid.json` and `chains/polymarket.json` (text, bytes, sign-in-shaped) — each with the expected verifiability, blind reason and exact en/zh-Hans prompt | `bun packages/wallet-chains/scripts/signing-classes-vectors.ts` — built with viem, `@solana/kit` and vectors/chains/tron.json; expected class and prompt text written by hand |
| `chains/order-protocols.json` | On-chain probes of every order-protocol contract the decoders or claim table name (1inch v6/v5 routers, CoW GPv2 settlement, UniswapX reactors, and every claim `contracts` entry): per record — chain, address, code present, the eip712Domain() values where exposed, the on-chain EIP-712 domain separator where exposed, and `permit2()` for reactors | `bun scripts/vectors/order-protocols.ts` — public RPCs (`eth_getCode`, eth_call of `eip712Domain()`/`PERMIT2()`/`DOMAIN_SEPARATOR()`), sequential throttled requests; oracle is the deployed contracts themselves |
| `chains/solana-mainnet.json` | 36 real mainnet transactions labelled by primary program (Raydium AMM/CLMM/CPMM, Orca Whirlpool, Meteora DAMM/DLMM, Pump.fun, PumpSwap, Kamino, marginfi, Marinade, JitoSOL stake pool, Magic Eden, Tensor, Phoenix, Jupiter v6, Jupiter LO, OpenBook): signature, slot, signer, base64 message and the reconstructed lookup-table accounts | `bun scripts/vectors/solana-mainnet.ts` — `https://api.mainnet-beta.solana.com` `getTransaction` (base64, maxSupportedTransactionVersion 0); ALT entries reconstructed from the fetched account addresses and verified equal to `meta.loadedAddresses` |
| `chains/evm-networks.json` | Sixteen EVM sign requests on the new built-in networks — Monad native MON and USDC transfers, Unichain and ZKsync Era native ETH transfers, Ronin, Scroll and Taiko native transfers, a Robinhood Chain Testnet native transfer (the longest new network name), an opBNB native BNB transfer as a legacy (type-0) transaction, an Ink USDC transfer, a Celo CELO-alias transfer and an Arc USDC-alias approve (native aliases describe like listed tokens), and four wrapped-native wraps/unwraps (Monad WMON deposit, Sei WSEI withdraw, Scroll WETH deposit, Ethereum WETH withdraw) — each with the expected verifiability, blind reason and exact en/zh-Hans prompt | `bun packages/wallet-chains/scripts/evm-networks-vectors.ts` — built with viem; expected prompt text written by hand |

## factor vectors

Password KEK (`vectors/factors.json` → `password[]`):

```bash
python3 - <<'EOF'
import hashlib, unicodedata
kek = hashlib.pbkdf2_hmac(
    "sha256",
    unicodedata.normalize("NFKC", "correct horse battery").encode("utf-8"),
    bytes.fromhex("00112233445566778899aabbccddeeff"),
    600000, 32,
)
print(kek.hex())
EOF
```

The second case contains U+FB01 ("ﬁ") so its NFKC form differs from the input.

Passkey KEK (`HKDF-SHA256(ikm = prf, salt = credentialId, info = "qntx-wallet/kek/passkey/v1", 32)`):

```bash
python3 - <<'EOF'
import hashlib, hmac
prf = bytes(range(32)); cred = bytes.fromhex("deadbeefcafe")
info = b"qntx-wallet/kek/passkey/v1"
prk = hmac.new(cred, prf, hashlib.sha256).digest()
print(hmac.new(prk, info + b"\x01", hashlib.sha256).hexdigest())
EOF
```
