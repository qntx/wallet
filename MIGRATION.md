# Migrating from 0.13.0

This guide covers every change a host of `@qntx/wallet`, `@qntx/wallet-engine`,
`@qntx/wallet-native` and `@qntx/wallet-worker` has to act on between the 0.13.0 release and the
next one (`main`). [CHANGELOG.md](CHANGELOG.md) lists every change; this file only lists what
needs host work, grouped by task.

Every snippet below is a file under [`tests/migration/`](tests/migration), compiled by
`bun run typecheck` against the current sources. A line marked `@ts-expect-error` is the 0.13.0
form: it must fail to compile, so the guide breaks if an old API comes back or a new one moves.

Upgrade all `@qntx/wallet*` packages together: the host packages pin the exact `@qntx/wallet`
release their kernel was built for.

## What users lose on upgrade

The upgrade is not data-preserving. Plan the release around this table and tell users before they
update: a user who cannot produce their mnemonic, their passkey or a post-upgrade backup loses the
wallet.

| Data                                                                                                                                                  | 0.13.0 location                                                                               | After the upgrade                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mnemonic wallets (and their BIP-39 passphrase)                                                                                                        | vault, format 3                                                                               | The vault is `unsupported` and must be reset. Comes back only through `wallets.importMnemonic` with the phrase (and passphrase).                                                                        |
| Passkey-derived wallets                                                                                                                               | vault                                                                                         | `wallets.restoreWithPasskey()` derives them again from the same passkey, as long as `rpId` and `walletSalt` are unchanged.                                                                              |
| Imported private keys                                                                                                                                 | vault                                                                                         | Lost. Only a key the user exported before upgrading can be imported again.                                                                                                                              |
| Nostr identities                                                                                                                                      | vault (derived per wallet)                                                                    | Derived from the wallet, so they come back with it; `nostr(wallet).discover` lists the public key of each identity index.                                                                               |
| Vault factors (password, passkey factor, hardware key)                                                                                                | vault                                                                                         | Recreated when the new vault is created or restored.                                                                                                                                                    |
| Cloud backup                                                                                                                                          | `qntx-wallet-backup-<id>.json`, envelope v1 (PBKDF2)                                          | Unreadable: `engine.backup.list()` skips these files and `restore` refuses them. Backup is off until the user enables it again, which writes a new file.                                                |
| Engine data: address book, account-group names, custom tokens, custom RPC endpoints, watch accounts, dApp connections, sign log, tracked transactions | engine IndexedDB / engine store, keyed by the vault's data key                                | Rebuilt empty (the format changed and the new vault has a new data key). Address-book entries and wallet/group names come back through `metaSync` when the host configures it; everything else is gone. |
| Transactions in flight at upgrade time                                                                                                                | tracked transactions                                                                          | They still land on chain and appear in `engine.history`, but they can no longer be sped up, cancelled or bumped with CPFP.                                                                              |
| Spark                                                                                                                                                 | balance held by the Spark operators; exit-chain records and payment notes in the engine store | The balance comes back with the wallet; the locally stored exit-chain records and payment notes do not.                                                                                                 |
| Blind-signing permission, app lock                                                                                                                    | engine account groups / —                                                                     | Off on the new vault.                                                                                                                                                                                   |

## 1. Vault format and data reset

The vault format is 5 and the host/kernel protocol version 3. Vaults of any other format are
reported as `vault: "unsupported"` and never opened; there is no migration. On the first launch
after the upgrade, `unsupported` means the 0.13.0 vault: confirm with the user, reset, then
restore. (Later, `unsupported` keeps its meaning — a newer build wrote the vault — and must not be
reset.)

`vault.reset()` of an open, healthy vault now needs that vault's live session; a locked or
unhealthy one resets without a session. On React Native the reset still asks for the device
owner's verification, and fails `verification-unavailable` without a lock screen.

[`tests/migration/vault-reset.ts`](tests/migration/vault-reset.ts):

```ts
import type { Wallet } from "@qntx/wallet";

/**
 * A 0.13.0 vault is format 3, which this release reports as `unsupported` and never opens. The only
 * way forward is a reset followed by a restore from the user's mnemonic, passkey or a backup made
 * after the upgrade — confirm with the user first, because the reset erases every wallet and key.
 */
export async function replaceUnsupportedVault(
  wallet: Wallet,
  confirmErase: () => Promise<boolean>,
): Promise<"reset" | "kept"> {
  if (wallet.getSnapshot().vault !== "unsupported" || !(await confirmErase())) {
    return "kept";
  }
  await wallet.vault.reset();
  return "reset";
}

/** After the reset: a mnemonic wallet comes back from its phrase, a passkey wallet from its passkey. */
export async function restoreAfterReset(
  wallet: Wallet,
  source: { readonly kind: "mnemonic"; readonly mnemonic: string } | { readonly kind: "passkey" },
): Promise<string> {
  const info =
    source.kind === "mnemonic"
      ? await wallet.wallets.importMnemonic({ mnemonic: source.mnemonic })
      : await wallet.wallets.restoreWithPasskey();
  return info.walletId;
}
```

## 2. Gateway and engine options

- `EngineOptions.gateway` is `{ url }`. The engine sends a random `x-client-id` per session and
  per scope instead of `x-install-id`, and a gateway from this release refuses requests without it
  (`400 invalid-request`) — just as a 0.13.0 gateway refuses the new engine. Deploy the gateway
  from this release and the app together, or keep serving old app versions from the old gateway.
- The prices (`POST /v1/prices`) and history (`POST /v1/history/:caip2`) features need that
  gateway; production needs the `COINGECKO_API_KEY` secret.
- `engine.bridges.quote` requires `maxFeeBps`, the highest relay fee accepted, in basis points of
  the input amount.
- `engine.transactions` has no `prepare*` methods: every send goes through
  `engine.requests.prepare` / `approve`.
- Every `WalletEngine` member is a host facade: only the listed host methods plus a read-only
  `store` (`getState`, `getInitialState`, `subscribe`). Controller lifecycle and wiring (`init`,
  `lock`, `destroy`, `setStore`, `setAccounts`, `lockAll`, `reconcile`, `trigger`,
  `invalidateAll`), `store.setState`, metadata merges and the provider handlers' `options` are
  gone from the engine. A component typed with a controller class (`SparkController`, …) takes
  `WalletEngine["spark"]` instead.
- Every type in the engine's host-facing signatures has a name in `@qntx/wallet-engine`:
  `AccountRef`, `TrackedTransaction`, `TxState`, `PrepareParams`, `ChainRequestInput`,
  `RequestResult`, the request inputs, displays and results, `SparkTokenBalance`, `HistoryGroup`,
  `WatchAccount` and the rest — import them instead of deriving them.
- `engine.connections.setActiveGroup` is gone: dApp sessions follow `engine.accounts.select`, and
  switching group invalidates every pending request.
- `ProviderInfo.uuid` is gone: the injected script generates the EIP-6963 uuid per document.
- `injectedScript` installs the provider in the top-level document only, and
  `BrowserBridge.message(topUrl, data)` must receive the URL of the frame that sent the message.
  react-native-webview reports it from 13.13.5 (iOS `frameInfo`, Android `WebMessageListener`
  source origin); its `addJavascriptInterface` fallback reaches every frame and is not safe.

[`tests/migration/removed.ts`](tests/migration/removed.ts):

```ts
import type { AccountRef, EngineOptions, WalletEngine } from "@qntx/wallet-engine";
import type { ProviderInfo } from "@qntx/wallet-engine/connect";
import { injectedScript } from "@qntx/wallet-engine/connect";

/** The engine draws its own per-session, per-scope client ids; there is no install id. */
export const gatewayBefore: EngineOptions["gateway"] = {
  url: "https://gateway.example.com",
  // @ts-expect-error -- installId is removed
  installId: "00000000000000000000000000000000",
};
export const gateway: EngineOptions["gateway"] = { url: "https://gateway.example.com" };

/** The injected script generates the EIP-6963 uuid per document. */
export function providerScript(icon: string): string {
  const info: ProviderInfo = { name: "Example", icon, rdns: "com.example" };
  // @ts-expect-error -- ProviderInfo.uuid is removed
  injectedScript({ ...info, uuid: "6f1c3c8e-2b6f-4b8e-9a43-2f1d8a7c5e10" });
  return injectedScript(info);
}

/** Sends go through the request pipeline; `transactions.prepare*` is gone from the engine. */
export async function prepareSendBefore(
  engine: WalletEngine,
  account: AccountRef,
  to: string,
): Promise<string> {
  const params = { account, network: "eip155:1", to, amount: 1n, fee: "normal" } as const;
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 method
  // @ts-expect-error -- prepareSend is not on engine.transactions
  await engine.transactions.prepareSend(params, "request-id");
  // oxlint-enable typescript/no-unsafe-call
  const pending = await engine.requests.prepare({ method: "send", ...params });
  return pending.id;
}

/**
 * Engine members are host facades: controller lifecycle, internal wiring and `store.setState` stay
 * with the engine. Read with `getState`, subscribe with `store.subscribe`.
 */
export function controllerInternalsBefore(engine: WalletEngine): void {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 surface
  // @ts-expect-error -- SparkController.setAccounts is engine wiring
  engine.spark.setAccounts([]);
  // @ts-expect-error -- controller stores are read-only for hosts
  engine.accounts.store.setState(engine.accounts.getState());
  // oxlint-enable typescript/no-unsafe-call
}

/** DApp sessions follow the app's group selection; there is no connection-level active group. */
export function selectGroup(engine: WalletEngine, walletId: string, groupIndex: number): void {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 method
  // @ts-expect-error -- ConnectionController.setActiveGroup is removed
  void engine.connections.setActiveGroup(walletId, groupIndex);
  // oxlint-enable typescript/no-unsafe-call
  engine.accounts.select(walletId, groupIndex);
}

/** Bridge quotes need a relay-fee ceiling in basis points of the input amount. */
export async function quoteBridge(
  engine: WalletEngine,
  account: AccountRef,
  inputToken: string,
  outputToken: string,
): Promise<boolean> {
  const quote = await engine.bridges.quote({
    account,
    network: "eip155:1",
    destinationNetwork: "eip155:8453",
    inputToken,
    outputToken,
    amount: 1_000_000n,
    maxFeeBps: 50,
  });
  return quote !== undefined;
}
```

