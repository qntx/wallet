# @qntx/wallet-engine

App-side controllers over a [`@qntx/wallet`](https://www.npmjs.com/package/@qntx/wallet) `Wallet`:
the account tree, Spark payments, zaps, encrypted metadata sync and cloud backup. Controllers
expose Zustand stores; every I/O dependency (`fetch`, randomness, clock, storage, relays, cloud)
is injected. The engine never holds signing keys — every wallet-owned outflow goes through the
enclave's per-operation approval.

Peer dependencies: the exact `@qntx/wallet` release, `@qntx/spark` `^0.5.0` and
`@qntx/nostr` `^0.15.0`.

```bash
npm install @qntx/wallet-engine @qntx/wallet @qntx/wallet-worker @qntx/spark @qntx/nostr
```

```ts
import { createWalletEngine } from "@qntx/wallet-engine";
import { openIndexedDbEngineStore } from "@qntx/wallet-engine/idb";

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const engine = createWalletEngine({
  wallet, // from createWebWallet / createNodeWallet / createNativeWallet
  sparkNetwork: "mainnet",
  fetch: globalThis.fetch.bind(globalThis),
  random,
  now: () => Date.now(),
  logger: { warn: (message, error) => console.warn(message, error) },
  openStore: async () =>
    openIndexedDbEngineStore({
      name: "app-engine",
      dataKey: await wallet.dataKeys.get("wallet-db"),
      random,
    }),
});
```

The engine follows the wallet's lock state: unlocking opens the encrypted `EngineStore` and starts
the selected account group; locking flushes pending writes, closes every Spark client and clears
in-memory state.

## Surface

- `engine.accounts` — `AccountTreeController`: wallets and account groups, selection, names,
  hidden groups, Spark group discovery and social identity bindings.
- `engine.spark` — `SparkController`: balances, history, sends, Lightning receives and
  cooperative exits for the selected group.
- `engine.payments` — `parse` (pure, never throws), `resolve` (LNURL lookups) and `pay`, which
  routes a parsed option to Spark, Lightning or a Bitcoin withdrawal after validation and before
  approval. Typed `PayResult` per payment kind.
- `engine.zaps` — `prepare` signs the NIP-57 request with any `NostrSigner` and fetches the
  invoice; `pay` pays it from the built-in Spark wallet. External wallets may pay
  `prepared.invoice` themselves and validate the receipt against `receiptPubkey`.
- `engine.metaSync` — NIP-78 (kind 30078) metadata documents, NIP-44 encrypted to the wallet's
  group-0 Nostr identity; pull before publish, per-entry last-writer-wins.
- `engine.backup` — `BackupController` over an injected `CloudStore`.

## License

MIT OR Apache-2.0