## 3. React Native factors and app lock

- New React Native vaults get a silent `device` factor, plus the `hardware` factor when the device
  has a lock screen. Do not pass `factor` to `createWithPasskey`, `restoreWithPasskey`,
  `createMnemonic`, `importMnemonic` or `backup.restore` on React Native (`unsupported`);
  `InitialFactor` no longer has `hardware`. `vault.addFactor` / `vault.removeFactor` are
  `unsupported` on React Native.
- `vault.unlock()` without a factor unlocks silently with `device`, or with `hardware` when
  `snapshot.appLock` is on.
- Every `verify` parameter is `VerifyFactor` — `UnlockFactor` without `device`.
- `snapshot.verification === "unavailable"` means no factor can verify (no lock screen, or it was
  removed): guarded operations fail `verification-unavailable` (formerly `no-device-credential`)
  without a prompt. Once the user sets a lock screen, `vault.enrolVerification()` adds the
  `hardware` factor. Removing the lock screen no longer destroys the vault while the `device`
  factor exists.
- `vault.setAppLock(enabled, verify)` turns the app lock on (drops the `device` factor and rotates
  the DEK; other sessions lock with `invalidated`) or off.
- `createNativeWallet` returns a `NativeWallet`; `setAutoLock` changes the background lock of the
  live kernel without recreating the wallet.
- Only one native kernel may be live per process: `destroy()` the previous wallet before creating
  another, or creation fails `integrity`.

[`tests/migration/native-factors.ts`](tests/migration/native-factors.ts):

```ts
import type { UnlockFactor, VerifyFactor, Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import type { NativeWallet, NativeWalletOptions } from "@qntx/wallet-native";
import { createNativeWallet } from "@qntx/wallet-native";

/** React Native picks its own vault factors: no `factor` on create, import or restore. */
export async function createOnNative(wallet: Wallet): Promise<void> {
  // @ts-expect-error -- 0.13.0 created native vaults with an explicit hardware factor
  await wallet.wallets.createMnemonic({ words: 12, factor: { kind: "hardware" } });
  const draft = await wallet.wallets.createMnemonic({ words: 12 });
  await draft.discard();
}

/** Without a factor, unlock uses the silent device factor, or `hardware` when app lock is on. */
export async function unlockOnNative(wallet: Wallet): Promise<void> {
  await wallet.vault.unlock();
}

/** 0.13.0 typed every `verify` as `UnlockFactor`, which now includes the silent device factor. */
export async function exportBefore(
  wallet: Wallet,
  walletId: string,
  verify: UnlockFactor,
): Promise<void> {
  // @ts-expect-error -- guarded operations take a VerifyFactor
  await wallet.wallets.exportMnemonic(walletId, verify);
}

/** Guarded operations take a `VerifyFactor`; the silent device factor never verifies. */
export async function exportWithVerification(wallet: Wallet, walletId: string): Promise<void> {
  const verify: VerifyFactor = { kind: "hardware" };
  const exported = await wallet.wallets.exportMnemonic(walletId, verify);
  exported.mnemonic.wipe();
}

/** A vault created without a lock screen can still sign in; guarded calls wait for enrolment. */
export async function ensureVerification(wallet: Wallet): Promise<boolean> {
  if (wallet.getSnapshot().verification === "available") {
    return true;
  }
  try {
    await wallet.vault.enrolVerification();
    return true;
  } catch (error) {
    // Still no lock screen: tell the user to set one, then call enrolVerification again.
    if (error instanceof WalletError && error.code === "verification-unavailable") {
      return false;
    }
    throw error;
  }
}

/** The app-lock switch: `true` makes every unlock verify, `false` restores silent unlock. */
export async function setAppLock(wallet: Wallet, enabled: boolean): Promise<void> {
  await wallet.vault.setAppLock(enabled, { kind: "hardware" });
}

/** One live kernel per process: destroy the previous wallet before creating a new one. */
export async function recreateNativeWallet(
  previous: Wallet | undefined,
  options: NativeWalletOptions,
): Promise<NativeWallet> {
  await previous?.destroy();
  const wallet = await createNativeWallet(options);
  wallet.setAutoLock({ platform: "native", backgroundSeconds: 300 });
  return wallet;
}
```

## 4. Approve acknowledgements

`requests.approve(id, method, options)` takes `{ verify, acknowledged }`. A request with `danger`
risk findings or any recorded check is refused with `AcknowledgementRequiredError` unless
`acknowledged` names exactly those codes — show them, then pass back what you showed
(`requiredAcknowledgement(request)`). Findings a re-simulation adds at approval need a fresh
confirmation (`error.required`); `SimulationChangedError` means the simulation changed and the
request went back to `awaiting-approval`. Nothing is signed in either case and the request stays
approvable.

[`tests/migration/approve.ts`](tests/migration/approve.ts):

```ts
import type { VerifyFactor } from "@qntx/wallet";
import type { PendingRequest, RequestAcknowledgement, WalletEngine } from "@qntx/wallet-engine";
import {
  AcknowledgementRequiredError,
  SimulationChangedError,
  requiredAcknowledgement,
} from "@qntx/wallet-engine";

/** 0.13.0 passed the factor positionally; it now travels in the options object. */
export async function approveSendBefore(
  engine: WalletEngine,
  id: string,
  verify: VerifyFactor,
): Promise<void> {
  // @ts-expect-error -- `verify` is no longer the third positional argument
  await engine.requests.approve(id, "send", verify);
}

/**
 * The approval screen shows the request's `danger` findings and its checks; the host passes back
 * exactly the codes it showed. A finding that appears later (a re-simulation at approval) throws
 * `AcknowledgementRequiredError` with the new set, and the request stays approvable.
 */
export async function approveSend(
  engine: WalletEngine,
  request: PendingRequest,
  verify: VerifyFactor,
  confirm: (shown: RequestAcknowledgement) => Promise<boolean>,
): Promise<string | undefined> {
  let shown = requiredAcknowledgement(request);
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one confirmation per changed finding set
    if (!(await confirm(shown))) {
      engine.requests.reject(request.id);
      return undefined;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- retried only after a new confirmation
      const tx = await engine.requests.approve(request.id, "send", { verify, acknowledged: shown });
      return tx.id;
    } catch (error) {
      if (error instanceof AcknowledgementRequiredError) {
        shown = error.required;
        continue;
      }
      const current = engine.requests.getState().requests[request.id];
      if (error instanceof SimulationChangedError && current !== undefined) {
        shown = requiredAcknowledgement(current);
        continue;
      }
      throw error;
    }
  }
}
```

## 5. Blind signing

- Blind signing is a vault setting (`wallet.vault.setBlindSigning(enabled, verify)`,
  `snapshot.blindSigning`), enforced in the kernel and off on a new vault. The per-group engine flag
  (`engine.accounts.setBlindSigning`, `AccountGroup.blindSigning`) is removed.
- Fewer requests are blind. A request the wallet can describe but not verify — an unknown contract
  call, unrecognised typed data that fits the display, a Solana transaction with unknown programs,
  a multi-party PSBT — now signs without the setting, with a "cannot verify" line in the kernel
  prompt and the `decode-partial` check (so it needs an acknowledgement). A request is described
  only when what the prompt prints bounds what the signature authorises. Blind are: raw-byte
  messages, 32-byte messages and text that renders a hash or carries unsafe code points; typed
  data that signs only hashes or opaque bytes (ERC-1271 wrappers such as `SafeMessage`), that is
  too large or misformed to show, or that a decoded family (permits, Permit2, Safe, Seaport,
  built-in tokens) claims in a shape the wallet does not decode, such as EIP-3009 on a built-in
  token; a Seaport order with more than four offer or consideration items; an unrecognised
  function of a built-in token; an undecoded System, Token, Token-2022, Stake or Associated Token
  instruction the signer signs; calldata to the signing account itself; a Safe `delegatecall`
  outside MultiSendCallOnly; and a Safe transaction with a gas refund.
- dApp blind requests are no longer refused at `prepare` (providers no longer answer `4200`). They
  become pending requests with the `blind-signing` danger, and `approve` throws
  `BlindSigningDisabledError` while the setting is off. Offer to enable it there, then approve the
  same request again.
- `chains(wallet).sign` of a blind request fails with `WalletError` code `blind-signing-disabled`
  before any prompt while the setting is off.

[`tests/migration/blind-signing.ts`](tests/migration/blind-signing.ts):

```ts
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { AccountRef, PendingRequest, WalletEngine } from "@qntx/wallet-engine";
import { BlindSigningDisabledError, requiredAcknowledgement } from "@qntx/wallet-engine";
import { chains } from "@qntx/wallet/chains";

/** 0.13.0 kept the flag per account group in the engine; it is a vault setting now. */
export function enableBlindSigningBefore(engine: WalletEngine, walletId: string): void {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 method
  // @ts-expect-error -- AccountTreeController.setBlindSigning is removed
  engine.accounts.setBlindSigning(walletId, 0, true);
  // oxlint-enable typescript/no-unsafe-call
}

/** A dApp's blind request stays pending; enable the setting at approval, then approve it again. */
export async function approveBlind(
  wallet: Wallet,
  engine: WalletEngine,
  request: PendingRequest,
  verify: VerifyFactor,
  allowBlindSigning: () => Promise<boolean>,
): Promise<boolean> {
  const options = { verify, acknowledged: requiredAcknowledgement(request) };
  try {
    await engine.requests.approve(request.id, "evm-sign", options);
    return true;
  } catch (error) {
    if (!(error instanceof BlindSigningDisabledError) || !(await allowBlindSigning())) {
      throw error;
    }
  }
  await wallet.vault.setBlindSigning(true, verify);
  await engine.requests.approve(request.id, "evm-sign", options);
  return true;
}

/** Direct kernel signing of a blind request fails `blind-signing-disabled` before any prompt. */
export async function signRawMessage(
  wallet: Wallet,
  account: AccountRef,
  message: Uint8Array,
  verify: VerifyFactor,
): Promise<"signed" | "blind-signing-off"> {
  if (!wallet.getSnapshot().blindSigning) {
    return "blind-signing-off";
  }
  await chains(wallet).sign({
    request: { kind: "evm.personal-message", network: "eip155:1", account, message },
    verify,
  });
  return "signed";
}
```

## 6. Solana provider wire format

`solana-sign` requests carry serialized transactions (signature slots + message), exactly as the
Wallet Standard passes them, instead of compiled messages; `signedTransactions` are those
transactions with the wallet's signature in its own slot, so co-signers' signatures and dApp-paid
(sponsored) transactions survive. The wallet may be any required signer, not only the fee payer. A
sign-and-send that still needs other signers is refused before the prompt, and transaction
versions other than legacy and v0 are refused. The engine's own Wallet Standard handler already
does this; a host that feeds `requests.prepare` itself must pass the dApp's bytes unchanged.

[`tests/migration/solana-provider.ts`](tests/migration/solana-provider.ts):

```ts
import { decodeSolanaTransaction } from "@qntx/wallet-chains/solana";
import type { WalletEngine } from "@qntx/wallet-engine";

/**
 * `solana-sign` requests carry serialized transactions exactly as the Wallet Standard passes them
 * (signature slots + message), no longer compiled messages. A host that bridges its own Solana
 * provider passes the dApp's bytes through untouched; `signedTransactions` come back as the same
 * transactions with the wallet's signature in its slot, so co-signers' signatures survive.
 */
/** Co-signers that still have to sign — a sign-and-send with any of them is refused. */
export const pendingSigners = (
  wires: ReadonlyArray<Uint8Array>,
  address: string,
): ReadonlyArray<string> =>
  wires.flatMap((wire) => decodeSolanaTransaction(wire, address).unsigned);

export async function signDappTransactions(
  engine: WalletEngine,
  origin: string,
  account: { readonly walletId: string; readonly groupIndex: number; readonly address: string },
  network: string,
  wires: ReadonlyArray<Uint8Array>,
): Promise<ReadonlyArray<Uint8Array>> {
  const pending = await engine.requests.prepare({
    method: "solana-sign",
    origin: { kind: "browser", origin },
    account,
    network,
    request: { kind: "transactions", transactions: wires, send: false },
  });
  const result = await engine.requests.outcome(pending.id);
  return "kind" in result && result.kind === "solana.transactions"
    ? (result.signedTransactions ?? [])
    : [];
}
```

## 7. Unknown-outcome sends

A send, speed-up, cancel or CPFP whose broadcast outcome is unknown (timeout, 5xx, transport error)
resolves with a `submitted` transaction tracked under its own hash instead of rejecting, and the
engine rebroadcasts the same bytes until the outcome is known — after a restart too. Show it as
pending and never offer to send again. Only a definitive refusal rejects (`failed`). The signed
bytes moved from `TrackedTransaction.evm.raw` to `TrackedTransaction.raw` for every family.
Bitcoin dApp `signAndSendTransaction` broadcasts are tracked the same way.

`confirmed` is no longer terminal: a transaction records the block it landed in
(`TrackedTransaction.block`) and stays tracked at a low frequency until `final` — EVM `finalized`
tag, six Bitcoin confirmations, Solana `finalized` commitment. A reorg returns it to `submitted`
(and polling, with rebroadcast of the persisted bytes), so show it pending again until `final`.
A `final` transaction is never polled again.

Spark payments behave alike: a lost response resolves `{ kind: "pending", payment }` instead of
failing, and the engine keeps the payment record until the Spark operator settles or fails it —
see section 12.

[`tests/migration/unknown-outcome.ts`](tests/migration/unknown-outcome.ts):

```ts
import type { TrackedTransaction, TxState, WalletEngine } from "@qntx/wallet-engine";

const ENDED: ReadonlySet<TxState> = new Set(["failed", "rejected", "dropped", "replaced"]);

/**
 * A broadcast whose outcome is unknown (timeout, 5xx, transport error) no longer rejects: `approve`
 * resolves with a `submitted` transaction tracked under its own hash, and the engine rebroadcasts
 * the same bytes. Never offer "try again" for it — a second send could pay twice. Only a definitive
 * refusal rejects, and the transaction is then `failed`. `confirmed` is no longer terminal either:
 * a transaction in a block (`tx.block` set) stays tracked until `final` — EVM `finalized` tag, six
 * Bitcoin confirmations, Solana `finalized` commitment — and a reorg puts it back to `submitted`,
 * so show it pending again until `final`.
 */
export function watchUntilSettled(
  engine: WalletEngine,
  txId: string,
  onChange: (tx: TrackedTransaction) => void,
): () => void {
  const stop = engine.transactions.store.subscribe((state) => {
    const tx = state.txs[txId];
    if (tx === undefined) {
      return;
    }
    onChange(tx);
    if (tx.block === undefined ? ENDED.has(tx.state) : tx.final === true) {
      stop();
    }
  });
  return stop;
}

/** The signed bytes live on `raw` for every family (0.13.0 kept them on `evm.raw`). */
export function signedBytes(tx: TrackedTransaction): string | undefined {
  // oxlint-disable typescript/no-unsafe-assignment -- demonstrates the removed evm.raw field
  // @ts-expect-error -- `evm.raw` moved to `raw`
  const before: string | undefined = tx.evm?.raw;
  // oxlint-enable typescript/no-unsafe-assignment
  return tx.raw ?? before;
}
```

## 8. Backup password

- The backup password is stretched with Argon2id (64 MiB, 3 passes, 4 lanes) instead of PBKDF2 and
  needs at least 12 characters (`invalid-input` from the kernel). `engine.backup.enable` also
  refuses a guessable one with `BackupControllerError` category `weak-password` before any
  verification; rate drafts with `backupPasswordStrength(password)` (`acceptable` = zxcvbn score
  4). The vault password factor is unchanged.
- Backup envelope version 3: 0.13.0 backup files are not read. Ask every user with backup on to
  enable it again after the upgrade.
- `backup.disable(verify)` re-verifies.
- A restore unwrapped by the backup password — or by a passkey on the Web — brings the wallets back
  but leaves backup off (`snapshot.backup === null`): prompt the user to enable it again. Only a
  React Native passkey restore keeps the restored backup key.
- Argon2id runs in the kernel on every host; Web and Node use `@noble/hashes`, React Native a
  vendored native implementation. Expect a restore or enable with a password to take noticeably
  longer than before.

[`tests/migration/backup.ts`](tests/migration/backup.ts):

```ts
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { WalletEngine } from "@qntx/wallet-engine";
import { BackupControllerError, backupPasswordStrength } from "@qntx/wallet-engine";

/** `backup.disable` re-verifies like `enable`. */
export async function turnBackupOff(engine: WalletEngine, verify: VerifyFactor): Promise<void> {
  // @ts-expect-error -- disable takes the verification factor
  await engine.backup.disable();
  await engine.backup.disable(verify);
}

/**
 * The backup password is stretched with Argon2id and must be at least 12 characters and reach
 * zxcvbn's top score: rate the draft as the user types, and expect `weak-password` from `enable`.
 */
export async function enablePasswordBackup(
  engine: WalletEngine,
  verify: VerifyFactor,
  password: string,
): Promise<"enabled" | "weak"> {
  const strength = await backupPasswordStrength(password);
  if (!strength.acceptable) {
    return "weak";
  }
  try {
    await engine.backup.enable({ verify, factors: [{ kind: "password", password }] });
    return "enabled";
  } catch (error) {
    if (error instanceof BackupControllerError && error.category === "weak-password") {
      return "weak";
    }
    throw error;
  }
}

/**
 * Restoring with the backup password (or a Web passkey) brings the wallets back but leaves backup
 * off: ask the user to enable it again, which writes a new key and a new cloud file.
 */
export async function restoreFromBackup(
  wallet: Wallet,
  engine: WalletEngine,
  name: string,
  password: string,
): Promise<{ readonly backupOff: boolean }> {
  await engine.backup.restore({ name, backupFactor: { kind: "password", password } });
  return { backupOff: wallet.getSnapshot().backup === null };
}
```

## 9. Prices

`engine.prices` fetches spot quotes for every held asset from the gateway; it polls every 60 s only
while `setVisible(true)`, so wire it to the app's foreground state. `setCurrency` chooses one of
`FIAT_CURRENCIES` and persists it. `engine.portfolio.group(group)` values the balances already in
state as exact decimal strings, with a `stale` flag (quotes older than 10 minutes) and an
`unpriced` count. Prices are display-only: never use them to build or sign anything.

[`tests/migration/prices.ts`](tests/migration/prices.ts):

```ts
import type { FiatCurrency, Valuation, WalletEngine } from "@qntx/wallet-engine";

/** Prices poll only while the host says it is visible; wire it to the app's foreground state. */
export function followVisibility(
  engine: WalletEngine,
  onVisibilityChange: (listener: (visible: boolean) => void) => () => void,
): () => void {
  engine.prices.setVisible(true);
  return onVisibilityChange((visible) => {
    engine.prices.setVisible(visible);
  });
}

/** The quote currency is persisted per vault; switching drops every quote and refetches. */
export async function chooseCurrency(engine: WalletEngine, currency: FiatCurrency): Promise<void> {
  await engine.prices.setCurrency(currency);
}

/** Exact decimal strings: format them for display, never parse them into floats for arithmetic. */
export async function groupTotal(
  engine: WalletEngine,
  group: { readonly walletId: string; readonly groupIndex: number },
): Promise<{ readonly total: string; readonly partial: boolean }> {
  const valuation: Valuation = await engine.portfolio.group(group);
  return { total: valuation.total, partial: valuation.stale || valuation.unpriced > 0 };
}
```

## 10. History

`engine.history` lists one account group's activity newest first, received transfers included,
from Esplora (all four Bitcoin templates), Solana RPC, the Spark operators and the gateway (EVM).
Locally tracked sends fold into the matching chain entry. A gateway EVM entry is `verified` only
after it was checked against RPC; show `flags` (`zero-value-transfer`, `lookalike-counterparty`,
`token-impersonation`, `suspicious-token-symbol`, `chain-mismatch`) as warnings and never offer a
history counterparty as a known recipient. `truncated` names the networks whose provider pages
dropped entries that could not be paged — show a gap notice while it is non-empty.

[`tests/migration/history.ts`](tests/migration/history.ts):

```ts
import type { GroupHistory, WalletEngine } from "@qntx/wallet-engine";

/**
 * One newest-first activity list per account group, incoming transfers included. State is keyed
 * `${walletId}:${groupIndex}`; `loadMore` pages older entries while `hasMore`. `gaps` names the
 * networks whose provider pages dropped entries — render a gap notice while it is non-empty.
 */
export function showActivity(
  engine: WalletEngine,
  group: { readonly walletId: string; readonly groupIndex: number },
  render: (history: GroupHistory, gaps: ReadonlyArray<string>) => void,
): () => void {
  const key = `${group.walletId}:${String(group.groupIndex)}`;
  const stop = engine.history.store.subscribe((state) => {
    const history = state.groups[key];
    if (history !== undefined) {
      render(history, history.truncated);
    }
  });
  void engine.history.load(group);
  return stop;
}

export async function showOlder(
  engine: WalletEngine,
  group: { readonly walletId: string; readonly groupIndex: number },
): Promise<void> {
  await engine.history.loadMore(group);
}
```

## 11. Bitcoin balances and coin control

- `AssetsController.refreshBitcoin(xpub, network)` is removed: `refreshBitcoinGroup(group,
  network)` reads every template of the group, with per-template `sources` and the `utxos` list;
  `refresh(address, network)` reads a plain address.
- UTXOs on taproot addresses or worth at most 20,000 sat are `protected` as possible inscription or
  rune carriers: sends do not pick them, the balance counts them in `protected` (0.13.0 named it
  `frozen`, on `AccountBalances` and per-source totals), and a dApp PSBT spending one raises
  `bitcoin-inscription-input`. Naming one in `inputs` opts into spending it.
- User freezes: `engine.transactions.setUtxosFrozen` / `frozenUtxos`, per account and network.
  Automatic selection, speed-up and CPFP skip frozen outpoints; a dApp PSBT spending one raises the
  `bitcoin-frozen-input` danger. The balance does not read this list: a user-frozen coin still
  counts in `native`, so combine `utxos` with `frozenUtxos` to show it apart.
- `inputs` on a `send` request spends exactly the named outpoints.

[`tests/migration/coin-control.ts`](tests/migration/coin-control.ts):

```ts
import type { AccountRef, WalletEngine } from "@qntx/wallet-engine";

type Group = { readonly walletId: string; readonly groupIndex: number };

/** One Bitcoin balance per account group, over all four templates (0.13.0 read one xpub). */
export async function bitcoinBalance(
  engine: WalletEngine,
  group: Group,
  network: string,
  xpub: string,
): Promise<string> {
  // oxlint-disable typescript/no-unsafe-call -- demonstrates the removed 0.13.0 method
  // @ts-expect-error -- refreshBitcoin(xpub, network) is removed
  await engine.assets.refreshBitcoin(xpub, network);
  // oxlint-enable typescript/no-unsafe-call
  const balances = await engine.assets.refreshBitcoinGroup(group, network);
  return balances.native;
}

/** Value protected as possible inscription or rune carriers; 0.13.0 called it `frozen`. */
export async function protectedBalance(
  engine: WalletEngine,
  group: Group,
  network: string,
): Promise<string | undefined> {
  const balances = await engine.assets.refreshBitcoinGroup(group, network);
  // oxlint-disable typescript/no-unsafe-assignment -- demonstrates the renamed 0.13.0 field
  // @ts-expect-error -- `frozen` is renamed `protected`
  const before: string | undefined = balances.frozen;
  // oxlint-enable typescript/no-unsafe-assignment
  return balances.protected ?? before;
}

/**
 * The UTXO list marks possible inscription and rune carriers `protected`; user freezes are a
 * separate, persisted per-account list.
 */
export async function listCoins(
  engine: WalletEngine,
  group: Group,
  network: string,
): Promise<
  ReadonlyArray<{
    readonly outpoint: string;
    readonly protected: boolean;
    readonly frozen: boolean;
  }>
> {
  const { utxos = [] } = await engine.assets.refreshBitcoinGroup(group, network);
  const frozen = new Set(engine.transactions.frozenUtxos(group, network));
  return utxos.map((utxo) => {
    const outpoint = `${utxo.txid}:${String(utxo.vout)}`;
    return { outpoint, protected: utxo.protected, frozen: frozen.has(outpoint) };
  });
}

export async function freeze(
  engine: WalletEngine,
  group: Group,
  network: string,
  outpoints: ReadonlyArray<string>,
): Promise<void> {
  await engine.transactions.setUtxosFrozen(group, network, outpoints, true);
}

/** `inputs` spends exactly the named outpoints; naming a protected one opts into spending it. */
export async function sendFromCoins(
  engine: WalletEngine,
  account: AccountRef,
  network: string,
  to: string,
  amount: bigint,
  inputs: ReadonlyArray<string>,
): Promise<string> {
  const pending = await engine.requests.prepare({
    method: "send",
    account,
    network,
    to,
    amount,
    fee: "normal",
    inputs,
  });
  return pending.id;
}
```

## 12. Spark tokens and exits

- `SparkAccountState.tokens` holds token balances in base units.
- A token payment is a `pay` request with `token: { identifier, amount }` to a plain Spark address
  and no `amountSats` (`engine.spark` has no send method). It resolves
  `{ kind: "token", transactionHash }`.
- Every Spark payment is idempotent per request and recorded before it is sent. A lost response
  resolves `{ kind: "pending", payment }`, where `payment` is a `SparkPaymentRecord` (`state`
  `submitted` | `unknown` | `settled` | `failed`). The open record is persisted, reconciled against
  the Spark operator after unlock and on a backed-off poll, listed in
  `SparkAccountState.payments` (by `payment.id`) and in `engine.history` as a pending entry. Show
  it in flight and never pay again; `failed` only comes from the operator. `SparkResult` gains
  `pending` and `token`; `SparkDisplay` gains a `token` variant.
- While a token send with an unknown outcome is open, another send of the same token is refused
  until it resolves.
- Paying a Bitcoin address from Spark (cooperative exit): `amountSats` is what arrives, the exit
  debits `amountSats + feeSats`, the display carries `feeSats`, and `maxFeeSats` is required — a
  higher quote is refused at prepare.

[`tests/migration/spark-tokens.ts`](tests/migration/spark-tokens.ts):

```ts
import type { VerifyFactor } from "@qntx/wallet";
import type {
  SparkPaymentRecord,
  SparkPaymentState,
  SparkResult,
  SparkTokenBalance,
  WalletEngine,
} from "@qntx/wallet-engine";
import { requiredAcknowledgement } from "@qntx/wallet-engine";
import type { SparkAccountRef } from "@qntx/wallet/spark";

/** Token balances in base units, refreshed with the account; absent until the first read. */
export function tokenBalances(
  engine: WalletEngine,
  ref: SparkAccountRef,
): ReadonlyArray<SparkTokenBalance> {
  const key = `${ref.walletId}:${String(ref.groupIndex)}:${ref.network}`;
  return engine.spark.getState().accounts[key]?.tokens ?? [];
}

/** A token payment is a `pay` request to a plain Spark address, without `amountSats`. */
export async function payToken(
  engine: WalletEngine,
  account: SparkAccountRef,
  address: string,
  token: { readonly identifier: string; readonly amount: bigint },
  verify: VerifyFactor,
): Promise<SparkResult> {
  const request = await engine.requests.prepare({
    method: "pay",
    account,
    option: { kind: "spark", address },
    token,
  });
  return engine.requests.approve(request.id, "pay", {
    verify,
    acknowledged: requiredAcknowledgement(request),
  });
}

/**
 * `pending` means the response was lost after the payment may have committed: show it as in flight,
 * never as failed, and never pay again.
 */
export function describeSparkResult(result: SparkResult): "done" | "in-flight" {
  return result.kind === "pending" ? "in-flight" : "done";
}

/** The engine keeps following a pending payment: its record settles or fails in the account state. */
export function paymentState(
  engine: WalletEngine,
  ref: SparkAccountRef,
  payment: SparkPaymentRecord,
): SparkPaymentState | undefined {
  const key = `${ref.walletId}:${String(ref.groupIndex)}:${ref.network}`;
  return engine.spark.getState().accounts[key]?.payments?.[payment.id]?.state;
}

/**
 * Paying a Bitcoin address from Spark (cooperative exit): `amountSats` is what arrives, the exit
 * debits `amountSats + feeSats`, and `maxFeeSats` is required — a higher quote is refused at
 * prepare.
 */
export async function prepareExit(
  engine: WalletEngine,
  account: SparkAccountRef,
  address: string,
  amountSats: number,
  maxFeeSats: number,
): Promise<number | undefined> {
  const request = await engine.requests.prepare({
    method: "pay",
    account,
    option: { kind: "bitcoin", address },
    amountSats,
    maxFeeSats,
  });
  const { display } = request;
  return "feeSats" in display ? display.feeSats : undefined;
}
```

## 13. Removed APIs

| Removed                                                                                                                | Use instead                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `InitialFactor` `{ kind: "hardware" }`, `factor` on React Native create/import/restore                                 | nothing — React Native chooses its factors                                           |
| `UnlockFactor` as a `verify` type                                                                                      | `VerifyFactor`                                                                       |
| `WalletErrorCode` `no-device-credential`                                                                               | `verification-unavailable`                                                           |
| `backup.disable()`                                                                                                     | `backup.disable(verify)`                                                             |
| `requests.approve(id, method, verify)`                                                                                 | `requests.approve(id, method, { verify, acknowledged })`                             |
| `AccountTreeController.setBlindSigning` / `blindSigning`, `AccountGroup.blindSigning`                                  | `wallet.vault.setBlindSigning`, `snapshot.blindSigning`                              |
| `AssetsController.refreshBitcoin(xpub, network)`                                                                       | `refreshBitcoinGroup(group, network)`                                                |
| `WalletEngine.transactions.prepare*`                                                                                   | `engine.requests.prepare`                                                            |
| `engine.transactions.batchById`, `delegationState`                                                                     | `engine.transactions.txById` per transaction, `engine.delegation`                    |
| `engine.spark.setAccounts`, `inspect`, `claimDeposit`, `lockAll`                                                       | `engine.accounts.select` / `discoverSpark`; deposits are claimed by the engine       |
| controller `init`, `lock`, `destroy`, `setStore`, `reconcile`, `trigger`, `store.setState` on engine members           | nothing — the engine owns controller lifecycle and state                             |
| `engine.requests.invalidateOrigin`                                                                                     | `engine.connections.invalidateOrigin` (what `createBrowserBridge` calls)             |
| `engine.connections.request`, `authorize`, `touch`                                                                     | nothing — dApp-side steps run inside the provider handlers                           |
| `engine.accounts.exportMeta` / `mergeMeta`, `engine.addressBook.merge` / `syncEntries`                                 | `engine.metaSync`                                                                    |
| `engine.networks.ensClient`, `independentClient`, `independentEnsClient`, `independentSolanaRpc`, `independentEsplora` | `engine.names.resolve`; cross-checks run inside the engine                           |
| `AccountBalances.frozen`, `BitcoinTotals.frozen` (Bitcoin)                                                             | `protected`                                                                          |
| `TrackedTransaction.evm.raw`                                                                                           | `TrackedTransaction.raw`                                                             |
| `EngineOptions.gateway.installId`                                                                                      | nothing                                                                              |
| `ConnectionController.setActiveGroup`, `activeGroup`, `accounts`, `solanaAccount`, `bitcoinAccounts`, `nostrAccount`   | `engine.accounts.select`, `connections.sessionAccounts`, `connections.nostrIdentity` |
| `SolanaWalletHandler.solanaAccountsChanged`, `BitcoinWalletHandler.bitcoinAccountsChanged`                             | the handlers' own `change` events                                                    |
| `ProviderInfo.uuid`                                                                                                    | nothing                                                                              |
| `SparkControllerOptions.random`                                                                                        | nothing                                                                              |
| `EngineErrorCode` `integrity`                                                                                          | an unreadable row reads as absent                                                    |
| gateway contract `INSTALL_ID_HEADER`, `installId`, `InstallId`                                                         | `CLIENT_ID_HEADER`, `clientId`, `ClientId`                                           |
| `ChainErrorCode` `fee-payer-mismatch`                                                                                  | nothing — any required signer may sign                                               |
| `SafeTransaction.gasToken`, `refundReceiver`                                                                           | `SafeTransaction.refund` `{ receiver?, gasPrice, amount }`                           |

## 14. New error codes

| Where                            | Code                                                                                                   | Meaning                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `WalletError.code`               | `verification-unavailable`                                                                             | React Native: no factor can verify (no lock screen). No prompt was shown.         |
| `WalletError.code`               | `blind-signing-disabled`                                                                               | A blind request while the vault setting is off. No prompt was shown.              |
| `BackupControllerError.category` | `weak-password`                                                                                        | The backup password is too easy to guess.                                         |
| `SparkControllerError.category`  | `unknown`                                                                                              | The payment may have committed; it settles under `transferId` / `inputOutputIds`. |
| engine request errors            | `AcknowledgementRequiredError`, `BlindSigningDisabledError` (now on every blind request, at `approve`) | See sections 4 and 5.                                                             |
| `RiskFinding.code`               | `bitcoin-frozen-input` (danger)                                                                        | A dApp PSBT spends a user-frozen outpoint.                                        |
| `RequestStage`                   | `signed`                                                                                               | Signed, not yet submitted: no longer invalidated.                                 |
| EIP-1193 provider                | `-32005`                                                                                               | An `eth_getLogs` filter over the bounds.                                          |
| gateway                          | `outcome-unknown` (`502`)                                                                              | A broadcast whose outcome is unknown; never retried on another provider.          |

[`tests/migration/error-codes.ts`](tests/migration/error-codes.ts):

```ts
import type { WalletErrorCode } from "@qntx/wallet";
import type { BackupErrorCategory, EngineErrorCode, SparkErrorCategory } from "@qntx/wallet-engine";

/**
 * Exhaustive maps: adding or removing a code fails this file, so the list in MIGRATION.md stays
 * complete. New in this release: `verification-unavailable`, `blind-signing-disabled`
 * (`no-device-credential` is gone); `weak-password`; `unknown`; `EngineErrorCode` lost
 * `integrity`.
 */
export const WALLET_ERROR_IS_NEW: Readonly<Record<WalletErrorCode, boolean>> = {
  locked: false,
  cancelled: false,
  "factor-invalidated": false,
  "verification-unavailable": true,
  "passkey-not-configured": false,
  "passkey-prf-unsupported": false,
  "wrong-password": false,
  "wrong-passkey": false,
  "rate-limited": false,
  "invalid-input": false,
  "not-found": false,
  "already-exists": false,
  conflict: false,
  unsupported: false,
  unavailable: false,
  integrity: false,
  "blind-signing-disabled": true,
  "approval-required": false,
  crashed: false,
};

export const BACKUP_ERROR_IS_NEW: Readonly<Record<BackupErrorCategory, boolean>> = {
  cloud: false,
  conflict: false,
  unavailable: false,
  "weak-password": true,
};

export const SPARK_ERROR_IS_NEW: Readonly<Record<SparkErrorCategory, boolean>> = {
  network: false,
  "approval-required": false,
  "insufficient-funds": false,
  rejected: false,
  unknown: true,
  internal: false,
};

// @ts-expect-error -- the engine store no longer reports integrity: an unreadable row reads absent
export const ENGINE_INTEGRITY: EngineErrorCode = "integrity";
```

## 15. Signing behaviour hosts may notice

- `evm.typed-data` must declare `types.EIP712Domain`, nests at most 32 levels, and a transaction
  with `maxPriorityFeePerGas` above `maxFeePerGas` is refused.
- `bitcoin.psbt` inputs signed under bip44/bip49/bip84 need `nonWitnessUtxo` (the engine adds it
  for its own and dApp PSBTs); a fee the kernel cannot prove shows as "Fee unknown".
- BIP-322 simple signatures now match the official vectors: signatures made by 0.13.0 no longer
  verify. Legacy message signatures now verify in Bitcoin Core and Electrum.
- NIP-07 confirms every replaceable, addressable and ephemeral event kind, whatever the origin's
  policy.
- Password re-verification is rate-limited like unlock (`rate-limited` with `retryAt`).

## 16. Built-in EVM networks and fee model

### `NetworkInfo.opStack` → `NetworkInfo.feeModel`

`NetworkInfo` (exported from `@qntx/wallet-engine`, `@qntx/wallet-engine/connect` and
`@qntx/wallet-engine/gateway/contract`) no longer has `opStack?: true`. Every EVM entry now carries
`feeModel: { kind: "execution" } | { kind: "op-stack" }`.

```ts
// before
if (network.opStack === true) showL1Fee();
// after
if (network.feeModel?.kind === "op-stack") showL1Fee();
```

Treat an unknown future `kind` as "charges something beyond gas" rather than as "execution".

### More built-in networks

`BUILT_IN_NETWORKS` / `NETWORKS` grow from 8 + 8 EVM networks to 31 mainnets + 22 testnets in a fixed
order (existing first). Hosts that hard-code the number of networks, index the array by position, or
render every network unconditionally should filter by `testnet` and by what `engine.networks.enabled()`
reports (networks with an endpoint or served by the gateway). Signing chain ids still come only from the
table; `wallet_addEthereumChain` / `wallet_switchEthereumChain` for ids outside it still answer 4902.

### Gateway

Production now needs the Alchemy app and the dRPC key enabled for the new networks (see the report for
the list). Staging serves every built-in EVM testnet through public keyless endpoints.

### `FeeModel` gains `pricing`, `operatorFee`, `tokenRatio` and a `scroll` kind

`FeeModel` (exported from `@qntx/wallet-engine` and `@qntx/wallet-engine/gateway/contract`, reachable through
`NetworkInfo.feeModel` from `@qntx/wallet-engine/connect` too) is now:

```ts
type GasPricing = "eip1559" | "legacy"; // newly exported
type FeeModel =
  | { kind: "execution"; pricing: GasPricing }
  | { kind: "op-stack"; pricing: GasPricing; operatorFee: boolean; tokenRatio: boolean }
  | { kind: "scroll"; pricing: GasPricing };
```

```ts
// before
if (network.feeModel?.kind === "op-stack") showL1Fee();
// after — Scroll also charges an L1 data fee
const model = network.feeModel;
if (model !== undefined && model.kind !== "execution") showL1Fee();
// legacy-priced networks (opBNB, Fraxtal) sign type-0 transactions: show a gas price, not 1559 caps
if (model?.pricing === "legacy") showGasPriceOnly();
```

Code that constructs `FeeModel` literals (test fixtures) must add the new required fields.

### `fee.l1Data` is an upper bound

`DisplayIntent.fee.l1Data` on OP Stack and Scroll networks is now the oracle's L1 data-fee estimate × 5/4
(rounded up) plus the operator fee at the full gas limit — an upper bound like `fee.max`, not a point estimate.
Displayed maximum fees and the `fee-exceeds-amount` check move up accordingly; the fee actually charged is
unchanged. Hosts that labelled `l1Data` "estimated" should label it a maximum. On Mantle the figure was ~4,400×
too low before (now multiplied by `tokenRatio()`).

### Token table roles

`EvmToken` gains an optional `role: "native-alias" | "wrapped-native"`. Native-alias rows (Celo CELO, Arc USDC,
Stable USDT0 and testnets) are never returned as token balances; hosts that iterate `evmTokenTable` themselves
to read balances must skip them to avoid counting the native coin twice. Wrapped-native rows (WETH, WBNB,
WPOL, … on 24 networks) now appear as ordinary token balances, and `deposit()`/`withdraw(uint256)` calls to them
are described as a `swap` with `verifiability: "full"` instead of an opaque contract call.

### More built-in networks

10 mainnets (Ink, Fraxtal, Ronin, Scroll, BOB, opBNB, Arbitrum Nova, Taiko, Flare, Zora) and 4 testnets
(Ink Sepolia, Fraxtal Hoodi, opBNB Testnet, Zora Sepolia) are appended after the existing entries of each group;
existing positions do not move.

### Gateway operators

A new production secret `ANKR_API_KEY` is required (`wrangler.jsonc` `secrets.required`); Ankr serves Arbitrum
Nova, Taiko and Flare after dRPC. Enable the new networks in the production Alchemy app (`ink-mainnet`,
`frax-mainnet`, `ronin-mainnet`, `scroll-mainnet`, `bob-mainnet`, `opbnb-mainnet`, `zora-mainnet`) and on the dRPC
paid plan.

## 17. TRON family

- `ChainFamily`, `NetworkMeta.family`, `AccountRef` (imported `family`), `KeyInfo.family` and the `keys.import` family parameter now include `"tron"`. Exhaustive `switch`es or `Record<…>` maps over these unions in host code need a `"tron"` case.
- `ChainTemplate` includes `"tron.bip44"` and `ChainAccount` has a `tron.bip44` arm with a base58 `address`; `ChainSignRequest`/`ChainSignResult` have `tron.transaction` and `tron.message` arms.
- `BUILT_IN_NETWORKS` (`@qntx/wallet-chains/networks`) contains three TRON entries. Code that iterates it without filtering by `family` will now see them.
- `@qntx/wallet-engine` `NetworkInfo.family` is typed `EngineFamily`; code that assigned a `NetworkMeta` to `NetworkInfo` must narrow the family first.
- A TRON private key's text form is 64 hex characters without `0x`; `keys.export` returns it in that form.

## 18. Hyperliquid agent key and app signing

### Vault

- New record kind `hl-agent` (id: the agent's lowercase address; header
  `{ walletId, groupIndex, owner, network, name, validUntil, createdAt }`; sealed payload: the
  32-byte agent private key). `VAULT_FORMAT` stays 5 and the vault manifest covers the new rows
  like every other record.
- No data migration: existing vaults are unchanged until the first `hyperliquid.createAgent`.
- Downgrade: once a vault holds an `hl-agent` record, a build without this change reports the
  vault `unsupported` (an unclaimed record kind) and leaves it untouched. Delete all agents
  (`hyperliquid.deleteAgent`) before downgrading.
- Backups never contain agent keys. After a restore, create and approve a new agent.

### Host-visible behaviour

- `chain.sign` of Hyperliquid user-signed typed data and of Polymarket orders, `ClobAuth` and
  deposit-wallet batches now produces described prompts and `DisplayIntent.message.hyperliquid` /
  `.polymarket`. Shapes under those domains that are not exactly the described ones are now blind
  (`typed-data-variant`; `typed-data-commitment` for the Hyperliquid `Exchange`/`Agent` document)
  and are refused unless the vault's blind-signing policy is on — previously they were shown as a
  generic field list.
- `chain.sign` of an `approveAgent` for an agent address this vault holds is refused with
  `invalid-input` unless the signer is the agent's owner and `hyperliquidChain`, the agent name and
  `valid_until` equal the values given to `hyperliquid.createAgent`. Build the name as
  `` `${name} valid_until ${validUntil}` ``.
- New methods `hyperliquid.createAgent`, `hyperliquid.listAgents`, `hyperliquid.deleteAgent`,
  `hyperliquid.signL1` (session required). `hyperliquid.signL1` does not refresh the idle timer.

## 19. Signing classification: message text, typed-data commitments, orders, Solana program authority

### Message text

- Every valid UTF-8 message decodes to `{ kind: "text" }`. 32-byte messages and text with hidden characters are no longer `{ kind: "bytes" }`. Only invalid UTF-8 is `bytes`.
- `isReadableText`, `isUnsafeCodePoint` and `isHexRendering` are removed from `@qntx/wallet-chains`. Use `messageTextHazard(text)` (`"digest-length" | "hidden-characters" | "encoded-bytes" | undefined`) to learn whether text is blind and why, `hasHiddenCharacters(text)` to check for deceptive code points, and `isEncodedBytes(text)` to detect text that encodes raw bytes. `messageBlindReason` keeps its signature.
- Before/after: `tests/migration/message-text.ts`.

### Warnings and limits

- `IntentWarning.kind` is now the closed union `IntentWarningKind`. Code that switches on `kind` gets exhaustiveness checking; code that constructs warnings with arbitrary strings no longer compiles.
- `SEAPORT_ORDER_ITEMS` (4) is renamed `ORDER_ITEMS` (8) and is shared by Seaport and the new order decoders.

### New intent content (display-only, host-visible)

- `MessageContent` (typed-data) gains `order?: OffchainOrder` for decoded 1inch LOP v4, CoW Protocol and UniswapX orders.
- `DisplayIntent` gains `programAuthority?: ReadonlyArray<ProgramAuthority>` (Solana).
- `AssetFlow` gains `tokenAccount?: string` (SPL unchecked `Transfer`).
- `StakeAction` gains `{ kind: "split" }`.
- `BlindReason` gains `"program-authority"`. Exhaustive switches over `BlindReason` must handle it.

### Behaviour

- An undecoded typed-data document with any hash/bytes leaf is blind (`typed-data-commitment`). Documents of claimed order protocols (1inch, CoW, 0x v4, Blur, LooksRare v2, Bebop, Paraswap, Velora Delta, KyberSwap, OpenOcean, Odos) that are not decoded are blind (`typed-data-variant`). Hosts that offered these flows with blind signing off will now see `BlindSigningDisabledError` for them.
- `chains(wallet).sign` throws `integrity` when the kernel's result kind differs from the request kind (previously possible for Solana requests).

## 20. Engine: stopped batches, read-only state, durable nonces

### Batch sends: `refused` → `stopped`

`SolanaSignResult` (`solana-sign` requests with `send: true`) and `BitcoinSignResult`
(`bitcoin-sign` with `send: true`) no longer report a partial batch as `refused`. The field is
now `stopped`:

```ts
readonly stopped?: {
  readonly index: number;                 // input that did not go out
  readonly reason: "refused" | "not-sent";
  readonly error: string;
};
```

- `reason: "refused"` — the node itself rejected that input's bytes. It and every later input
  were not sent; the dApp sees `the network refused transaction ${index}: …`.
- `reason: "not-sent"` — a local failure (e.g. the durable pre-broadcast write) kept the input
  from being broadcast at all; the dApp sees `transaction ${index} was not sent: …`. A
  post-broadcast bookkeeping failure can no longer stop a batch: once bytes are out, the item is
  reported as sent.

The ids already submitted are still on `signatures` (Solana) / `txids` (Bitcoin) — never
resubmit them. The first input failing still rejects the whole request as before (nothing went
out). Snippet: `tests/migration/batch-stopped.ts`.

### Engine state snapshots are deeply read-only

Every controller's `getState()` (and `store.getState()`) on the `WalletEngine` facade now returns
a deeply frozen snapshot, typed `DeepReadonly<…>` (new exported type). Host code that edited a
snapshot in place — `delete state.txs[id]`, `rows.sort()`, assigning into `balances` — no longer
compiles and throws a `TypeError` at runtime. Copy first (`Object.values(...).toSorted(...)`,
`{ ...state.txs }`). Snippet: `tests/migration/readonly-state.ts`.

### `TrackedTransaction.durableNonce`

Additive: a Solana durable-nonce transaction carries `durableNonce: { account, value }` and no
`lastValidBlockHeight`; `account` is `undefined` when the message loads the nonce account from an
address lookup table. Such a transaction is never shown `dropped` by block height. No host change
is required.

## 21. Gateway coverage: unsupported

The gateway now distinguishes _permanent_ absence of coverage from _temporary_ failure, with a new
contract error code `"unsupported"` (HTTP 404, appended to `GATEWAY_ERRORS`): **this gateway will
never serve this resource for this network or asset — do not retry.**

### Before

- `POST /v1/history/:caip2` on a served network whose providers offer no history answered
  `503 unavailable` with `Retry-After` — clients retried forever for coverage that would never
  appear.
- `GET /v1/tokens/:caip2` answered `404 not-found` for every absent list — a network with no
  configured token source looked exactly like one whose hourly build had not landed yet.
- `POST /v1/prices` returned assets no provider maps inside `missing` — indistinguishable from
  assets a provider might price on the next request.

### After

- `POST /v1/history/:caip2` on a served network with no history provider answers `404`
  `{"error":"unsupported"}` (no `Retry-After`). Unknown or non-EVM networks still answer
  `404 unknown-network`.
- `GET /v1/tokens/:caip2`: a served network no configured token source covers → `404`
  `{"error":"unsupported"}`; a covered network whose stored list is absent → `503`
  `{"error":"unavailable"}` with `Retry-After` (the hourly build has not landed).
- `POST /v1/prices` responses carry a third list `unsupported` — every requested asset is in
  exactly one of `prices`, `missing` (no price now; may change) or `unsupported` (no provider maps
  it; never sent upstream, never cached). `pricesResponse` requires the field: deploy gateway and
  engine together.

### Engine surfaces a host sees

- `GroupHistory.unsupported: ReadonlyArray<string>` — sorted network ids the gateway has no
  history for. The group's entry list is complete for every other network: render a "no history
  for this network" notice instead of a load error. Lifecycle mirrors `truncated` (reset per
  load, not persisted).
- `PricesState.errors` values are now `"unpriced" | "unsupported"`. An asset reported
  `unsupported` also loses any stored quote — it has no price coverage at all — so a stale
  number never masquerades as a live one. Render it permanently absent (greyed out), not
  retryable.
- `TokenLists`: a 404 `unsupported` or `unknown-network` stores the empty list as before; a bare
  404 without a recognised code and a 503 are failures — they back off ten minutes and keep any
  stored list.

See `tests/migration/unsupported.ts` (compiled by `bun run typecheck`) for the snippet.

## 22. TRON in the engine and gateway

The compiled host snippet is `tests/migration/tron.ts`.

### Types

- `EngineFamily`, `NetworkInfo.family`, `TrackedTransaction.family`, `HistoryEntry.family`,
  `WatchAccount.family`, `AddressFamily`, `GatewayScope` and the sign-log family now include
  `"tron"`. Exhaustive `switch`es or `Record<…>` maps over these unions need a `"tron"` case.
- `GatewayConfig.clientIds` has a `tron` entry. `gatewaySession` creates it; a host that builds
  `clientIds` by hand must add a fresh random 128-bit id for `tron`. Both types are now exported from the package root.
- `ChainRequestMethod`/`ChainRequestInput` gain `tron-stake` and `tron-approve`;
  `RequestController.approve(id, "tron-stake" | "tron-approve")` returns the tracked transaction.
- `PendingRequest.tronFee?: TronFeeQuote` is set on TRON requests; `AccountBalances.tron?:
  TronAccountView` on TRON balance reads; `TrackedTransaction.tron?: { expiration, from }` on TRON
  rows. `RiskFinding.code` gains `contract-recipient`, `token-contract-recipient`,
  `token-recipient-empty`.

### Configuration

- Host `rpc` for `tron:728126428` / `tron:3448148188` lists full-node HTTP base URLs (for example
  `https://api.trongrid.io`), not JSON-RPC URLs. A custom endpoint is validated by its block 0 id.
- `send` with `token` set to a base58 `T…` address sends TRC-20, a 7-digit decimal id sends TRC-10,
  absent sends TRX; the `fee` tier is ignored on TRON (there is no fee market). Show
  `tronFee.expected`/`tronFee.max` and the warnings before approval.
- A TRON transaction expires 60 s after it is built: approving later fails with "transaction
  expired — start over" before anything is signed.

### Gateway operators

- Production needs the secrets `TRONGRID_API_KEY` and `TATUM_API_KEY` (`wrangler secret put`).
  Staging serves Nile keyless.

## 23. Hyperliquid app provider

### `requests.prepare({ method: "evm-sign" })` — `origin` is optional

`EvmSignInput.origin` is now `origin?: BrowserOrigin`. Absent means the request is the wallet's
own (`PendingRequest.origin` is `{ kind: "internal" }`), and only `request.kind ===
"evm.typed-data"` is accepted — a personal message or a transaction still needs a page origin
(sign-in and phishing checks run on it). Existing callers that pass an origin are unaffected. The
apps entry uses this for Hyperliquid user-signed actions; hosts showing approval screens must be
ready for an `evm-sign` request with an internal origin (show it as the wallet's own request; the
prompt content is the kernel's decode of the typed data, `display.message.hyperliquid`).

### New: `@qntx/wallet-engine/apps` and `@qntx/wallet/hyperliquid`

Opt-in entries; a host that does not import them bundles nothing new. The complete host
composition (engine + apps, terms, enable with the approval request, orders with quote previews,
a live book, close, withdraw, Bridge2 deposit) is the typechecked file
`tests/migration/hyperliquid.ts`, compiled by `bun run typecheck`
(`tsc --noEmit -p tests/migration`). The engine README's "Hyperliquid" section describes every
option.

Host checklist:

- Pass `requests: engine.requests`, a separate `openStore` (its own EngineStore namespace), a
  `socket: (url) => new WebSocket(url)` factory, the wallet `gateway` URL, and
  `hyperliquid: { network, agentName, builder? }` (no defaults; `builder.feeRateTenthsBps` 1..100).
- Render `AppsController` state: `status` (`disabled | enabling | enabled | needs-reauthorization
  | unavailable`), `step` + `requestId` (show that request's approval screen), `renewalDue`,
  `error`, and `eligibility` (call `refreshEligibility()` on foreground — display only).
- Market orders return the slippage cap they will post; show it before confirming.
- Order outcomes include `not-placed` and `unknown` (after a lost POST); nothing is re-sent.

### Gateway

New route `GET /v1/eligibility` (client id required, 1 rate-limit unit, `cache-control: private,
no-store`); contract `eligibility` in `@qntx/wallet-engine/gateway/contract`. Deploying the gateway
is required before hosts enable apps: without a `ready` eligibility answer `enable` refuses.

## 24. Spark outcomes, TRON precision, Hyperliquid CCTP deposits and the optional builder fee

Typechecked snippets: `tests/migration/spark-tokens.ts` (archive, `duplicate`), `tests/migration/
error-codes.ts` (`duplicate` category), `tests/migration/tron.ts` (bigint/string fields),
`tests/migration/hyperliquid.ts` (CCTP deposit, `builder: "declined"`, `approveBuilder`).

### Spark payments

- A payment whose commit call went out is `failed` only on the operator's word (expired/returned).
  Expect more `unknown` records that stay `unknown`; show them as "outcome unknown — do not pay
  again" and let the user retry the **same** request (it resumes under the same transfer id and
  pays at most once).
- New `SparkControllerError.category === "duplicate"`: a new payment with the same kind, receiver
  and amount (and token) as an `unknown` one is refused; `error.payment` is the earlier record.
  Offer to open that payment instead of sending again.
- Shortfalls now fail `insufficient-funds` before any record is written.
- `engine.spark.archivePayment(account, id)`: only for token records the operator can never answer
  for (no spent output ids). Ask the user first. The record's history entry stays `pending` with
  flag `unresolved`; it no longer blocks new sends. `SparkPaymentState` gains `"archived"`.

### TRON

- `TronFeeQuote.bandwidth.stakedAvailable`, `.freeAvailable` and `.energy.available` are `bigint`
  (were `number`). TRON account resource counters in the account view are decimal strings. Format
  them with the existing decimal helpers; never `Number()` a balance.

### Hyperliquid (`@qntx/wallet-engine/apps`)

- Deposits use CCTP: `depositInfo` describes the CCTP route (TokenMessengerV2, USDC, forwarder,
  domain 19) instead of Bridge2; there is no 5 USDC minimum, but the amount must exceed the Circle
  fee cap. `fund.deposit` returns `{ kind: "approval-required", approval }` when
  the USDC allowance is short (only an exact approval request is opened — the deposit cannot be
  built before the approval is mined); call `deposit` again once that approval confirmed, which
  returns `{ kind: "deposit", deposit }`. A `dex: "spot"` parameter funds the spot balance instead
  of perps. Bridge2 constants and the Bridge2 deposit are removed.
- `AppGroupState.builder` is `"approved" | "declined" | undefined`. A declined builder still ends
  `enabled`; trades carry no builder. `controller.approveBuilder(group, "hyperliquid")` asks again
  (e.g. from settings); a refusal leaves `declined`.

### Signing prompts hosts may notice

- A 32-byte message prompt adds a `Data 0x…` line and omits text that does not print plainly.
- Raydium AMM v4 / CPMM / CLMM and Orca Whirlpool swaps that used to show program-authority lines
  (or be blind past the account budget) are now swap prompts with "at most … / at least …" lines.
- Calls to the CCTP TokenMessengerV2 on Arbitrum other than a described Hyperliquid deposit are
  blind (`cctp-destination`) — plain CCTP bridging from Arbitrum to other chains now needs blind
  signing enabled.
- EVM history: accounts with code (EIP-7702 delegation) show their new history entries as
  unverified.

## 25. TRON in-app-browser provider, `tron-sign`, memos

Compiled snippet: `tests/migration/tron-dapp.ts`.

1. **Bridge.** `createBrowserBridge` takes a `tron` handler — pass the engine's `tronWallet` next to `solanaWallet`
   and `bitcoinWallet`. The injected script (`injectedScript(info)`) now also installs `window.tron`,
   `window.tronLink` and `window.tronWeb` and announces TIP-6963 with the same `ProviderInfo`; nothing else to do.

   ```ts
   // before
   createBrowserBridge({ eip1193, nip07, webln, solana, bitcoin, connections, inject, now });
   // after
   createBrowserBridge({
     eip1193,
     nip07,
     webln,
     solana,
     bitcoin,
     tron: engine.tronWallet,
     connections,
     inject,
     now,
   });
   ```

2. **Connection requests** may carry `namespace: "tron"`. Approve them like a Solana connection; `grant.network` must
   be an enabled TRON network and becomes the session's `tronNetwork` (the network the page sees as `chainId`).
3. **Pending requests** gain method `tron-sign`. Approve with `requests.approve(id, "tron-sign", …)`: a dApp
   transaction settles to a `TrackedTransaction` (state `submitted`, `tron.dappSignature` set — the dApp broadcasts it,
   the wallet only tracks it); a message or typed data settles to a `SignatureResult` (`kind: "tron.message" |
   "tron.typed-data"`). Show `pending.tronFee` for transactions as for any TRON send; the new risk code
   `fee-limit-below-estimate` (warning) means the dApp's `fee_limit` is below the energy estimate.
4. **Approval timing.** A dApp transaction is refused at approval when less than 20 s of validity remain ("the dApp
   must build it again"); an engine-built TRON send is rebuilt in place instead. Hosts should not hold a TRON approval
   sheet open waiting for anything else.
5. **Memos.** `send` on a TRON network accepts `memo` (≤ 256 UTF-8 bytes, one line); other families throw.
   `pending.tronFee.memo` is the memo fee in sun.
6. **`watch-asset`** can now arrive for a TRON network (TRC-20 base58 address).
7. `engine.connections.setTronNetwork(origin, network)` switches a dApp session's TRON network from the host UI (the
   TRON counterpart of `setCurrentNetwork`); the page receives `chainChanged { chainId }`.

## 26. WalletConnect

### WalletConnect peers are a new dApp origin kind

`RequestOrigin`, `ConnectionOrigin` (`ConnectionSession.origin`, `PendingConnection.origin`) and the
`origin` of every dApp request input are now `BrowserOrigin | WalletConnectOrigin`
(`DappOrigin`). A host that switches on `origin.kind` must handle `"walletconnect"`:
`origin.origin` is the session key `walletconnect:<topic>` (never a URL), `origin.url` and
`origin.name` are the peer's self-declared metadata (show them as unverified), `origin.verify` is
the Verify verdict. Use `dappUrl(origin)` wherever the host displays or checks the site.

### New risk codes

`verify-mismatch` (Verify `INVALID`) and `verify-threat` (Verify `isScam`) are `danger` findings —
an acknowledgement UI must name them; `requiredAcknowledgement` already includes them.

### `wc:` URIs

`engine.payments.parse` returns `{ kind: "walletconnect", uri }` for a WalletConnect v2 pairing
URI. Route it to `walletConnect.pair(uri)` (entry `@qntx/wallet-engine/walletconnect`).

### Injected Solana and Bitcoin providers: rejection codes

A rejected, expired or invalidated request now rejects the page's promise with `4001` (and a
sign-in message for another domain with `-32602`) instead of `-32603 internal error`. Code that
treated `-32603` as "the user said no" must use `4001`.

### `bitcoin:signAndSendTransaction` results

Each entry is `{ txId, signedPsbt }` (was `{ txId }`).

### Engine surface

`engine.connections` gains `establishWalletConnect`, `previewAccounts`, `authorize`, `touch`;
`ConnectionState` gains `ready`. Handler requests take an optional `network` the in-app bridge
never sets.
