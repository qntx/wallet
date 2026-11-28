# Migrating from 0.13.0 or 0.14.0

This guide covers every change a host of `@qntx/wallet`, `@qntx/wallet-engine`,
`@qntx/wallet-native` and `@qntx/wallet-worker` has to act on between the 0.13.0 release and
0.14.1: §1–§35 cover 0.13.0 → 0.14.0 and §36–§37 cover 0.14.0 → 0.14.1. A 0.14.0 host acts on
§36–§37 only; a 0.13.0 host acts on every section. [CHANGELOG.md](CHANGELOG.md) lists every
change; this file only lists what needs host work, grouped by task.

Every snippet below is a file under [`tests/migration/`](tests/migration), compiled by
`bun run typecheck` against the current sources. A line marked `@ts-expect-error` is the 0.13.0
form: it must fail to compile, so the guide breaks if an old API comes back or a new one moves.

Upgrade all `@qntx/wallet*` packages together: the host packages pin the exact `@qntx/wallet`
release their kernel was built for. `@qntx/wallet`'s root declarations now reference
`@qntx/wallet-chains/evm` (the session protocol types); a host that compiles with
`skipLibCheck: false` and did not install the optional `@qntx/wallet-chains` peer adds it.

## What users lose on upgrade

The 0.14.0 → 0.14.1 upgrade keeps every vault, backup and engine store as it is (the vault stays
at format 6). The 0.13.0 → 0.14.0 upgrade is not data-preserving. Plan the release around this
table and tell users before they update: a user who cannot produce their mnemonic, their passkey or
a post-upgrade backup loses the wallet.

| Data                                                                                                                                                  | 0.13.0 location                                                                               | After the upgrade                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mnemonic wallets (and their BIP-39 passphrase)                                                                                                        | vault, format 3                                                                               | The vault is `unsupported` and must be reset. Comes back only through `wallets.importMnemonic` with the phrase (and passphrase).                                                                                                                                                                                         |
| Passkey-derived wallets                                                                                                                               | vault                                                                                         | `wallets.restoreWithPasskey()` derives them again from the same passkey, as long as `rpId` and `walletSalt` are unchanged.                                                                                                                                                                                               |
| Imported private keys                                                                                                                                 | vault                                                                                         | Lost. Only a key the user exported before upgrading can be imported again.                                                                                                                                                                                                                                               |
| Nostr identities                                                                                                                                      | vault (derived per wallet)                                                                    | Derived from the wallet, so they come back with it; `nostr(wallet).discover` lists the public key of each identity index.                                                                                                                                                                                                |
| Vault factors (password, passkey factor, hardware key)                                                                                                | vault                                                                                         | Recreated when the new vault is created or restored.                                                                                                                                                                                                                                                                     |
| Cloud backup                                                                                                                                          | `qntx-wallet-backup-<id>.json`, envelope v1 (PBKDF2)                                          | Unreadable: `engine.backup.list()` skips these files and `restore` refuses them. Backup is off until the user enables it again, which writes a new file.                                                                                                                                                                 |
| Engine data: address book, account-group names, custom tokens, custom RPC endpoints, watch accounts, dApp connections, sign log, tracked transactions | engine IndexedDB / engine store, keyed by the vault's data key                                | The old engine database is refused `unsupported`/`older` and left in place until the host discards it after confirmation (§38); the new engine store starts empty under the new data key. Address-book entries and wallet/group names come back through `metaSync` when the host configures it; everything else is gone. |
| Transactions in flight at upgrade time                                                                                                                | tracked transactions                                                                          | They still land on chain and appear in `engine.history`, but they can no longer be sped up, cancelled or bumped with CPFP.                                                                                                                                                                                               |
| Spark                                                                                                                                                 | balance held by the Spark operators; exit-chain records and payment notes in the engine store | The balance comes back with the wallet; the locally stored exit-chain records and payment notes do not.                                                                                                                                                                                                                  |
| Blind-signing permission, app lock                                                                                                                    | engine account groups / —                                                                     | Off on the new vault.                                                                                                                                                                                                                                                                                                    |

## 1. Vault format and data reset

The vault format is 6 and the host/kernel protocol version 3. Vaults of any other format are
reported as `vault: { status: "unsupported", reason }` and never opened; there is no migration. On
the first launch after the upgrade, `reason: "older"` means the 0.13.0 vault: confirm with the
user, reset, then restore. (`reason: "newer"` means a newer build wrote the vault — update the app,
never reset. §38 covers the same direction for the backup envelope and the engine store.)

The vault anchor: a 21-byte record (`vectors/vault-anchor.json`) the kernel keeps outside the
vault store holds the vault's revision floor and the password failure counters that used to live
in `meta` (`record-failure` / `reset-failures` are gone from the store). A vault image whose
revision is below the floor — an older committed vault put back — reads `vault: "corrupted"`
before any unlock, and rewriting the vault store no longer resets the password backoff. Only a
revision the kernel sealed or authenticated under a session raises the floor; a new vault starts
above it and a reset raises it past the erased image. Nothing to wire: `@qntx/wallet-worker`
(Cache Storage on the Web, the main thread on Node) and `@qntx/wallet-native` (iOS keychain item
`qntx-wallet.anchor`, Android Keystore aliases `qntx-wallet.anchor.*`) supply it. Do not clear
these items yourself, and do not restore the vault store from a copy: a restored older vault is
`corrupted` by design — recover it with a reset and a restore from the mnemonic, passkey or cloud
backup. SECURITY.md states what each host can and cannot detect.

`vault.reset()` of an open, healthy vault now needs that vault's live session; a locked or
unhealthy one resets without a session. On React Native the reset still asks for the device
owner's verification, and fails `verification-unavailable` without a lock screen.

[`tests/migration/vault-reset.ts`](tests/migration/vault-reset.ts):

```ts
import type { Wallet } from "@qntx/wallet";

/**
 * A 0.13.0 vault is format 3, which this release reports as `unsupported` with reason `older` and
 * never opens. The only way forward is a reset followed by a restore from the user's mnemonic,
 * passkey or a backup made after the upgrade — confirm with the user first, because the reset
 * erases every wallet and key. A `newer` vault means "update the app" — never reset it.
 */
export async function replaceUnsupportedVault(
  wallet: Wallet,
  confirmErase: () => Promise<boolean>,
): Promise<"reset" | "kept"> {
  const { vault } = wallet.getSnapshot();
  if (vault.status !== "unsupported" || vault.reason !== "older" || !(await confirmErase())) {
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
- The prices (`POST /v1/prices/:family`) and history (`POST /v1/history/:caip2`) features need that
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
  `WalletEngine["spark"]` instead. Build controllers only through `createWalletEngine`: the
  exported controller classes' constructor options changed (for example `AssetsController` requires
  `chains`, `gateway`, `fetch` and `now`; `SparkControllerOptions.random` is gone).
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
- The keystore contract gains the required `platform: "ios" | "android"` — `bindNativeKeystore`
  rejects any other value. The kernel bounds every verification prompt to the platform's dialog
  (`PROMPT_BOUNDS`: iOS 8 lines / 400 code points, Android a 60-code-point title and 12 lines /
  640 code points); a prompt that cannot fit shows the blind title and a line that counts what it
  withheld — never clipped text.
- Only one native kernel may be live per process: `destroy()` the previous wallet before creating
  another, or creation fails `integrity`.
- On every platform, `WalletSnapshot` / `StatusPayload` gain the required fields `appLock`,
  `verification` and `blindSigning` (the Web reports `appLock: true`), and the vault API gains
  `enrolVerification`, `setAppLock` and `setBlindSigning`. Hand-written snapshot literals and
  `Wallet` test doubles must add them.

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
  built-in tokens) claims in a shape the wallet does not decode, such as an ERC-4494 `Permit`; a
  Seaport order with more than `ORDER_ITEMS` (8) offer or consideration items; an unrecognised
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
versions above 1 are refused (v1 is new, §20). The engine's own Wallet Standard handler already
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
A refusal check that itself fails —
the follow-up lookup of whether the network already holds the bytes — resolves `unknown`, not
`failed`: the row stays `submitted`.

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
- On React Native the backup password never reaches the main runtime: enable and restore pass
  `{ kind: "password" }` with no `password` field and the kernel collects the entry through the
  native secure input (`SecureInput`, §30) — twice on enable, re-asking on a mismatch or a
  sub-12-code-point entry. A `password` string is refused `unsupported` there, and omitting it on
  Web or Node is refused the same way (no secure input exists). `BackupFactorInput`'s password
  arm is `{ kind: "password"; password?: string }`; `backupPasswordStrength` runs only where a
  password is present, so on React Native nothing is rated — the kernel's minimum applies and its
  re-ask labels show as-is.
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
`PricesState.errors` marks an asset `unpriced` (no price now; may resolve on the next fetch) or
`unsupported` (the gateway has no price coverage for it; its stored quote is dropped): render the
latter permanently absent, not retryable. Hidden tokens are neither priced nor valued
([`tests/migration/unsupported.ts`](tests/migration/unsupported.ts)).

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

Price requests are partitioned by chain family. `POST /v1/prices` is now
`POST /v1/prices/:family` (`evm`, `solana`, `bitcoin`, `tron`), and a body naming another
family's asset is `400 invalid-request`. The engine sends one request per family under that
family's client id, so the held asset set no longer links the gateway scopes; assets no family
covers are not sent and report `unsupported`. Deploy the gateway with the engine, and forward the
four routes in any proxy or allow-list in front of it
([`tests/migration/price-scopes.ts`](tests/migration/price-scopes.ts)).

## 10. History

`engine.history` lists one account group's activity newest first, received transfers included,
from Esplora (all four Bitcoin templates), Solana RPC, the Spark operators and the gateway (EVM).
Locally tracked sends fold into the matching chain entry. A gateway EVM entry is `verified` only
after it was checked against RPC; show `flags` (`zero-value-transfer`, `lookalike-counterparty`,
`token-impersonation`, `suspicious-token-symbol`, `chain-mismatch`) as warnings and never offer a
history counterparty as a known recipient. `truncated` names the networks whose provider pages
dropped entries that could not be paged — show a gap notice while it is non-empty. `unsupported`
names the networks the gateway has no history for at all — show a "no history for this network"
notice, not a load error. `verified` means chain-proven from a host endpoint: entries read only
through the gateway are never verified, and neither are EVM entries of an account that has code
(an EIP-7702 delegation included) unless the transaction reverted.

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
- Bitcoin balance reads follow BIP-44 account discovery: the change chain of a template whose
  receive chain has no transactions is not walked, except `btc.bip84`, which receives the change of
  every `btc.bip44` / `btc.bip49` send. A seed another wallet used only on such a change chain no
  longer shows that balance. Templates found unused are re-scanned every 10 minutes; in between
  their `sources` entry reports zero.
- UTXOs on taproot addresses or worth at most 20,000 sat are `protected` as possible inscription or
  rune carriers: sends do not pick them, the balance counts them in `protected` (0.13.0 named it
  `AccountBalances.frozen`), and a dApp PSBT spending one raises
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
  until it resolves. A new payment with the same kind, receiver and amount (and token) as an
  `unknown` one fails with category `duplicate` (`error.payment` is the earlier record): offer to
  open that payment instead of sending again. Retrying the same request is unaffected.
- A sats payment is `failed` only when the operator lists its transfer as expired or returned; an
  id the operator does not list stays `unknown` at any age. A shortfall fails `insufficient-funds`
  before anything is recorded.
- `engine.spark.archivePayment(account, id)` gives up an open token payment the operator can never
  answer for (its spent outputs were never reported); ask the user first. The record keeps its
  history entry (`pending`, flag `unresolved`, `SparkPaymentState` `archived`) and stops blocking
  new sends.
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
import { requiredAcknowledgement, SparkControllerError } from "@qntx/wallet-engine";
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

/** `SparkErrorCategory` gained `duplicate` — an unresolved open record holds the same intent. */
// eslint-disable-next-line typescript/consistent-return -- the switch is exhaustive; a new category fails typecheck
export function sparkErrorMessage(error: unknown): string {
  if (!(error instanceof SparkControllerError)) {
    throw error;
  }
  switch (error.category) {
    case "insufficient-funds":
      return "not enough balance";
    case "duplicate":
      return "this payment is still unresolved — wait for it or archive it";
    case "network":
      return "the operator did not answer";
    case "approval-required":
      return "approval required";
    case "rejected":
      return "the payment was rejected";
    case "unknown":
      return "the payment's outcome is unknown";
    case "internal":
      return "an internal error";
  }
}

/**
 * A token send whose broadcast failed before its spent output ids were known can never be answered
 * for — `archivePayment` gives it up after the user confirms. The record stays visible: state
 * `archived`, history status `pending` with the `unresolved` flag, and it never blocks a resend.
 * Operator history can still replace it later.
 */
export function archiveDeadPayment(
  engine: WalletEngine,
  ref: SparkAccountRef,
  payment: SparkPaymentRecord,
): void {
  const key = `${ref.walletId}:${String(ref.groupIndex)}:${ref.network}`;
  const state = engine.spark.getState().accounts[key]?.payments?.[payment.id]?.state;
  if (state === "unknown") {
    engine.spark.archivePayment(ref, payment.id);
  }
}

/** `SparkPaymentState` gained `archived`; hosts switching on it must add the case. */
// eslint-disable-next-line typescript/consistent-return -- the switch is exhaustive; a new state fails typecheck
export function sparkStateLabel(state: SparkPaymentState): string {
  switch (state) {
    case "submitted":
      return "submitted";
    case "unknown":
      return "outcome unknown";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "archived":
      return "archived — will never resolve";
  }
}
```

## 13. Removed APIs

| Removed                                                                                                                | Use instead                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `InitialFactor` `{ kind: "hardware" }`, `factor` on React Native create/import/restore                                 | nothing — React Native chooses its factors                                              |
| `UnlockFactor` as a `verify` type                                                                                      | `VerifyFactor`                                                                          |
| `WalletErrorCode` `no-device-credential`                                                                               | `verification-unavailable`                                                              |
| `backup.disable()`                                                                                                     | `backup.disable(verify)`                                                                |
| `requests.approve(id, method, verify)`                                                                                 | `requests.approve(id, method, { verify, acknowledged })`                                |
| `AccountTreeController.setBlindSigning` / `blindSigning`, `AccountGroup.blindSigning`                                  | `wallet.vault.setBlindSigning`, `snapshot.blindSigning`                                 |
| `AssetsController.refreshBitcoin(xpub, network)`                                                                       | `refreshBitcoinGroup(group, network)`                                                   |
| `WalletEngine.transactions.prepare*`                                                                                   | `engine.requests.prepare`                                                               |
| `engine.transactions.batchById`, `delegationState`                                                                     | `engine.transactions.txById` per transaction, `engine.delegation`                       |
| `engine.spark.setAccounts`, `inspect`, `claimDeposit`, `lockAll`                                                       | `engine.accounts.select` / `discoverSpark`; deposits are claimed by the engine          |
| controller `init`, `lock`, `destroy`, `setStore`, `reconcile`, `trigger`, `store.setState` on engine members           | nothing — the engine owns controller lifecycle and state                                |
| `engine.requests.invalidateOrigin`                                                                                     | `engine.connections.invalidateOrigin` (what `createBrowserBridge` calls)                |
| `engine.connections.request`, `authorize`, `touch`                                                                     | nothing — dApp-side steps run inside the provider handlers                              |
| `engine.accounts.exportMeta` / `mergeMeta`, `engine.addressBook.merge` / `syncEntries`                                 | `engine.metaSync`                                                                       |
| `engine.networks.ensClient`, `independentClient`, `independentEnsClient`, `independentSolanaRpc`, `independentEsplora` | `engine.names.resolve`; cross-checks run inside the engine                              |
| `AccountBalances.frozen` (Bitcoin)                                                                                     | `protected`                                                                             |
| `TrackedTransaction.evm.raw`                                                                                           | `TrackedTransaction.raw`                                                                |
| `EngineOptions.gateway.installId`                                                                                      | nothing                                                                                 |
| `ConnectionController.setActiveGroup`, `activeGroup`, `accounts`, `solanaAccount`, `bitcoinAccounts`, `nostrAccount`   | `engine.accounts.select`, `connections.sessionAccounts`, `connections.nostrIdentity`    |
| `SolanaWalletHandler.solanaAccountsChanged`, `BitcoinWalletHandler.bitcoinAccountsChanged`                             | the handlers' own `change` events                                                       |
| `ProviderInfo.uuid`                                                                                                    | nothing                                                                                 |
| `SparkControllerOptions.random`                                                                                        | nothing                                                                                 |
| `EngineErrorCode` `integrity`                                                                                          | an unreadable row reads as absent                                                       |
| gateway contract `INSTALL_ID_HEADER`, `installId`, `InstallId`                                                         | `CLIENT_ID_HEADER`, `clientId`, `ClientId`                                              |
| `ChainErrorCode` `fee-payer-mismatch`                                                                                  | nothing — any required signer may sign                                                  |
| `SafeTransaction.gasToken`, `refundReceiver`                                                                           | `SafeTransaction.refund` `{ receiver?, gasPrice, amount }`                              |
| `solana-core-send` request method                                                                                      | `solana-nft-send`                                                                       |
| `CloudStore.available()`                                                                                               | `CloudStoreError` from `list()`                                                         |
| `trade.twap` (Hyperliquid TWAP order placement)                                                                        | nothing — a TWAP's slices carry no price the kernel can meter; `trade.twapCancel` stays |

## 14. New error codes

| Where                            | Code                                                                                                   | Meaning                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WalletError.code`               | `verification-unavailable`                                                                             | React Native: no factor can verify (no lock screen). No prompt was shown.                                                                                                                       |
| `WalletError.code`               | `blind-signing-disabled`                                                                               | A blind request while the vault setting is off. No prompt was shown.                                                                                                                            |
| `BackupControllerError.category` | `weak-password`                                                                                        | The backup password is too easy to guess.                                                                                                                                                       |
| `BackupControllerError.category` | `auth-required`, `quota`                                                                               | The cloud needs an interactive consent; the cloud storage is full (§28).                                                                                                                        |
| `SparkControllerError.category`  | `unknown`, `duplicate`                                                                                 | `unknown`: the payment may have committed (`error.payment` is its record). `duplicate`: an unresolved payment with the same intent exists (`error.payment`).                                    |
| engine request errors            | `AcknowledgementRequiredError`, `BlindSigningDisabledError` (now on every blind request, at `approve`) | See sections 4 and 5.                                                                                                                                                                           |
| `RiskFinding.code`               | `bitcoin-frozen-input` (danger)                                                                        | A dApp PSBT spends a user-frozen outpoint.                                                                                                                                                      |
| `RequestStage`                   | `signed`                                                                                               | Signed, not yet submitted: no longer invalidated.                                                                                                                                               |
| EIP-1193 provider                | `-32005`                                                                                               | An `eth_getLogs` filter over the bounds.                                                                                                                                                        |
| gateway                          | `outcome-unknown` (`502`), `too-costly` (`413`), `unsupported` (`404`)                                 | A broadcast whose outcome is unknown, never retried on another provider; one request costing more than a client's share window (split it); no coverage for this network or asset (never retry). |
| `ChainErrorCode`                 | `invalid-signature`                                                                                    | An assembler refused a signature that does not verify under its task key.                                                                                                                       |
| engine errors                    | `TronThrottledError` (`retryAfterMs`), `SolanaClusterBindingError` (`reason`)                          | See sections 17 and 20.                                                                                                                                                                         |
| `WalletError.code`               | `device-required`, `device-locked`, `device-app-closed`, `device-rejected`, `wrong-device`             | A hardware wallet needs its device (§24): pair/accounts first, unlock it, open the wallet app, approve on device, check the fingerprint.                                                        |

[`tests/migration/error-codes.ts`](tests/migration/error-codes.ts):

```ts
import type { WalletErrorCode } from "@qntx/wallet";
import type { BackupErrorCategory, EngineErrorCode, SparkErrorCategory } from "@qntx/wallet-engine";

/**
 * Exhaustive maps: adding or removing a code fails this file, so the list in MIGRATION.md stays
 * complete. New in this release: `verification-unavailable`, `blind-signing-disabled`
 * (`no-device-credential` is gone), the seven `card-*` codes; `weak-password`; `auth-required`;
 * `quota`; `unknown`; `EngineErrorCode` lost `integrity`; `device-required`, `device-locked`,
 * `device-app-closed`, `device-rejected`, `wrong-device`; `app-lock-required`, `limit-exceeded`
 * (session metering).
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
  "card-not-genuine": true,
  "card-id-mismatch": true,
  "card-erased": true,
  "card-locked": true,
  "card-tampered": true,
  "card-fault": true,
  "card-unsupported": true,
  "app-lock-required": true,
  "limit-exceeded": true,
  crashed: false,
  "device-required": true,
  "device-locked": true,
  "device-app-closed": true,
  "device-rejected": true,
  "wrong-device": true,
};

export const BACKUP_ERROR_IS_NEW: Readonly<Record<BackupErrorCategory, boolean>> = {
  cloud: false,
  conflict: false,
  unavailable: false,
  "weak-password": true,
  "auth-required": true,
  quota: true,
};

export const SPARK_ERROR_IS_NEW: Readonly<Record<SparkErrorCategory, boolean>> = {
  network: false,
  "approval-required": false,
  "insufficient-funds": false,
  rejected: false,
  unknown: true,
  duplicate: true,
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
- Secrets own their buffers: a request whose secret field (`SECRET_FIELDS` from
  `@qntx/wallet/protocol`) shares memory with another field fails `invalid-input`.
  `@qntx/wallet` already sends every secret in a fresh buffer; a host that posts kernel requests
  through its own transport copies them the same way
  ([`tests/migration/secret-buffers.ts`](tests/migration/secret-buffers.ts)).
- An `eip7702` authorization with `chainId` 0 — the chain-universal form that replays on every
  chain — is refused before any prompt, and `eip155` ids parse only in canonical form
  (`eip155:0`, `eip155:01` are refused).

## 16. Built-in networks and fee model

### `NetworkInfo.opStack` → `NetworkInfo.feeModel`

`NetworkInfo` (exported from `@qntx/wallet-engine`, `@qntx/wallet-engine/connect` and
`@qntx/wallet-engine/gateway/contract`) no longer has `opStack?: true`. Every EVM entry carries
`feeModel`; `FeeModel` and `GasPricing` are exported from `@qntx/wallet-engine` and
`@qntx/wallet-engine/gateway/contract`:

```ts
export type GasPricing = "eip1559" | "legacy";
export type FeeModel =
  | { kind: "execution"; pricing: GasPricing }
  | { kind: "op-stack"; pricing: GasPricing; operatorFee: boolean; tokenRatio: boolean }
  | { kind: "scroll"; pricing: GasPricing };
```

OP Stack and Scroll networks charge an L1 data fee; legacy-priced networks (opBNB, Fraxtal) sign
type-0 transactions at `eth_gasPrice`, so show a gas price rather than EIP-1559 caps. Treat an
unknown future `kind` as "charges something beyond gas", not as `execution`. Code that constructs
`FeeModel` literals (test fixtures) must set every required field.

[`tests/migration/fee-model.ts`](tests/migration/fee-model.ts):

```ts
import type { FeeModel, GasPricing, NetworkInfo } from "@qntx/wallet-engine";

/** What a network charges beyond execution gas: nothing, an L1 data fee, or data plus operator fee. */
export function describeExtraFee(
  network: NetworkInfo,
): "none" | "l1-data" | "l1-data-and-operator" {
  const model: FeeModel | undefined = network.feeModel;
  switch (model?.kind) {
    case "scroll":
      return "l1-data";
    case "op-stack":
      return model.operatorFee ? "l1-data-and-operator" : "l1-data";
    default:
      return "none";
  }
}

/** Chains priced "legacy" sign a type-0 transaction at eth_gasPrice; EIP-1559 chains use fee caps. */
export function buildsLegacy(network: NetworkInfo): boolean {
  const pricing: GasPricing = network.feeModel?.pricing ?? "eip1559";
  return pricing === "legacy";
}
```

### `fee.l1Data` is a maximum

`DisplayIntent.fee.l1Data` on OP Stack and Scroll networks is an upper bound like `fee.max`: the
oracle's L1 data-fee estimate × (9/8)³, rounded up, plus the operator fee at the full gas limit
(Mantle: multiplied by `tokenRatio()`). Displayed maximum fees and the `fee-exceeds-amount` check
move up accordingly; the fee actually charged is unchanged. Label `l1Data` a maximum, not an
estimate. The bound is re-read at approval and, when the approval read is older than one L1 slot,
before broadcast: `approve` can fail with "the L1 data fee rose — start over"; prepare the same
request again ([`tests/migration/l1-fee-bound.ts`](tests/migration/l1-fee-bound.ts)).

### More built-in networks

The EVM table grows from 8 mainnets + 8 testnets to 41 mainnets + 26 testnets, appended after the
existing entries (existing positions do not move); TRON adds three more networks (§17).
`BUILT_IN_NETWORKS` (new `@qntx/wallet-chains/networks` entry) is the single table. Hosts that
hard-code the number of networks, index the array by position, or render every network
unconditionally must filter by `family`, by `testnet` and by what `engine.networks.enabled()`
reports (networks with an endpoint or served by the gateway). Signing chain ids still come only
from the table; `wallet_addEthereumChain` / `wallet_switchEthereumChain` for ids outside it answer
4902, and for a listed but disabled network say that it must be enabled in the wallet.

### Token table roles

`EvmToken` gains an optional `role: "native-alias" | "wrapped-native"`. Native-alias rows (Celo
CELO, Arc USDC, Stable USDT0 and their testnets) are never returned as token balances; a host that
iterates `evmTokenTable` itself to read balances must skip them or it counts the native coin twice.
Wrapped-native rows (WETH, WBNB, WPOL, … on 24 networks) appear as ordinary token balances, and
`deposit()` / `withdraw(uint256)` calls to them are described as a `swap` with
`verifiability: "full"`.

## 17. TRON

TRON is a fourth chain family across `@qntx/wallet-chains`, `@qntx/wallet` and
`@qntx/wallet-engine`. Compiled snippets: [`tests/migration/tron.ts`](tests/migration/tron.ts)
(sends, staking, fees, account view) and
[`tests/migration/tron-dapp.ts`](tests/migration/tron-dapp.ts) (in-app browser).

### Closed unions

Exhaustive `switch`es and `Record<…>` maps over these unions need a `"tron"` case:
`ChainFamily`, `NetworkMeta.family`, `AccountRef` (imported `family`), `KeyInfo.family`, the
`keys.import` family parameter, `ChainTemplate` (`"tron.bip44"`), `ChainAccount`,
`ChainSignRequest` / `ChainSignResult` (`tron.transaction`, `tron.message`, `tron.typed-data`),
`EngineFamily`, `NetworkInfo.family`, `TrackedTransaction.family`, `HistoryEntry.family`,
`WatchAccount.family`, `AddressFamily`, `GatewayScope` and the sign-log family. A TRON private key's
text form is 64 hex characters without `0x`.

- `NetworkInfo.family` is typed `EngineFamily`; code that assigned a `NetworkMeta` to a
  `NetworkInfo` must narrow the family first.
- `GatewayConfig.clientIds` has a `tron` entry. `gatewaySession` creates it; a host that builds
  `clientIds` by hand adds a fresh random 128-bit id. `GatewayConfig` and `GatewayScope` are
  exported from the package root.
- `RiskFinding.code` gains `contract-recipient`, `token-contract-recipient`,
  `token-recipient-empty` and `fee-limit-below-estimate`.

### Configuration

- Host `rpc` for `tron:728126428` / `tron:3448148188` lists full-node HTTP base URLs (for example
  `https://api.trongrid.io`), not JSON-RPC URLs. A custom endpoint is validated by its block 0 id.
- Behind the gateway alone, mainnet sends work and their prepares carry `reads-unverified`; testnet
  (Nile, Shasta) sends are refused with an error naming the missing `EngineOptions.rpc` entry,
  because a mainnet reference block would make a testnet signature valid on the mainnet. Configure a
  host endpoint for every TRON testnet you offer.
- A TRON transaction expires 60 s after it is built. An engine-built send is rebuilt in place at
  approval when less than 20 s remain; a dApp transaction is refused then ("the dApp must build it
  again").
- `TronFeeQuote` availability fields are `bigint` and `TronAccountView` counters are decimal
  strings: format them with the decimal helpers, never `Number()` them.
- A prepare whose pinned TRON reads stay throttled beyond the transaction's validity window rejects
  with `TronThrottledError` (`retryAfterMs`): retry after that delay.

### In-app browser

`BrowserBridgeOptions` requires a `tron` handler: pass `engine.tronWallet` next to `solana` and
`bitcoin`. The injected script also installs `window.tron`, `window.tronLink` and `window.tronWeb`
and announces TIP-6963 with the same `ProviderInfo`.

```text
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

- Connection requests may carry `namespace: "tron"`; `grant.network` must be an enabled TRON
  network and becomes the session's `tronNetwork`. `engine.connections.setTronNetwork(origin,
  network)` switches it from the host UI.
- Pending requests gain `tron-sign` (dApp transaction, message, typed data), and `watch-asset` can
  name a TRC-20 token. A dApp transaction settles to a `TrackedTransaction` with
  `tron.dappSignature` set (the dApp broadcasts it; the wallet tracks it); a message or typed data
  settles to a `SignatureResult`.
- `send` on TRON accepts `memo` (≤ 256 UTF-8 bytes, one line); other families throw.

## 18. Signing classification hosts may notice

Hosts do not parse kernel prompt text; this section lists what changes in `DisplayIntent` and in
which requests need the vault's blind-signing setting (§5).

### Closed unions and new fields

- `IntentWarning.kind` is the closed union `IntentWarningKind` (it was `string`). Code that switches
  on it gets exhaustiveness checking; code that constructs warnings with arbitrary strings no
  longer compiles. `IntentWarning.level` (`"danger"`) marks danger-level warnings.
- `IntentSummary` gains `"payout"`.
- New exports `BlindReason`, `isBlindIntent`, `messageBlindReason`, `messageTextHazard`,
  `hasHiddenCharacters`, `isEncodedBytes`, `displayExcerpt`, `ORDER_ITEMS` and the typed-data
  family types; `DisplayIntent` gains `blind`, `contract`, `programs`, `programAuthority`,
  `minimumReceived[].tokenAccount`, `hyperliquidDeposit` and `fiat24`; the typed-data
  `MessageContent` gains `fields`, `order`, `hyperliquid`, `polymarket`, `authorization`,
  `authority` and `farcaster`. A host that renders `DisplayIntent` itself should render them; a
  document carrying a decoded family has no generic `fields`.

[`tests/migration/message-text.ts`](tests/migration/message-text.ts),
[`tests/migration/typed-data-families.ts`](tests/migration/typed-data-families.ts) and
[`tests/migration/fiat24.ts`](tests/migration/fiat24.ts) compile against these types.

### Requests that are now blind

With blind signing off these fail with `blind-signing-disabled` (`BlindSigningDisabledError` at
`approve`):

- Text messages that are 32 bytes long, carry hidden or reordering characters, or encode raw bytes
  (`messageTextHazard`). They still decode as `{ kind: "text" }` and are shown under a line naming
  the hazard. EIP-712 / TIP-712 documents with such characters in a value, type name, field name or
  `primaryType` are blind the same way.
- Typed data that signs only hashes or opaque bytes (`typed-data-commitment`, e.g. ERC-1271
  wrappers such as `SafeMessage(bytes)`), near misses of a recognised family
  (`typed-data-variant`: `Permit*`, `SafeTx`, Seaport, Permit2, built-in-token contracts, the
  Hyperliquid and Polymarket domains), and documents of claimed off-chain order protocols that are
  not decoded (1inch with extensions, 0x v4, Blur, LooksRare v2, Bebop, Paraswap, Velora Delta,
  KyberSwap, OpenOcean, Odos).
- Undecoded System, Token, Token-2022, Stake or Associated Token instructions the signer signs
  (`core-instruction`), and undecoded Solana programs that receive the signer through writable
  lookup-table accounts or more than 12 writable accounts (`program-authority`).
- On Arbitrum One, calls to the CCTP TokenMessengerV2 other than a described Hyperliquid deposit
  (`cctp-destination`) and calls to the seven pinned Fiat24 contracts that are not a described
  Fiat24 action (`fiat24-function`). On every chain, a `personal_sign` text beginning with
  `I agree to access my profile.` or `I agree to access my Fiat24 profile.`
  (`fiat24-session-grant`) — the official Fiat24 dApp's sign-in through a dApp browser therefore
  needs blind signing.
- A TRON `AccountPermissionUpdateContract` (always blind, `tron-permission-update`), other
  unmodelled TRON contract types (`tron-contract`) and fields the wallet cannot show (`tron-field`).

### Requests that are now described

Seaport orders (up to `ORDER_ITEMS` = 8 items) and Safe transactions with their inner calls; 1inch
LOP v4, CoW Protocol, UniswapX and 0x gasless orders; EIP-3009 authorizations; Morpho Blue, Aave
credit delegation and Snapshot alias authorities (`partial`, summary `authorization`); Farcaster
signer keys; Snapshot votes; Hyperliquid user-signed actions and Polymarket orders; Raydium, Orca
Whirlpool and Meteora DLMM swaps; SPL `Transfer`, `Burn`, `Revoke` and Stake `Split` signed by the
account; Fiat24 transfers, payouts, swaps and top-ups (`partial` with Fiat24 warnings). An ERC-7821
batch carries its inner calls' warnings.

### Other signing behaviour

- `chains(wallet).sign` throws `integrity` when the kernel's result kind differs from the
  request's.
- PSBT inputs that previously failed only after approval — a taproot input without its internal
  key, with `tapLeafScript` / `tapMerkleRoot` or with a non-default sighash, a sighash outside the
  allow-list, scripts other than single-key P2PKH, P2SH-P2WPKH, P2WPKH or P2TR — are refused before
  the prompt (`invalid-input`; `ChainError` from `signBitcoinPsbt`).
- `ChainErrorCode` gains `invalid-signature` (an assembler refused a signature that does not verify
  under its task key; see §23).

## 19. Transaction tracking and dApp batch sends

Compiled snippets: [`tests/migration/stuck-transactions.ts`](tests/migration/stuck-transactions.ts),
[`tests/migration/batch-stopped.ts`](tests/migration/batch-stopped.ts) and
[`tests/migration/readonly-state.ts`](tests/migration/readonly-state.ts).

### Stuck and never-resent transactions

`dropped` is no longer produced by a timeout. EVM transactions end only on their receipt, a
replacement, or their nonce consumed without their receipt; Bitcoin transactions on inclusion, an
input spent by another confirmed transaction, or their own replacement confirming. A transaction
the network has not seen for 30 minutes stays `submitted` with `stuck: true`; offer `speed-up` /
`cancel` for it. A row with `rebroadcast: false` was recovered from a broadcast whose outcome never
settled: the wallet watches it but never resends it. Rows and call batches are not readable from
`engine.transactions` while the vault is locked; they return at unlock.

### dApp batch sends

Solana `signAndSendTransaction` returns the locally computed fee-payer signatures and Bitcoin
`signAndSendTransaction` the locally computed txids of what went out, never ids an RPC reports. A
batch that stops part-way carries `stopped`:

```ts
export type SignAndSendOutcome = {
  readonly stopped?: {
    readonly index: number; // input that did not go out
    readonly reason: "refused" | "not-sent";
    readonly error: string;
  };
};
```

`reason: "refused"` means the node rejected that input's bytes; `"not-sent"` means a local failure
kept it from being broadcast. The ids already submitted stay on `signatures` / `txids` — never
resubmit them. A failing first input still rejects the whole request. Each
`bitcoin:signAndSendTransaction` result entry is `{ txId, signedPsbt }`.

### Engine state snapshots are deeply read-only

Every controller's `getState()` (and `store.getState()`) on the `WalletEngine` facade returns a
deeply frozen snapshot typed `DeepReadonly<…>`. Code that edited a snapshot in place — `delete
state.txs[id]`, `rows.sort()`, assigning into `balances` — no longer compiles and throws a
`TypeError` at runtime. Copy first (`Object.values(…).toSorted(…)`, `{ ...state.txs }`).

### Durable nonces

A Solana durable-nonce transaction carries `durableNonce: { account, value }` and no
`lastValidBlockHeight`; it is never shown `dropped` by block height. No host change is required.

## 20. Solana: v1 transactions, cluster binding and drop proofs

Compiled snippets: [`tests/migration/solana-v1.ts`](tests/migration/solana-v1.ts) and
[`tests/migration/solana-binding.ts`](tests/migration/solana-binding.ts).

### v1 transactions

The injected provider advertises `supportedTransactionVersions: ["legacy", 0, 1]`, so Wallet
Standard dApps start sending SIMD-0385 v1 transactions (message first, signatures last, up to 4096
bytes); WalletConnect `solana_*` requests accept them too. A host that forwards the bytes unchanged
needs nothing; one that pre-checks size or parses the wire must accept the v1 envelope and the
4096-byte limit.

| 0.13.0                                                                                                                  | 0.14.0                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ChainError("unsupported")` "Solana transaction version 1 is not supported" (`normalizeSolana`, `parseCompiledMessage`) | v1 parses; versions ≥ 2 keep the error                                 |
| `ChainError("invalid-request")` "transaction exceeds the 1232-byte limit" for a v1 wire                                 | only above 4096 bytes ("… 4096-byte limit")                            |
| kernel `chain.sign` `invalid-input` for a v1 `solana.transaction`                                                       | signed under the vault's blind-signing policy, prompt as for legacy/v0 |

New refusals (`invalid-request` unless noted) are the cluster's own sanitize failures: unknown
config-mask bits (`unsupported`), a half-set priority-fee pair, an invalid heap size, duplicate
accounts, out-of-range indices, too many signatures, accounts or instructions, trailing bytes, and a
v1 request carrying `lookupTables`. `ParsedSolanaMessage["version"]` is `"legacy" | 0 | 1`; narrow
on `version === 1` to read `config`; every version carries `lifetimeToken`. The maximum fee of a v1
transaction is `5000 × signatures + config priority fee`; ComputeBudget instructions inside it
configure nothing.

### dApp transactions are bound to the session's cluster

A `solana-sign` transaction request (Wallet Standard or WalletConnect) reads the selected cluster
before the prompt: a recent blockhash must be valid there under the corroboration rule of a wallet
send, and a durable-nonce account must exist there holding exactly the message's nonce. Anything
else fails with `SolanaClusterBindingError` (`ChainError` `invalid-request`, `reason:
SolanaBindingReason`); show the reason and never offer to sign anyway. A devnet session no longer
signs transactions that are valid on mainnet.

### Accounts named through lookup tables are blind

An account the prompt names — a recipient, token destination, owner, authority, delegate or mint
— that resolves through an address lookup table cannot be verified against the signature: a v0
signature binds only the compiled message bytes, and the table contents a loaded index resolves
through are caller-supplied. Any recorded table substitution makes the intent blind with the new
reason `lookup-table-account`, and the prompt leads with a warning in both locales. Engine-built
transactions stay described: `compile()` asks the decoder which named accounts resolve through
tables, rewrites their lookup metas back to static ones, recompiles and asserts none remain —
other loaded accounts keep their table indexes.

### Endpoints and drop proofs

- Behind the gateway alone, Solana mainnet sends and bindings carry `reads-unverified`; devnet
  sends are refused with an error naming the missing `EngineOptions.rpc` entry.
- A user-set custom RPC is the primary endpoint, never its own corroborator: the host endpoints in
  `EngineOptions.rpc` cross-check it, else the gateway; with neither, the network is treated like a
  gateway-only one. `Independent` (the `NetworkController` cross-check client) gains
  `source: "host" | "gateway"`.
- A Solana transaction ends `dropped` only when a configured host endpoint proves the same drop, or,
  without one, after three consecutive polls spanning more than one blockhash processing age, and
  only from a node whose history reaches back before the submission. Expect rows to stay
  `submitted` longer, especially after time offline.

## 21. dApp origins: WalletConnect peers and in-engine apps

Compiled snippets: [`tests/migration/walletconnect.ts`](tests/migration/walletconnect.ts) and
[`tests/migration/sessions.ts`](tests/migration/sessions.ts).

`RequestOrigin` is now `{ kind: "internal" } | { kind: "app"; id: string } | DappOrigin`, and
`DappOrigin = BrowserOrigin | WalletConnectOrigin`; `ConnectionOrigin` and the `origin` of every
dApp request input accept a WalletConnect origin. An exhaustive `switch` over `origin.kind` needs
`"app"` and `"walletconnect"` cases:

- `walletconnect`: `origin.origin` is the session key `walletconnect:<topic>` (never a URL);
  `origin.url` and `origin.name` are the peer's self-declared metadata (show them as unverified);
  `origin.verify` is the Verify verdict. Use `dappUrl(origin)` wherever the host shows or checks the
  site. New `danger` risk codes `verify-mismatch` and `verify-threat`; `requiredAcknowledgement`
  includes them.
- `app`: a request an in-engine app opened (`@qntx/wallet-engine/apps`, §23). Show the app as the
  requester; it is not a web origin. Every app origin can prepare `evm.transaction` and
  `evm.fiat24-session` requests, so the host approval UI must render transactions for app origins,
  not only typed data (§29).

Related changes:

- `requests.prepare({ method: "evm-sign" })`: `origin` is optional. Without it the request is the
  wallet's own and only `evm.typed-data` is accepted.
- `engine.payments.parse` returns `{ kind: "walletconnect", uri }` for a `wc:` pairing URI. Route
  it to `walletConnect.pair(uri)` (§23).
- `@qntx/wallet-engine/walletconnect` moved its SDK packages to optional peers: a host using
  WalletConnect now installs `@reown/walletkit`, `@walletconnect/core`, `@walletconnect/types`
  and `@walletconnect/utils` itself (exact pins in `peerDependencies`; the WalletConnect Community
  License terms are summarised in the package README — read them before shipping).
- The injected Solana and Bitcoin providers reject a refused, expired or invalidated request with
  `4001` (a sign-in for another domain with `-32602`) instead of `-32603 internal error`. Code that
  treated `-32603` as "the user said no" must use `4001`.
- `engine.connections` gains `establishWalletConnect`, `previewAccounts`, `authorize` and `touch`;
  `ConnectionState` gains `ready`. Handler requests take an optional `network` that the in-app
  bridge never sets.
- `first-recipient` and `address-poisoning` now come from every request that moves value or grants
  authority — typed-data receivers, Seaport considerations, Safe destinations, swap and bridge
  settlement, staking, `solana-sign` transactions, `bitcoin-sign` PSBT outputs, approval and
  permission grantees, Spark cooperative exits. A request that arrived without findings can now
  carry them.

## 22. Gateway operators

The gateway is deployed by the operator, not published to npm; `apps/gateway/README.md` is the
runbook ("Operator runbook — first production deploy"). Deploy the gateway from this release
together with the apps (§2): the engine and gateway contracts are strict on both sides.

- Secrets: `COINGECKO_API_KEY` (prices), `TRONGRID_API_KEY` and `TATUM_API_KEY` (TRON) and
  `ANKR_API_KEY` (Arbitrum Nova, Taiko and Flare after dRPC) are required in production
  (`wrangler.jsonc` `secrets.required`; the deploy workflow checks them). Enable the new networks
  in the production Alchemy app and on the dRPC paid plan.
- New routes: `POST /v1/prices/:family` (one route per chain family — `evm`, `solana`,
  `bitcoin`, `tron`; a body naming another family's asset is `400 invalid-request`, an unknown
  family `404`), `POST /v1/history/:caip2`, `GET /v1/tokens/:caip2`,
  `GET /v1/eligibility` and `POST /v1/tron/:caip2/*`. A served network with no coverage answers
  `404 unsupported` (never retry); a covered network whose token list is not built yet answers
  `503 unavailable` with `Retry-After`. `pricesResponse` lists every asset in exactly one of
  `prices`, `missing` and `unsupported`.
- `/v1/eligibility` answers the `fiat24` row: `blocked` in the sanctioned set, `close-only` where
  Fiat24's `/countries` bans the nationality (US and territories, RU).
- `POST /v1/approvals/:caip2` returns display-only EVM approval candidates (token, spender or
  operator, block) from the owner's Approval/ApprovalForAll and Permit2 events — the engine
  confirms every row on chain. Served only where Alchemy allows an unbounded `eth_getLogs` range;
  `404 unsupported` elsewhere. One `eth_blockNumber` plus four `eth_getLogs` per call, metered on
  the `alchemy` account.
- `POST /v1/nfts/{items,item,collection,floor}/:caip2` serve display-only NFT data (Alchemy NFT
  API on EVM, DAS on Solana); `404 unsupported` on uncovered networks, floor EVM-only.
  `GatewayOptions.nfts.cache` is required (`PriceCache` / `priceCacheOf` are the shared
  `EdgeCache` / `edgeCacheOf(origin, open)`).
- Push notifications (§27): the deploy adds Durable Object migration `v2` (`PushObject`), the
  `PUSH` binding and the `PUSH_LIMITER` rate limit — non-rollbackable (`deploy-check
  rollback-plan`). Push stays off until `PUSH_SEAL_KEY`, at least one sender (`APNS_*` or
  `FCM_SERVICE_ACCOUNT`) and the Alchemy webhook secrets (`ALCHEMY_NOTIFY_TOKEN`,
  `ALCHEMY_WEBHOOKS`) are set (`apps/gateway/README.md` "Push notifications").
- A deployed gateway requires `cf-connecting-ip` (Cloudflare and `wrangler dev` set it); in-process
  embeddings pass `clientAddress: "optional"` to `createGateway`. `GatewayOptions` requires `auth`
  and `prices: { cache, coingecko? }`.
- Every upstream call is priced in its provider's unit and charged to the client's share of that
  provider account and to a gateway-wide budget (`PROVIDER_BUDGET` Durable Object); account rows
  carry `clientShare` and `source`. An ambiguous broadcast answers `502 outcome-unknown` and is never
  retried on another provider.
- `x-gateway-provider` (`PROVIDER_PIN_HEADER`) pins a JSON-RPC or TRON node request to one
  provider; CORS allows it. On a TRON indexer path or the Esplora route it is a `400`. The Solana
  allow-list drops `getBlock` and gains `getVoteAccounts`, `getStakeMinimumDelegation` and
  `getFirstAvailableBlock`.
- The deploy workflow refuses an automatic rollback across a Durable Object migration and alerts
  instead.

## 23. New opt-in surfaces

Nothing to migrate: these did not exist in 0.13.0 and a host that does not import them bundles
nothing new. Each has a compiled example and a README section.

| Surface                                                                                                                          | Example                                                                                                                                                                                                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@qntx/wallet-engine/walletconnect`                                                                                              | [`walletconnect.ts`](tests/migration/walletconnect.ts)                                                                                                                                                                                             | WalletConnect Community License: check the commercial terms before shipping it.                                                                                                                                                                                                                                                                                                                               |
| `@qntx/wallet-engine/apps`, `/apps/hyperliquid`, `/apps/polymarket`                                                              | [`hyperliquid.ts`](tests/migration/hyperliquid.ts), [`hyperliquid-corrections.ts`](tests/migration/hyperliquid-corrections.ts), [`polymarket.ts`](tests/migration/polymarket.ts), [`polymarket-outcome.ts`](tests/migration/polymarket-outcome.ts) | `createApps({ …, apps: [hyperliquid(…), polymarket(…)] })` needs the gateway's `/v1/eligibility`. Order outcomes can be `unknown`: never re-place, wait for `trade.corrections`; a Polymarket `canceled` carries `making` (filled before the cancel). The Polymarket builder secret stays on your server behind `builder.sign`.                                                                               |
| App providers (`AppDefinition`)                                                                                                  | [`app-provider.ts`](tests/migration/app-provider.ts)                                                                                                                                                                                               | Engine README "Writing an app provider".                                                                                                                                                                                                                                                                                                                                                                      |
| `@qntx/wallet/sessions`                                                                                                          | [`sessions.ts`](tests/migration/sessions.ts)                                                                                                                                                                                                       | Kernel-held session keys (`session-key` vault records), never in a backup. Once one exists, a 0.13.0 build reports the vault `unsupported`: delete sessions before downgrading. `sessions(wallet).sign` rejects `integrity` unless the signature is the session key's. `EligibilityResponse["apps"]`: an absent app is unknown. `create`/`open` verify and the scheme's `limits` bound every signature (§31). |
| Fiat24 session grants (`evm.fiat24-session`)                                                                                     | [`fiat24.ts`](tests/migration/fiat24.ts)                                                                                                                                                                                                           | Build the grant as this structured request; never sign the text yourself. Arbitrum One only, `0 < deadline − now ≤ 1200` s. The engine's dApp path refuses this kind.                                                                                                                                                                                                                                         |
| `@qntx/wallet/hardware` (`hardware(wallet)`), `WalletInfo` `custody` union                                                       | [`hardware-wallets.ts`](tests/migration/hardware-wallets.ts)                                                                                                                                                                                       | Hardware signers (§24): Keystone 3 Pro over QR — `pair`, `accounts`, `sign`, `verifyAddress` through a host `DeviceIo`. `WalletInfo.custody` is breaking for every host.                                                                                                                                                                                                                                      |
| `engine.approvals`                                                                                                               | [`approvals.ts`](tests/migration/approvals.ts)                                                                                                                                                                                                     | Approval inventory and revocation (§25): cross-checked on-chain rows, one request per revocation. Gateway operators deploy `POST /v1/approvals/:caip2`.                                                                                                                                                                                                                                                       |
| `engine.nfts`                                                                                                                    | [`nfts.ts`](tests/migration/nfts.ts)                                                                                                                                                                                                               | NFT inventory and transfers (§26): display-only gateway data, `evm-nft-send` `items` and `solana-nft-send` through requests. Gateway operators deploy the four `/v1/nfts/*` routes.                                                                                                                                                                                                                           |
| `engine.notifications`, `@qntx/wallet-engine/push`                                                                               | [`push-notifications.ts`](tests/migration/push-notifications.ts)                                                                                                                                                                                   | Push notifications (§27): per-wallet subscriptions, `openPush` for the notification extension; gateway PushObject deploy is non-rollbackable.                                                                                                                                                                                                                                                                 |
| `@qntx/wallet-native/cloud` (`createICloudStore`, `createGoogleDriveStore`), `@qntx/wallet-engine` `createGoogleDriveCloudStore` | [`cloud-store.ts`](tests/migration/cloud-store.ts)                                                                                                                                                                                                 | Cloud backup transports and versioned backup files (§28); `CloudStore` drops `available()` — failures are typed `CloudStoreError`s.                                                                                                                                                                                                                                                                           |
| `@qntx/wallet-engine/apps/fiat24`                                                                                                | [`fiat24-app.ts`](tests/migration/fiat24-app.ts)                                                                                                                                                                                                   | The Fiat24 app (§29): resumable flows, session and API reads; every write is one app-attributed request. Its REST API needs an injected `fetch` (no CORS).                                                                                                                                                                                                                                                    |
| Signing plans (`plan*` / `assemble*`, `*/sign` task signers)                                                                     | [`signing-plans.ts`](tests/migration/signing-plans.ts)                                                                                                                                                                                             | For hosts driving an external digest signer. Software-wallet signatures are byte-identical.                                                                                                                                                                                                                                                                                                                   |

## 24. Hardware signers (Keystone 3 Pro over QR, Ledger and OneKey over USB/Bluetooth)

Compiled snippets: [`tests/migration/hardware-wallets.ts`](tests/migration/hardware-wallets.ts),
[`tests/migration/ledger.ts`](tests/migration/ledger.ts). Changes affect every host that reads
`WalletInfo` or switches on `WalletErrorCode`, and every host that wants hardware wallets.
Nothing changes in the vault format for software wallets; a `hardware-wallet` record joins the
vault alongside them.

1. **`WalletInfo` is a `custody` union.** The 0.13.0 shape is `VaultWalletInfo`
   (`custody: "vault"`); a paired device produces `HardwareWalletInfo` (`custody: "hardware"`,
   `device`, `fingerprint`, `model`, `firmware`). Every read of `origin`, `words`, `backup` or
   `passphrase` must narrow on `custody` first — `walletBadge` in the snippet. Anywhere a list of
   wallets feeds an action only a seed wallet can do (export mnemonic, passphrase, cloud backup),
   filter `custody === "vault"` instead of assuming the shape (`requiresSeed`).
2. **Five new error codes.** `device-required` (the kernel has no public material for the path —
   run `hardware().accounts` first), `device-locked`, `device-app-closed`, `device-rejected`,
   `wrong-device` (the answering device's fingerprint is not the wallet's — the user picked up a
   different unit). `deviceErrorHint` in the snippet maps them to host hints; the exhaustive map
   in `tests/migration/error-codes.ts` flags them as new.
3. **Seed-bound calls refuse cleanly.** For a hardware wallet `exportMnemonic`, Nostr key
   derivation and sync, Spark and `sessions.create` answer `unsupported`; `chain.sign` answers
   `device-required` (sign through the device instead); `wallet.accounts` answers
   `device-required` for a group the device has not exported yet. A host must not offer these on
   a `custody: "hardware"` wallet.
4. **Driving a device.** `@qntx/wallet/hardware` exports `hardware(wallet)` with one `start(op,
   { io, verify? })` per operation (`pair`, `accounts`, `sign`, `verify-address`), each taking a
   host `DeviceIo`, and returning a `SignerTask`: `observe` reports `exchange` steps, `cancel`
   ends the operation, `result` resolves with the operation's result. The kernel validates and
   decodes everything; the host only transports: for an air-gapped Keystone, `qrParts` produces
   the cyclic UR frames to animate and `qrReader` folds scanned frames back into the payload
   (`keystoneQrIo` in the snippet). A `sign` operation takes the same `verify` factor as
   `chains().sign` and its result passes the same verification. `pairKeystone` and
   `signOnDevice` show the two calls a host makes. An engine host wires the same transports once
   as `EngineOptions.deviceIo` and the engine's own signing paths run these operations under
   `engine.signers` (§32) — a host does not call `start` for an engine sign.
5. **Ledger.** `HARDWARE_DEVICES` gains `"ledger"`; an exhaustive switch over `HardwareDevice`
   needs the new arm. The kernel exchanges one APDU per `{ kind: "message", data }` request and
   the host frames it: `ledgerHidExchange(port, channel)` for USB (WebHID / RN HID — a
   `HidPort` that writes and reads 64-byte reports) or `await ledgerBleExchange(port)` for
   Bluetooth (Nano X, Stax, Flex), then `ledgerIo(apdu, signal)` turns either into the `DeviceIo`
   every `hardware(wallet)` call takes. Ledger has no secure channel: whatever carries the frames
   can read them, so prefer a transport the host itself controls and tell the user that the
   device screen is what they must check.
6. **Which Ledger app must be open.** `pair` needs the **Bitcoin** app (it is the only one that
   reveals the master fingerprint). `accounts` serves one chain family per call with that
   family's app open (Bitcoin, Ethereum, Tron, Solana); `sign` and `verifyAddress` need the
   request's app. A wrong or closed app is `device-app-closed`; ask the user to open the named
   app and retry.
7. **Ledger device settings.** A request the device can only blind-sign (EVM calldata, EIP-712, a
   Solana instruction the app does not decode, a TRON custom contract call, memo, personal
   message or TIP-712) fails `blind-signing-disabled` until the user enables the corresponding
   setting in that Ledger app (Ethereum/Solana "Blind signing"; Tron "Custom contracts", "Allow
   data", "Sign by hash").
8. **Unsupported on Ledger:** EIP-7702, raw (non off-chain-format) Solana messages, BIP-322
   message signing, PSBTs that sign inputs of more than one address type, and Bitcoin test
   networks — `unsupported` before any prompt.
9. **OneKey.** `HARDWARE_DEVICES` gains `"onekey"`; an exhaustive switch over `HardwareDevice`
   needs the new arm. `hardware(wallet).start({ kind: "pair", device: "onekey" }, { io })`
   resolves with a `HardwareWalletInfo` whose `device` is `"onekey"` and whose `model`/`firmware`
   are filled (`"classic1s"`/`"3.21.0"`, `"pro"`/`"4.21.0"`). The transport is byte-framed, not
   QR: a OneKey's `exchange` sees only `message` requests — `request.data` is one framed command
   the host writes verbatim; the device answers one framed message. `oneKeyHidExchange(port)`
   runs USB — 64-byte HID reports, the first carrying `3f 23 23` + BE u16 type + BE u32 payload
   length + 55 payload bytes, each continuation `3f`-prefixed with 63 — writing the request
   report by report and collecting reports until the announced payload length (the final
   report's padding may be stale; only the declared payload matters).
   `oneKeyBleExchange(port, mtu)` runs BLE — GATT service
   `00000001-0000-1000-8000-00805f9b34fb`, write characteristic `…0002…` (the same report
   sequence, split at or below `mtu`), notify characteristic `…0003…` whose notifications
   concatenate into a `9 + length` stream. A first chunk that is not a OneKey frame is
   `invalid-input`. `oneKeyIo(exchange)` adapts either into the `DeviceIo` shape;
   `oneKeyUsbIo`/`oneKeyBleIo` in the snippet show the wiring, `pairOneKey` the call.
10. **Driver interface (kernel-private; noted for downstream driver authors).**
    `Driver.display(request, plan, identity)` takes the record header's
    `{ fingerprint, model, firmware }`, and `SignContext.display` carries the value the user was
    prompted with — a driver whose display depends on model/firmware must refuse `sign` when the
    live device can no longer show what was confirmed.

## 25. Approvals inventory and revocation

Compiled snippet: [`tests/migration/approvals.ts`](tests/migration/approvals.ts). Additive for `@qntx/wallet-engine` hosts; gateway
operators deploy the new route. Nothing changes in the vault or the kernel protocol.

1. **Show the inventory per account and network.** `engine.approvals.load(account, network)`
   returns the view key; render `state.views[key]` and call `setVisible(true)` only while the
   screen is shown (see `showApprovals`). Label EVM and TRON lists "known approvals": indexers can
   miss spenders. Show `sources` (status and `at`) and the counters — `disputed` rows were hidden
   because the two endpoints disagreed, `unread` candidates could not be read.
2. **Revoke one request at a time.** `engine.approvals.revoke(key, rowId)` prepares an ordinary
   request; approve it through your existing approval UI. Do not prepare several revocations at
   once — nonces are reserved at commit, so every request after the first would go stale. Use
   `revokeBatch` only for EVM rows on an account delegated to the wallet's delegator, or for
   Solana token accounts. Never remove a row yourself: it disappears after the next chain read.
3. **Rows with `revoke: "none"`** (a foreign close authority, a mint authority, a stake authority,
   a TRON permission key) cannot be removed from this wallet — show them read-only with the
   reason. Session keys under `view.sessions` are revoked through the app that owns them
   (`AppsController` `disable` with `revoke: true`).
4. **Kernel prompt lines.** `ApprovalChange` has two more variants (`approval-cleared`,
   `delegate-revoked`). A host that switches over `ApprovalChange.kind` must handle them.
5. **Venue-held authorities.** `AppsController.authorities(group)` lists the standing
   authorities an app's venue holds over the group's funds outside the approvals inventory.
   On-chain authorities carry their CAIP-2 `network`; a venue-ledger authority names the venue
   network its kernel sessions use instead — the Hyperliquid builder-fee approval lives on
   HyperCore, so its `network` is `Mainnet` | `Testnet`, not a chain (`revoke: "none"`; the app
   removes it only by signing `approveBuilderFee` to zero, which no engine surface reaches).
   Polymarket's trading approvals on the deposit wallet (pUSD spenders and ERC-1155 operators on
   Polygon) are reported `revoke: "none"` too — disabling the app leaves them on-chain. Fiat24's
   owner-EOA allowances on Arbitrum One (cash-token card caps, deposit top-ups, the F24 account
   grant) are `revoke: "approvals"`: ordinary allowances the approvals inventory revokes. One
   app's failed read lands as its own `{ app, error }` row.

[`tests/migration/app-authorities.ts`](tests/migration/app-authorities.ts):

## 26. NFT inventory and transfers

`engine.nfts` lists an owner's NFTs on one network from the gateway. The inventory is
display-only: show it, never build anything from it — a transfer re-reads ownership from chain and
refuses what the chain does not back. Flagged items (`spam` non-empty) are `hidden` by default;
`setHidden(network, id, "shown")` pins one visible, `"hidden"` hides it, `undefined` clears the
override. Media are descriptors: render `https`, `ipfs` (rewrite to your IPFS gateway), `ar` and
`data:` URLs in an image element or a sandbox that runs no script — never as a document when
`active` is true. Names and descriptions are plain text.

`evm-nft-send` now takes `items` (one entry for ERC-721; up to 10 distinct ERC-1155 ids, sent as
one batch). `solana-core-send` is gone: `solana-nft-send` takes a Core asset or an SPL NFT mint.
A refused transfer throws `NftTransferError` with a `reason`.

[`tests/migration/nfts.ts`](tests/migration/nfts.ts):

```ts
import { NftTransferError } from "@qntx/wallet-engine";
import type {
  AccountRef,
  NftInventory,
  NftMedia,
  PendingRequest,
  WalletEngine,
} from "@qntx/wallet-engine";

/** Pages one owner's inventory; `cursor === null` ends it, `truncated` means show a gap notice. */
export async function loadInventory(
  engine: WalletEngine,
  owner: string,
  network: string,
): Promise<NftInventory> {
  const first = await engine.nfts.load(owner, network);
  let inventory = first;
  while (inventory.cursor !== null && inventory.failure === null) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- pages are fetched in cursor order
    inventory = await engine.nfts.loadMore(owner, network);
  }
  return inventory;
}

/** Flagged items are hidden by default: list what is visible now. */
export function visibleItems(
  inventory: NftInventory,
): ReadonlyArray<NftInventory["items"][number]> {
  return inventory.items.filter((item) => !item.hidden);
}

/** The user pins a flagged item visible; the verdict persists and the item's `hidden` turns false. */
export async function showAnyway(engine: WalletEngine, network: string, id: string): Promise<void> {
  await engine.nfts.setHidden(network, id, "shown");
}

/**
 * A media URL the host may render: `active` media (SVG, HTML, unknown animation) needs a sandbox
 * that runs no script — pass `sandboxed` only when that is true. IPFS goes through the host's own
 * gateway, never a hard-coded one.
 */
export function mediaUrl(
  media: NftMedia | undefined,
  ipfsGateway: (ipfsUrl: string) => string,
  sandboxed = false,
): string | undefined {
  if (media === undefined || (media.active && !sandboxed)) {
    return undefined;
  }
  if (media.scheme === "ipfs") {
    return ipfsGateway(media.url);
  }
  return media.url;
}

/** An ERC-1155 batch is one request: several ids of one contract to one recipient. */
export async function prepareBatch(
  engine: WalletEngine,
  account: AccountRef,
  contract: string,
  to: string,
  items: ReadonlyArray<{ readonly tokenId: bigint; readonly amount: bigint }>,
): Promise<PendingRequest> {
  return engine.requests.prepare({
    method: "evm-nft-send",
    account,
    network: "eip155:1",
    contract,
    items,
    to,
    fee: "normal",
  });
}

/** Solana takes the SPL mint or the Core asset account — the route verifies which on chain. */
export async function prepareSolana(
  engine: WalletEngine,
  account: AccountRef,
  asset: string,
  to: string,
): Promise<PendingRequest> {
  return engine.requests.prepare({
    method: "solana-nft-send",
    account,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset,
    to,
    fee: "normal",
  });
}

/** A refused NFT send throws `NftTransferError`; branch on `reason`, never on the message. */
export async function sendOrExplain(
  prepare: () => Promise<PendingRequest>,
): Promise<PendingRequest | string> {
  try {
    return await prepare();
  } catch (error) {
    if (error instanceof NftTransferError) {
      switch (error.reason) {
        case "not-nft":
          return "not an NFT";
        case "not-owned":
          return "the wallet does not hold it";
        case "insufficient-balance":
          return "not enough units";
        case "programmable":
          return "programmable NFTs cannot be sent";
        case "frozen":
          return "the token is frozen";
        case "not-found":
          return "the asset was not found on chain";
      }
    }
    throw error;
  }
}
```

## 27. Push notifications

Compiled snippet: [`tests/migration/push-notifications.ts`](tests/migration/push-notifications.ts). Additive: nothing changes for a host
that does not opt in. Gateway operators deploy a new Durable Object class.

1. **Wire the key store.** Pass `pushKeys` (`PushKeyStore`) to `createWalletEngine`: `put(id, key)`
   and `delete(id)` keep each subscription's 32-byte payload key where the notification extension
   can read it while the app is closed (iOS: an App Group keychain item; Android: app-private
   storage read by the `FirebaseMessagingService`), and `ids()` lists the stored ids so the engine
   sweeps keys whose subscription row is gone — after a `vault.reset()` the erased wallets' rows
   die with the vault while the gateway keeps delivering within its 30-day retention; swept
   deliveries show only the fallback text. Without it, deliveries on a closed app show
   only the fallback text.
2. **Register and opt in.** After unlock call `engine.notifications.setToken("apns" | "fcm",
   token)` whenever the platform hands you a token, then `enable(walletId)` for each wallet the user
   turns notifications on for. `disable(walletId)` and removing a wallet delete its subscriptions.
   `engine.notifications.getState()` shows per-wallet, per-family `active` / `pending` /
   `failed`, and `device-required` for a family whose addresses only an external signer can
   answer — a hardware device that has not pinned that path, or a card wallet with no cached
   material for it — while the wallet's provable families and every other wallet subscribe
   normally (a partially pinned wallet keeps the subscriptions its readable groups can serve).
3. **Handle deliveries.** iOS: ship a Notification Service Extension; the alert carries
   `mutable-content: 1` and the message under `userInfo.qntx`. Open it with `openPush` from
   `@qntx/wallet-engine/push` (or a native AES-256-GCM port checked against `vectors/push.json`)
   using the keys from the key store, and replace the text; on failure leave the alert, whose
   `title-loc-key` / `loc-key` are `QNTX_PUSH_TITLE` / `QNTX_PUSH_BODY` — add both to
   `Localizable.strings`. Android: FCM sends a data-only message (`v`, `e`, `c`); build the
   notification yourself the same way. In the running app pass the message to
   `engine.notifications.receive(message)`: it returns the display hint and reloads history and
   balances; never insert the hint into an activity list.
4. **Gateway operators.** The deploy adds migration `v2` (`PushObject`), the `PUSH` binding and the
   `PUSH_LIMITER` rate limit; a Durable Object class change makes that deploy non-rollbackable
   (`deploy-check rollback-plan`). Push stays off until `PUSH_SEAL_KEY`, at least one sender
   (`APNS_*` or `FCM_SERVICE_ACCOUNT`) and the Alchemy webhook secrets are set
   (`apps/gateway/README.md` "Push notifications").

## 28. Cloud backup transports and versioned backup files

Compiled snippet: [`tests/migration/cloud-store.ts`](tests/migration/cloud-store.ts). Changes affect `@qntx/wallet-engine` hosts that
inject a `CloudStore`, and React Native hosts that turn cloud backup on. Nothing changes in the
vault, the kernel protocol or the envelope format.

1. **`CloudStore` has no `available()`; failures are typed.** Throw `CloudStoreError` with
   `unavailable` (offline, rate-limited, account signed out or disabled), `auth-required` (an
   interactive consent is needed), `quota` (cloud storage full), `invalid` (a name or text outside
   the port rules) or `failed`. Validate with `checkCloudName` / `checkCloudText`. The semantics are
   written on the `CloudStore` type; a host implementation should pass the same conformance suite
   as the built-in ones (`packages/wallet-engine/tests/cloud/conformance.ts`).
2. **Use the official transports on React Native.** `@qntx/wallet-native/cloud` provides
   `createICloudStore({ container })` (CloudKit private database) and `createGoogleDriveStore()`
   (Drive `appDataFolder`, Google Identity `AuthorizationClient`). Both need owner setup: the
   iCloud container entitlement and a CloudKit schema deployed to production; a Google Cloud
   project with the Drive API, a consent screen with the `drive.appdata` scope and an Android
   OAuth client per signing certificate (see the package README). `@qntx/wallet-engine` is a peer
   dependency of this entry. Re-run `engine.backup.sync()` from `onAccountChange` on iOS. On the
   Web, feed a Google Identity Services token to `createGoogleDriveCloudStore`.
3. **New backup states.** `BackupErrorCategory` adds `auth-required` and `quota`, both with
   status `error`: for `auth-required` call `store.authorize()` from a user action and sync again;
   for `quota` ask the user to free cloud storage.
4. **Backup files are versioned.** Each upload writes `qntx-wallet-backup-<id>-<sha256>.json`;
   `qntx-wallet-backup-<id>.json` files are ignored and the engine's backup record is rebuilt on
   the first sync. `engine.backup.list()` returns every version with its backup `id`: several
   versions of one id mean two devices updated the backup at the same time. `conflict` now means
   "another version holds wallets this device lacks" — this device's own wallets are still
   uploaded. Resolve it by restoring each such version into the vault (`backup.restore`), which
   merges it; the device then adopts or supersedes the merged version.

[`tests/migration/cloud-store.ts`](tests/migration/cloud-store.ts):

```ts
import type { CloudStore, WalletEngine } from "@qntx/wallet-engine";
import {
  checkCloudName,
  checkCloudText,
  CloudStoreError,
  createGoogleDriveCloudStore,
} from "@qntx/wallet-engine";
import { createGoogleDriveStore, createICloudStore } from "@qntx/wallet-native/cloud";

/**
 * A host-written `CloudStore` drops `available()` and throws `CloudStoreError` — every
 * implementation must also pass the conformance suite (name and text rules, atomic writes,
 * delete-missing succeeds).
 */
export function hostStore(files: Map<string, string>, online: () => boolean): CloudStore {
  const tick = Promise.resolve();
  const reachable = (): void => {
    if (!online()) {
      throw new CloudStoreError("unavailable", "offline");
    }
  };
  return {
    // @ts-expect-error -- CloudStore no longer has available()
    available: async () => {
      await tick;
      return online();
    },
    list: async () => {
      reachable();
      await tick;
      return [...files.keys()];
    },
    read: async (name) => {
      checkCloudName(name);
      reachable();
      await tick;
      return files.get(name);
    },
    write: async (name, text) => {
      checkCloudName(name);
      checkCloudText(text);
      reachable();
      await tick;
      files.set(name, text);
    },
    delete: async (name) => {
      checkCloudName(name);
      reachable();
      await tick;
      files.delete(name);
    },
  };
}

/** React Native: the official transports. iOS takes the CloudKit container id from owner setup. */
export function nativeStore(platform: "ios" | "android"): CloudStore {
  return platform === "ios"
    ? createICloudStore({ container: "iCloud.org.example.wallet" })
    : createGoogleDriveStore();
}

/** ICloud account switches re-run the sync so the new account gets a copy. */
export function watchICloudAccount(engine: WalletEngine): () => void {
  const store = createICloudStore({ container: "iCloud.org.example.wallet" });
  return store.onAccountChange(() => {
    void engine.backup.sync();
  });
}

/** `auth-required` (Android/Web): run the consent from a user action, then sync again. */
export async function reauthorizeDrive(engine: WalletEngine): Promise<void> {
  const store = createGoogleDriveStore();
  const { status, error } = engine.backup.getState();
  if (status === "error" && error === "auth-required") {
    await store.authorize();
    await engine.backup.sync();
  }
}

/** Web: Google Drive appDataFolder with a Google Identity Services token client. */
export function webDriveStore(requestToken: () => Promise<string>): CloudStore {
  let cached: string | undefined;
  return createGoogleDriveCloudStore({
    fetch: async (input, init) => globalThis.fetch(input, init),
    setTimer: (ms, fn) => {
      const id = setTimeout(() => {
        fn();
      }, ms);
      return () => {
        clearTimeout(id);
      };
    },
    token: async () => {
      cached ??= await requestToken();
      return cached;
    },
    invalidateToken: async (token) => {
      if (cached === token) {
        cached = undefined;
      }
      await Promise.resolve();
    },
  });
}

/**
 * `list()` returns every version, grouped here by backup id: several versions of one id mean two
 * devices updated it concurrently — restore each into the same vault to merge them.
 */
export async function backupsById(
  engine: WalletEngine,
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const byId = new Map<string, string[]>();
  for (const { id, name } of await engine.backup.list()) {
    byId.set(id, [...(byId.get(id) ?? []), name]);
  }
  return byId;
}
```

## 29. Fiat24 app

Compiled snippet: [`tests/migration/fiat24-app.ts`](tests/migration/fiat24-app.ts).

### Adding the Fiat24 app

```ts
import { createApps } from "@qntx/wallet-engine/apps";
import type { AppGroup, CreateAppsOptions } from "@qntx/wallet-engine/apps";
import { fiat24 } from "@qntx/wallet-engine/apps/fiat24";

// From your createWalletEngine/createApps setup above; `group` is the wallet group in scope.
declare const options: CreateAppsOptions;
declare const fiat24Fetch: typeof fetch;
declare const group: AppGroup;

const apps = createApps({ ...options, apps: [fiat24({ fetch: fiat24Fetch })] });
await apps.controller.acknowledgeTerms(group, "fiat24");
await apps.controller.enable(group, "fiat24");

const account = await apps.fiat24.account(group); // "no-account" | AccountStatus | "stale" | "contract-changed"
let flow = await apps.fiat24.flows.start(group, {
  flow: "transfer",
  currency: "EUR24",
  amount: 1000n,
  to: { tokenId: 469709n },
});
flow = await apps.fiat24.flows.advance(group, flow.id); // opens one request; approve it as usual
```

- Enabling needs the terms flag and an eligibility answer of `available` or `close-only`. The
  gateway answers `fiat24` once it runs this release; until then `enable` fails closed.
- Call `advance` again until the flow is terminal (`confirmed`, `failed`, `not-sent`, or the
  flow's own end states). Pace it on a flow whose last transaction is `sending`/`unknown`
  (for example every 15 s): the app also reconciles such flows itself after unlock and every 15 s
  while `setVisible(true)`, and never sends while doing so.
- `refusal` on the returned flow says why nothing was sent (`rejected`, `expired`,
  `invalidated`, `failed-before-signing`, `nonce-conflict`, `prepare-failed`, `invalid-call`);
  advancing again prompts again.
- `start` refuses (`flow-unresolved`) while another flow of the group has a `sending` or `unknown`
  transaction, or a stored state that no longer decodes. `list` reports the latter as
  `{ id, invalid: true }`; only `discard` removes it — have the user check the account's activity
  first, because it can never be reconciled.

### The Fiat24 REST API needs an injected `fetch`

`api.fiat24.com` sends no CORS headers, so a browser cannot call it directly and the gateway does
not proxy it. Pass `fiat24({ fetch })`:

- React Native: the platform `fetch`, uninstrumented (exclude `api.fiat24.com` from Sentry,
  Flipper and logging interceptors; disable its HTTP cache). React Native's `fetch` follows
  redirects whatever `redirect` says; inject one that does not if that matters to you.
- Web: a fetch that sends the request to your own proxy for `https://api.fiat24.com`. The proxy
  sees the session grant headers, which are a bearer credential for the account until their
  deadline.
- Without `fetch`, the chain flows (transfer, exchange, top-up, payouts to a saved contact,
  onboarding up to KYC) still work. Secured reads, the public API reads, and advancing a bank or
  Swiss QR payout draft, a card flow's API step or onboarding's KYC step throw `Fiat24AppError`
  `api-unavailable`.

### Engine request changes

- `EvmSignInput.nonce` (app `evm.transaction` only) pins the nonce; `prepare` throws
  `NonceConflictError` before anything is shown when the sender's next free nonce differs, and a
  plain error when `nonce` is set anywhere else.
- `new RequestEndedError(stage, message, signed)`: the third argument is required. Read
  `error.signed` to tell whether anything may have been broadcast.
- `AppStorage` has `list(group)`; a custom `AppStorage` implementation must provide it.

### New risk codes

`RiskFinding.code` gains `fiat24-unlimited-approval`, `fiat24-account-move` (danger) and
`fiat24-internal-account`, `fiat24-card-pull`, `fiat24-exact-out-unbounded`,
`fiat24-payee-offchain`, `fiat24-account-burn` (warning). They come from the decoder's intent
warnings, for every origin, so an exhaustive `switch` over `RiskFinding["code"]` needs these cases.
`requiredAcknowledgement` asks for the danger-level findings only (in `risk`, plus every request
check in `checks`): an `approve` must echo those back exactly, while warning-level findings never
require acknowledgement.

## 30. Card wallets

Compiled snippets: [`tests/migration/card-wallet.ts`](tests/migration/card-wallet.ts),
[`tests/migration/secure-input.ts`](tests/migration/secure-input.ts). Changes affect every
`@qntx/wallet` host that reads `WalletInfo`, and React Native hosts that offer qntx card wallets.
The vault gains a `card-wallet` record kind; existing vault wallets are unchanged.

1. **`CardWalletInfo`** (`custody: "card"`) joins the `WalletInfo` union (§24): `origin`
   `card-generated | card-imported`, `backup: "cards"`, `members` (k = 1–3) and `cards`
   (`CardInfo`: `cardId`, `shortId`, `state` `ready | unknown | pending`, `tries`, `verifiedAt`).
   Show a card wallet's receive addresses only after its `create` task has resolved: a `pending`
   member has not imported the seed yet.
2. **Card wallets sign through `@qntx/wallet/card`.** `chains(wallet).sign` on a card wallet
   answers `device-required`, and `wallet.accounts` does too for any account whose public key no
   earlier tap cached; run `card(wallet).start({ kind: "sign", request }, verify)` (or
   `{ kind: "accounts", … }`) instead. `start` returns a `CardTask`: `observe` reports every
   `CardStep` (an `input` step means mount `SecureInput`, a `tap` step means show the
   hold-the-card instruction), `cancel` ends the operation, and `result` resolves with the
   operation's `CardOpResult`. A `sign` result is verified exactly like `chains.sign`'s before
   `done` is reported. There is no call that answers a step: the kernel collects the code from
   `SecureInput` and talks to the card itself, and it sets the NFC sheet's text from the decoded
   request. Starting a second task cancels the first. Inside the engine every card signature
   runs under `engine.signers` as a `card` activity (§32) — a send or dApp request taps without
   the host calling `start`.
3. **Operations.** `status`, `add` (adopt a card whose wallet is not in this vault yet — a card
   whose wallet is already there fails `already-exists`),
   `accounts`, `health`, `change-access`, `erase` (`last: true` for the last card of a
   card-generated wallet), `create` (1–3 cards; `source: { kind: "generate" }` or
   `{ kind: "wallet", walletId }`, which moves a vault wallet onto the cards and deletes its sealed
   seed in the same commit), `transfer` (finish a pending member), `reseal` (a new code for a
   member that forgot it, from another member), `sign` and `forget-access`. `add`,
   `change-access`, `erase`, `create`, `transfer`, `reseal`, `sign` and `forget-access` require a
   `verify` factor — `add` admits a whole wallet as confirmed own material, so it is gated like a
   hardware `pair`; `status`, `accounts` and `health` refuse one (`invalid-input`). `remember: true`
   (save the access code's hash in the vault) needs the app lock and a `hardware` factor, else
   `unsupported`.
4. **Capabilities a card wallet lacks.** Nostr, Spark, session keys (`sessions.create`) and
   `wallets.exportMnemonic` answer `unsupported` for a card wallet. Hide them for
   `custody: "card"`.
5. **Platforms.** Only `@qntx/wallet-native` has a card platform. Web and Node answer every
   `card.*` call `unsupported`. **Neither 0.14.0 nor 0.14.1 pins a production card certificate
   anchor**, so every card — genuine or not — answers `card-not-genuine` until a later release ships
   the production anchor. Ship the card UI behind a flag, or not at all, until then.
6. **New error codes** (§14): `card-not-genuine` (the certificate does not chain to a pinned
   anchor, or the card never finished personalisation — never offer to continue), `card-id-mismatch` (another card than the step asked for;
   nothing was sent), `wrong-device` (a card of another wallet), `card-erased`, `card-locked`,
   `card-tampered` (the card's failure counter moved without this wallet — offer `reseal` from
   another member), `card-fault` (the card answered outside the protocol), `card-unsupported` (the
   request does not fit the card's limits; split it) and `device-required`. A wrong access code is
   not an error: the next `input` step carries `remaining`.
7. **Android: the library manifest is empty.** `@qntx/wallet-native` merges no permissions.
   A host that offers card wallets declares `android.permission.NFC`,
   `android.permission.HIDE_OVERLAY_WINDOWS` and
   `<uses-feature android:name="android.hardware.nfc" android:required="false"/>` itself —
   the exact entries are in the package README (the harness declares them in its Expo config).
8. **iOS**: CoreNFC is weak-linked, so apps without NFC keep loading. A host that offers card
   wallets adds the NFC entitlement and the `Info.plist` keys in the package README.
9. **`@qntx/wallet-native/secure-input`** (`SecureInput`) collects the access code, the short ID
   and the backup password — the kernel asks for the password through the same view (§8). Never
   collect a card access code, a short ID or the backup password in a JS `TextInput`.

## 31. Value-moving session keys are approved and metered

A `hyperliquid-l1-agent` session key moves value without a per-order prompt, so the kernel bounds
it:

- `sessions.create` takes `limits` (`HyperliquidAgentLimits`) — the cumulative `notional` budget
  as a positive decimal at most 1e15, the `maxLeverage` cap, and `assets`, an allow-list of 1–16
  `{ asset, size }` rows: ascending distinct asset ids 0..99999 (builder-dex HIP-3 ids start at
  100000 and stay out of scope), each with a per-asset cumulative `size` cap that buys and sells
  both charge — and a `verify` factor. The kernel's approval prompt states the budget, the cap and
  the list, and it must fit the platform's dialog: create and open answer `invalid-input` when the
  rendered approval cannot.
- The new `sessions.open(address, verify)` re-approves the recorded session after a lock: the
  opened set lives only in kernel memory, so `sessions.sign` on an unopened session answers
  `approval-required`.
- Every signed order charges its price × size against `spent` before the signature returns — a
  reduce-only order counts, the kernel has no position state to prove it — and a sell charges its
  `size` against the row's cap. Past the budget, over the leverage cap or outside the allow-list
  the answer is `limit-exceeded`; the charge is persisted in the session record and survives
  restarts. `SessionInfo` gains `limits` and `spent`, and `spent` is the scheme's
  `HyperliquidAgentSpent` (`{ notional, size }`) carried as opaque `ProtocolValue` — there is no
  `SESSION_SPENT` grammar on the protocol surface.
- The actions the scheme admits are an explicit allow-list — `order`, `cancel`, `cancelByCloid`,
  `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`, `twapCancel` — every other
  `action.type` is `invalid-input`. `scheduleCancel` is not admitted (it cancels every open order
  on every asset, so no allow-list could scope it), and the engine's `trade.scheduleCancel` /
  `actions.scheduleCancel` are gone.
- At most two live metered sessions may exist per owner and scope: a third `sessions.create` for
  the same `{ walletId, groupIndex }` + scope answers `conflict` until one is deleted.
- On React Native with the app lock off — the vault still holds its `device` factor — create,
  open and sign all answer `app-lock-required`: a metered session cannot exist without the
  lock-screen check.
- On iOS the limits are confirmed on the kernel-controlled secure-input hub before the factor
  ceremony (Face ID and WebAuthn show no kernel prompt text): `sessions.create`/`open` — and the
  engine's Hyperliquid enable/renew/reopen/disable({ revoke: true }) that call them — ask
  `secureInput` for the new `"session-approval"` kind, a kernel-chosen 4-digit code shown as the
  last line of a label that carries the limits. The host must mount `SecureInput` while they run:
  the request waits for it. A host without a secure-input surface answers `unsupported`; a wrong code or a dismissal answers `cancelled`. Android shows the
  bounded kernel prompt inside BiometricPrompt instead.
- `twapOrder` is not admitted (a TWAP's slices carry no price to meter); `trade.twap` and
  `actions.twap` are gone (§13), `trade.twapCancel` stays.

The engine path carries the same shape: `apps.controller.enable(group, "hyperliquid", input)` and
renew take `{ limits, verify }` (`HyperliquidEnableInput`), and `HyperliquidProvider.reopen(group,
verify)` runs `sessions.open` — the kernel prompt restates the limits and the remaining budget.
Trading answers `reopen-required` while the session is unopened, and `app-lock-required` /
`limit-exceeded` reach the host as the same-named `HyperliquidError` categories. The budget sums
price × size in each market's own quote currency — spot ids are not quoted in USDC — so it is a
bound on loss, not a USDC figure.

[`tests/migration/session-metering.ts`](tests/migration/session-metering.ts):

```ts
/**
 * Value-moving session keys are approved and metered (section 31): `sessions.create` and the new
 * `sessions.open` take a `verify` factor, `create` takes the scheme's `limits` (a notional budget,
 * a leverage cap and per-asset `{ asset, size }` caps), `SessionInfo` reports `limits`/`spent` —
 * `spent` is the scheme's `HyperliquidAgentSpent` as opaque `ProtocolValue`, there is no
 * `SESSION_SPENT` grammar. Out-of-bounds use answers `limit-exceeded`, a third live metered session
 * per owner and scope `conflict`, an approval text that cannot fit the dialog `invalid-input`, and
 * app-lock-less use `app-lock-required`; on iOS the limits are confirmed by a 4-digit code on the
 * secure-input hub (`cancelled` / `unsupported`). Only allow-listed actions sign — `scheduleCancel`
 * is not among them. The engine's Hyperliquid `enable`/`renew` take `{ limits, verify }` and
 * `provider.reopen(group, verify)` re-approves the agent after a lock; `trade.twap` /
 * `actions.twap` are gone. Compiled only.
 */
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import type { AppsController } from "@qntx/wallet-engine/apps";
import type {
  HyperliquidGroup,
  HyperliquidGroupState,
  HyperliquidProvider,
} from "@qntx/wallet-engine/apps/hyperliquid";
import { HyperliquidError } from "@qntx/wallet-engine/apps/hyperliquid";
import type { HyperliquidAgentLimits, SessionInfo } from "@qntx/wallet/sessions";
import { sessions } from "@qntx/wallet/sessions";

const LIMITS: HyperliquidAgentLimits = {
  notional: "1000",
  maxLeverage: 10,
  assets: [
    { asset: 0, size: "10" },
    { asset: 10_001, size: "100" },
  ],
};

/** Create approves the limits once; open re-approves the same limits after every lock. */
export async function agentSession(wallet: Wallet, walletId: string): Promise<SessionInfo> {
  const api = sessions(wallet);
  const address = await api.create({
    scheme: "hyperliquid-l1-agent",
    owner: { walletId, groupIndex: 0 },
    scope: "Mainnet",
    name: "bot-1",
    validUntil: Date.now() + 180 * 86_400_000,
    limits: LIMITS,
    verify: { kind: "hardware" },
  });
  // After a lock the opened set is empty: sign answers `approval-required` until `open`.
  await api.open(address, { kind: "hardware" });
  const all = await api.list();
  const info = all.find((s) => s.supported && s.address === address);
  if (info === undefined) {
    throw new Error("the session is gone");
  }
  return info; // info.limits restates LIMITS; info.spent is the charged metering so far.
}

/** Map the metering refusals to UX. */
export async function signWithinBudget(
  wallet: Wallet,
  address: string,
  params: Parameters<ReturnType<typeof sessions>["sign"]>[0]["params"],
): Promise<"signed" | "reopen" | "over" | "app-lock"> {
  try {
    await sessions(wallet).sign({ scheme: "hyperliquid-l1-agent", address, params });
    return "signed";
  } catch (error) {
    if (error instanceof WalletError) {
      if (error.code === "approval-required") {
        return "reopen";
      }
      if (error.code === "limit-exceeded") {
        return "over"; // renew with higher limits — never silently retry
      }
      if (error.code === "app-lock-required") {
        return "app-lock"; // a `device`-factor vault cannot hold a metered session
      }
    }
    throw error;
  }
}

/**
 * `spent` is opaque `ProtocolValue` — the scheme's `{ notional, size }` JSON — and `conflict` means
 * a third live metered session for the same owner and scope; delete one, then retry.
 */
export async function createOrReuse(
  wallet: Wallet,
  input: Parameters<ReturnType<typeof sessions>["create"]>[0],
): Promise<{ created: boolean; spent: SessionInfo["spent"] | undefined }> {
  const api = sessions(wallet);
  try {
    await api.create(input);
    return { created: true, spent: undefined };
  } catch (error) {
    if (error instanceof WalletError && error.code === "conflict") {
      const all = await api.list();
      const live = all.find(
        (s) =>
          s.supported &&
          s.walletId === input.owner.walletId &&
          s.groupIndex === input.owner.groupIndex &&
          s.scope === input.scope,
      );
      return { created: false, spent: live?.spent };
    }
    throw error;
  }
}

/**
 * The engine path: `enable`/`renew` take the same `{ limits, verify }`, and `reopen` re-approves
 * the agent in the kernel — the kernel's prompt restates the limits and the remaining budget.
 */
export async function enableAndReopen(
  apps: AppsController<{ readonly hyperliquid: HyperliquidGroupState }>,
  provider: HyperliquidProvider,
  group: HyperliquidGroup,
  verify: VerifyFactor,
): Promise<void> {
  await apps.enable(group, "hyperliquid", { limits: LIMITS, verify });
  try {
    await provider.reopen(group, verify);
  } catch (error) {
    if (error instanceof HyperliquidError && error.category === "app-lock-required") {
      throw new Error("turn the app lock on first", { cause: error });
    }
    throw error;
  }
}

/** Trading answers `reopen-required` while the session is unopened — call `reopen`, not enable. */
export function isReopen(error: unknown): boolean {
  return error instanceof HyperliquidError && error.category === "reopen-required";
}
```

## 32. Engine signing through external signers

Compiled snippet: [`tests/migration/engine-signers.ts`](tests/migration/engine-signers.ts).
Additive for a host that pairs no device, except the one breaking change in item 6. Sections 24
and 30 cover the wallet-level `hardware(wallet)` / `card(wallet)` facades; this section is how the
engine drives the same signers for its own signing paths.

1. **`EngineOptions.deviceIo`.** The engine runs card and hardware operations itself, so a host
   wires its transports once at `createWalletEngine`: `deviceIo: (device) => DeviceIo` resolves
   the paired device kind to the same `DeviceIo` a `hardware(wallet)` call takes
   (`withDeviceIo` — a Keystone's QR channel is the host's own `DeviceIo`, Ledger and OneKey reuse
   the shipped `ledgerIo` / `oneKeyIo` over `HidPort` / `BlePort`). `deviceIo` is the only
   transport seam: without it every hardware operation answers `unsupported` and nothing
   publishes an activity. Card wallets need no entry: the kernel talks to the reader itself.
2. **`engine.signers` — one activity at a time.** `getState` / `store.subscribe` reports
   `SignersState.active`, a single `SignerActivity` (`walletId`, `custody`, `operation`
   `sign | accounts | verify-address`, `step` `starting | card | device`); a card operation's
   `card` steps are the kernel's own steps (mount `SecureInput` on `input`, hold the card on
   `tap`), a hardware operation's `device` steps are the exchange progress (`describeSignerActivity`,
   `watchSigners`). Starting a second operation while one runs refuses `conflict` and never
   touches the running one — a `conflict` is safe to queue behind; locking the vault cancels the
   running operation (`cancelSigner`).
3. **Every engine signature runs through it.** Sends, dApp requests, revokes, NFT sends, app
   enables — the request wallet's custody decides: a vault wallet signs through `chains`, a card
   wallet runs a card task, a hardware wallet a device operation. That holds for every request
   origin — sends, dApp requests, in-engine apps and scanned QR requests (§33) alike: there is
   one seam, and hardware custody signs through `deviceIo` regardless of how the request
   arrived. What the kernel already refuses stays refused and lands before any activity
   publishes: `sessions.create` / `sessions.open` on a card or hardware wallet answer
   `unsupported` before the app-lock check, the limits text, the session-approval secure input
   and any factor ceremony; Spark and Nostr answer `unsupported`, a Fiat24 session grant
   `invalid-input`.
4. **`fetchAccounts` and `AccountGroup.signer`.** A group on an external signer has no public
   material for a family until the signer exports it: the family's entry in the group's `signer`
   map is `device-required` — discovery neither counts it used nor errored, and a group whose
   every chain family waits on the signer stops discovery.
   `engine.signers.fetchAccounts({ walletId, groupIndex, family })` runs the accounts operation
   (hardware with the family's app open; a card tap; Bitcoin derives once per enabled network,
   the other families once) and re-runs that family's check when the material lands
   (`fetchMissingFamily`).
5. **`verifyAddress`** (`checkAddressOnDevice`) shows an address on the device's screen —
   hardware only; a card answers `unsupported`. The user's on-screen rejection reports
   `device-rejected`.
6. **`TransactionController` `Options.chains` is required** — the transaction controller signs
   through the injected apis so a card or hardware request routes to its signer; what was a test
   seam defaulting to `chains(wallet)` is now a required option. A host constructing the
   controller directly passes `chains(wallet)` for vault-only use or the engine's signer-aware
   `apis`.
7. **One `account` seam for apps.** `CreateAppsOptions.account` and `AppContext.account` are
   required: an app derives through the same apis as every other signer path — the engine passes
   `engine.signers.apis.account`; a host composing `createApps` without the engine passes
   `chains(wallet).account`. A provider-level `account?` stays optional: a reads-only provider
   throws `not-enabled` before any signing call.
8. **Account-tree wallet entries carry `custody` and `state`** (`walletRow`). `incomplete` — a
   card wallet still waiting on a member card — has no groups and no addresses:
   `transactions.nextReceiveAddress` and any send on it throw until the wallet is `ready`, and
   notifications report `device-required` for a card wallet's uncached families exactly like a
   hardware device's (§27).

[`tests/migration/engine-signers.ts`](tests/migration/engine-signers.ts):

```ts
/**
 * Engine signing through external signers: `EngineOptions.deviceIo` hands the engine the host's
 * per-device transport; `engine.signers` reports the one card/hardware operation that can run at a
 * time and offers `cancel`, `verifyAddress` and `fetchAccounts`; the account tree marks the
 * families only the signer can answer and the wallets still waiting on a member card.
 */
import { WalletError } from "@qntx/wallet";
import type {
  AccountGroup,
  AccountTreeState,
  EngineOptions,
  SignerActivity,
  SignerFamily,
  WalletEngine,
} from "@qntx/wallet-engine";
import { ledgerHidExchange, ledgerIo, oneKeyHidExchange, oneKeyIo } from "@qntx/wallet/hardware";
import type { DeviceIo, HardwareDevice, HidPort } from "@qntx/wallet/hardware";

/**
 * `EngineOptions.deviceIo` is the same `DeviceIo` a `hardware(wallet)` call takes, resolved per
 * paired device kind — the engine runs the device operations itself now, so a host wires its
 * transports once at `createWalletEngine` instead of passing `io` to every call. A Keystone's QR
 * channel is the host's own `DeviceIo` (§24's `keystoneQrIo`); Ledger and OneKey reuse the shipped
 * exchanges. Card wallets need no entry here: the kernel talks to the reader itself.
 */
export const withDeviceIo = (
  options: EngineOptions,
  transports: {
    readonly keystoneQr: () => DeviceIo;
    readonly ledgerHid: () => HidPort;
    readonly oneKeyHid: () => HidPort;
  },
): EngineOptions => ({
  ...options,
  // oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
  deviceIo: (device: HardwareDevice): DeviceIo => {
    switch (device) {
      case "keystone":
        return transports.keystoneQr();
      case "ledger":
        return ledgerIo(ledgerHidExchange(transports.ledgerHid(), 0x2a3f));
      case "onekey":
        return oneKeyIo(oneKeyHidExchange(transports.oneKeyHid()));
    }
  },
});

/**
 * At most one signer operation runs at a time, for every custody: `engine.signers.getState()` (or
 * `store.subscribe`) reports it as one `SignerActivity` — `starting`, then `card` steps (the card
 * task's own steps: mount `SecureInput` on `input`, hold the card on `tap`) or `device` exchanges —
 * and the activity clears when the operation ends. A second start while one runs fails `conflict`
 * and leaves the running operation alone; locking the vault cancels it.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function describeSignerActivity(
  // oxlint-disable-next-line typescript/no-restricted-types -- spec shape: no activity → null
  activity: SignerActivity | null,
): string {
  if (activity === null) {
    return "idle";
  }
  const who = `${activity.custody} ${activity.walletId} (${activity.operation})`;
  switch (activity.step.kind) {
    case "starting":
      return `${who}: starting`;
    case "card":
      return `${who}: card ${activity.step.step.kind}`;
    case "device":
      return `${who}: device exchange`;
  }
}

/** Wire the activity feed into UI; the unsubscribe handle ends it. */
export function watchSigners(engine: WalletEngine, show: (text: string) => void): () => void {
  return engine.signers.store.subscribe((state) => {
    show(describeSignerActivity(state.active));
  });
}

/** The user cancelled the sheet, or a lock/leave ends the flow: cancel the running operation. */
export async function cancelSigner(engine: WalletEngine): Promise<void> {
  await engine.signers.cancel();
}

/**
 * A group on an external signer has no material for a family until the device exports it: the
 * family's `signer` map entry is `device-required` and discovery neither counts it used nor errored
 * — the group stops being provable once every chain family waits on the signer.
 * `engine.signers.fetchAccounts` runs the accounts operation (hardware: the family's app on the
 * device; card: a tap) and re-runs that family's check when the material lands.
 */
export async function fetchMissingFamily(
  engine: WalletEngine,
  group: AccountGroup,
  family: SignerFamily,
): Promise<void> {
  if (group.signer?.[family] !== "device-required") {
    return;
  }
  try {
    await engine.signers.fetchAccounts({
      walletId: group.walletId,
      groupIndex: group.index,
      family,
    });
  } catch (error) {
    // Two operations never overlap: queue the fetch behind whatever is running.
    if (error instanceof WalletError && error.code === "conflict") {
      return;
    }
    throw error;
  }
}

/**
 * `AccountTreeState.wallets` entries carry `custody` and `state`. A `card` wallet still waiting on
 * a member card is `incomplete`: it has no groups and no addresses (asks like
 * `transactions.nextReceiveAddress` throw) — show the pending-member UI instead of a receive
 * address until `ready`.
 */
export function walletRow(entry: AccountTreeState["wallets"][number]): {
  readonly key: string;
  readonly receiveReady: boolean;
} {
  return {
    key: `${entry.custody}:${entry.walletId}`,
    receiveReady: entry.state === "ready",
  };
}

/**
 * `verifyAddress` shows an address on the device screen — hardware only; a card has no screen and
 * answers `unsupported`.
 */
export async function checkAddressOnDevice(
  engine: WalletEngine,
  walletId: string,
  groupIndex: number,
): Promise<string> {
  const { address } = await engine.signers.verifyAddress({
    walletId,
    groupIndex,
    template: "evm.bip44",
    network: "eip155:1",
    index: 0,
  });
  return address;
}
```

## 33. QR signer mode

`@qntx/wallet-engine/qr` turns the wallet into the signing half of an air-gapped pair: a
watch-only counterpart shows an animated UR request, the user scans it, approves it like any
other request, and the wallet answers with animated frames. Compiled snippet:
[`tests/migration/qr-signer.ts`](tests/migration/qr-signer.ts).

1. **A new `RequestOrigin` kind.** A scanned request enters the pipeline with
   `{ kind: "qr", declared? }` (`declared` is the counterpart's self-label, display-only and
   untrusted). Every switch on `RequestOrigin["kind"]` must name it — `originBadge` in the
   snippet. It uses the same prepare → approve → respond pipeline as every other origin: risk
   findings, user verification and `RequestEndedError` semantics are unchanged.
2. **`EngineOptions.deviceIo`.** Signatures for hardware-custody accounts — for every origin,
   QR included — route through the host's per-device-kind transport (`engineOptions` in the
   snippet), the same `DeviceIo` a `hardware(wallet)` call takes (§32). Leave it out and
   hardware wallets can still be listed and watched, but every signature fails `unsupported`.
3. **`BitcoinPsbtInput.sign[].template` widened** to all four account templates (`psbtTemplateLabel`
   in the snippet): a QR counterpart may ask for `btc.bip44`/`btc.bip49` inputs where a dApp only
   names `btc.bip84`/`btc.bip86`. Hosts that render or filter PSBT inputs by template need the
   new members.
4. **Wiring the signer.** The host drives the framing — `createQrScanner` folds scanned frames
   into the payload, `readQrRequest` decodes and re-checks it, `qrSigner({ engine, wallet }).prepare`
   binds it and opens the pending request, and after the user approves, `respond` returns the
   answer payload for `qrFrames` to animate (`answerQrRequest`, `qrAnswerFrames`). `respond` must
   run on the `qrSigner` instance that prepared the request — keep one signer for the session
   (`openQrSigner`). Scanning and animation
   progress belong to the host UI; the request's own stage is read from the pipeline like any
   other origin. `exportAccount` produces the pairing QR for the counterpart (MetaMask/Rabby:
   `crypto-hdkey`; BlueWallet/Sparrow: `crypto-account`; Keystone-compatible and the qntx Web
   wallet: `crypto-multi-accounts`) — `discloses` says exactly which material leaves the device
   and belongs in the prompt (`exportForWatch`).
5. **A watch-only counterpart** needs no engine internals: `readQrExport` turns the export
   payload into `QrLink`s, `engine.watch.add` persists one as a `WatchAccount.qr`, and
   `qrSignRequest`/`readQrSignature` encode and verify the round trip. The counterpart never
   learns which kind of signer backs the account.
6. **A QR sign-in is a `danger` finding.** A scanned SIWE request can claim any domain — the
   signer cannot verify it against a live dApp session — so `risk` reports
   `qr-sign-in-unverified` at `danger` and `approve` refuses it until `acknowledged` names the
   code (`qrSignApproval` in the snippet).
7. **Inspection reports labelled displays.** `inspectQrRequest` returns `displays`, one decoded
   `QrDisplay` per network encoding the frame can mean: a coin-type `1'` PSBT is ambiguous between
   testnet/signet (`tb1…`) and regtest (`bcrt1…`) and yields both, labelled; mixed or missing coin
   types are `network-ambiguous` rather than guessed. `shownBy` is set only where a device's
   display has a primary source — the Ethereum hashes (app-ethereum CHANGELOG 1.14.0 / 1.18.0) and
   the Solana message hash (app-solana `handle_sign_message.c`) — and is empty for digests no
   sourced device shows. The account-export prompt the kernel shows is rendered from the requested
   nodes, one row per key the QR will disclose (`exportForWatch` in the snippet).

[`tests/migration/qr-signer.ts`](tests/migration/qr-signer.ts):

```ts
import type { Wallet } from "@qntx/wallet";
import type {
  BitcoinPsbtInput,
  EngineOptions,
  PendingRequest,
  RequestOrigin,
  WalletEngine,
} from "@qntx/wallet-engine";
import { requiredAcknowledgement } from "@qntx/wallet-engine";
import {
  createQrScanner,
  inspectQrRequest,
  qrFrames,
  qrSigner,
  readQrRequest,
} from "@qntx/wallet-engine/qr";
import type { QrExport, QrInspection, QrPayload } from "@qntx/wallet-engine/qr";
import type { DeviceIo, HardwareDevice } from "@qntx/wallet/hardware";

/**
 * `RequestOrigin` gains `{ kind: "qr", declared? }` — a request that entered through a scanned UR
 * frame. Every switch on `RequestOrigin["kind"]` must name it: a scanned request is attributed to
 * the counterpart's self-declared `origin` (display-only, untrusted), never to a dApp session.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function originBadge(origin: RequestOrigin): string {
  switch (origin.kind) {
    case "internal":
      return "this app";
    case "browser":
      return origin.origin;
    case "walletconnect":
      return origin.name;
    case "app":
      return origin.id;
    case "qr":
      return origin.declared ?? "scanned QR request";
  }
}

/**
 * `BitcoinPsbtInput.sign[].template` widened from the two dApp-facing templates to all four — a QR
 * counterpart may ask for `btc.bip44` or `btc.bip49` inputs too. A host that rendered or filtered
 * PSBT inputs by template must expect every member.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export function psbtTemplateLabel(template: BitcoinPsbtInput["sign"][number]["template"]): string {
  switch (template) {
    case "btc.bip44":
      return "legacy";
    case "btc.bip49":
      return "wrapped segwit";
    case "btc.bip84":
      return "native segwit";
    case "btc.bip86":
      return "taproot";
  }
}

/**
 * `EngineOptions.deviceIo` routes hardware-custody accounts' signatures — for every origin, QR
 * included — through the host's per-device-kind transport, the same `DeviceIo` a `hardware(wallet)`
 * call takes (MIGRATION §32). Without it, hardware wallets fail `unsupported`.
 */
export function engineOptions(
  deviceIo: (device: HardwareDevice) => DeviceIo,
): Pick<EngineOptions, "deviceIo"> {
  return { deviceIo };
}

/**
 * The phone side owns ONE `qrSigner` for the session: `prepare` records every request it bound, so
 * `respond` must run on the instance that prepared it — a second `qrSigner({ engine, wallet })`
 * answers "not prepared by this signer". The host creates one and passes it to every QR call.
 */
export type PhoneQrSigner = ReturnType<typeof qrSigner>;

export function openQrSigner(engine: WalletEngine, wallet: Wallet): PhoneQrSigner {
  return qrSigner({ engine, wallet });
}

/**
 * Decode the counterpart's frames, prepare an ordinary engine request, let the user approve it,
 * answer with the signature frames. Progress on the wire is the scanner's ratio; the request's
 * stage moves `awaiting-approval` → `signed` on its own.
 */
export async function answerQrRequest(
  signer: PhoneQrSigner,
  account: { walletId: string; groupIndex: number },
  readFrame: () => Promise<string>,
): Promise<PendingRequest> {
  const scanner = createQrScanner({ kind: "request", now: () => Date.now() });
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- frames arrive one camera read at a time
    const outcome = scanner.receive(await readFrame());
    if (outcome.status === "complete") {
      const { payload } = outcome;
      return signer.prepare(readQrRequest(payload), account);
    }
  }
}

/**
 * After the user approves `pending.id` through the usual pipeline, `respond` encodes the UR answer;
 * the host animates `qrFrames` until the counterpart has every part.
 */
export async function qrAnswerFrames(
  signer: PhoneQrSigner,
  requestId: string,
): Promise<() => string> {
  const payload = await signer.respond(requestId);
  return qrFrames(payload);
}

/** Show the account export QR: what it discloses belongs in the prompt. */
export async function exportForWatch(
  signer: PhoneQrSigner,
  account: { walletId: string; groupIndex: number },
  verify: { kind: "password"; password: string },
): Promise<{ frames: () => string; discloses: QrExport["discloses"] }> {
  const out = await signer.exportAccount({
    account,
    form: "crypto-multi-accounts",
    families: ["evm", "solana", "tron"],
    verify,
  });
  return { frames: qrFrames(out.payload), discloses: out.discloses };
}

/**
 * A QR sign-in request's `risk` carries the `qr-sign-in-unverified` danger — `approve` refuses it
 * until `acknowledged` names exactly the findings and checks the request carries.
 */
export async function qrSignApproval(
  engine: WalletEngine,
  pending: PendingRequest,
  verify: { kind: "password"; password: string },
): Promise<void> {
  await engine.requests.approve(pending.id, "evm-sign", {
    verify,
    acknowledged: requiredAcknowledgement(pending),
  });
}

/**
 * `inspectQrRequest` decodes the frame without a wallet: `displays` lists one `QrDisplay` per
 * network encoding — a coin-type `1'` PSBT yields a `tb1…` (testnet/signet) and a `bcrt1…`
 * (regtest) display, labelled — and throws `network-ambiguous` on mixed or missing coin types.
 */
export function inspectDisplays(payload: QrPayload): QrInspection["displays"] {
  return inspectQrRequest(readQrRequest(payload)).displays;
}
```

## 34. Own-key Bitcoin outputs and prompt safety

An own-key PSBT output is hidden as change only when the wallet can discover it: this group's key on
the change chain at `i ≤ mark + BITCOIN_GAP_LIMIT` (20 — the BIP-44 address gap limit), with a
script type at least one signed input shares, where `mark` is the kernel-sealed change mark of §35.
Every other own-key output is _shown_: `decodeBitcoinPsbt(request, own)` takes a `BitcoinOwn`
(`{ change, unusual, unconfirmed }` — script hex sets/maps, `EMPTY_BITCOIN_OWN` when there is none)
and reports such an output as a verified outflow whose `AssetFlow.ownPath` carries the `m/…` path
text, plus an `unusual-own-output` `IntentWarning` (message = path) that the engine surfaces as the
`bitcoin-unusual-output` warning finding. An output whose key a device entry serves that was never
confirmed on the device (§35) is in `unconfirmed`: it is never hidden and never an own-address
row — it decodes as an ordinary send plus an `unconfirmed-signer-output` warning (message =
address, `level: "danger"`), which the engine surfaces as the `bitcoin-unconfirmed-output` danger
finding. The engine's own change selection obeys the same rule:
change goes on the spending template's own change chain — sends from `btc.bip44` / `btc.bip49` no
longer migrate change to native segwit — at `min(first unused index, bound)`, where
`bound = mark + BITCOIN_GAP_LIMIT` with the same sealed mark; an index past the bound reuses index `bound` rather
than hiding funds.

Two cross-cutting hardenings land with it. Kernel prompts render every warning/danger row first
and detail rows after: a bounded prompt drops only detail rows (with a "N more lines" tail), and
when the warning rows alone do not fit the dialog the request is `unsupported` even with blind
signing on — a bound can no longer truncate a warning out of view. A hardware prompt leads with
its device line — `clear` tells the user to check the request on the device, `blind` warns —
ahead of the chain prompt's rows, its room reserved by the same bound. And for Ledger the kernel
strips the wallet's own BIP-32 derivations from every PSBT output the prompt shows before the
device sees the transaction: app-bitcoin hides a change-chain output carrying the policy's
fingerprint with no index bound, so an unusual-path own-key output the phone shows would
otherwise be hidden on the device — the stripped output renders by address on both. The React
Native session policy gains a 15-minute idle lock — on keystore hosts only a successful factor
verification re-arms it (§35); `session.touch` and other callable methods do not. On the Web,
presence-marked methods still count. The 24 h `maxSessionMs` is unchanged.

[`tests/migration/own-outputs.ts`](tests/migration/own-outputs.ts):

```ts
import type { AssetFlow, IntentWarning } from "@qntx/wallet-chains";
/**
 * Own-key Bitcoin outputs (section 34): `decodeBitcoinPsbt` takes a `BitcoinOwn` — the script hexes
 * of the group's own outputs split into discoverable `change`, `unusual`, and `unconfirmed` — and
 * reports an unusual own output as a verified outflow with `AssetFlow.ownPath` plus an
 * `unusual-own-output` `IntentWarning`, which the engine surfaces as `bitcoin-unusual-output`. An
 * output on an entry the signer never confirmed is a plain outflow with an
 * `unconfirmed-signer-output` danger warning. `BITCOIN_GAP_LIMIT` (20) bounds what counts as
 * discoverable change. Compiled only.
 */
import { EMPTY_BITCOIN_OWN } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinOwn } from "@qntx/wallet-chains/bitcoin";

/** Build the `own` argument: change, unusual ones with their paths, and unconfirmed ones. */
export function ownOutputs(
  change: ReadonlySet<string>,
  unusual: ReadonlyMap<string, string>,
  unconfirmed: ReadonlySet<string>,
): BitcoinOwn {
  return { change, unusual, unconfirmed };
}

/** No own-key outputs in the PSBT — the same decode as before. */
export function noOwnOutputs(): BitcoinOwn {
  return EMPTY_BITCOIN_OWN;
}

/** An unusual own output is a shown outflow with `ownPath`, never hidden change. */
export function unusualRow(flow: AssetFlow): string {
  return flow.ownPath === undefined ? "counterparty output" : `own output at ${flow.ownPath}`;
}

/** Map the warning to UX: the funds arrive but the wallet may not display them. */
export function unusualWarning(warning: IntentWarning): string | undefined {
  return warning.kind === "unusual-own-output" ? warning.message : undefined;
}

/** A key the device never confirmed: the message is the address and the level is `danger`. */
export function unconfirmedWarning(warning: IntentWarning): string | undefined {
  return warning.kind === "unconfirmed-signer-output" ? warning.message : undefined;
}

/** The bound the kernel hides change under, and the decoder's new two-argument shape. */
export { BITCOIN_GAP_LIMIT, decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
```

## 35. Signer confirmation, the sealed change mark and request origins

Every externally pinned key now carries whether it was confirmed on the device, and Bitcoin's
hidden-change bound comes from a kernel-sealed mark rather than the PSBT. The host-visible
changes:

1. **`bitcoin.psbt` requests carry a required `origin`** (`"internal" | "external"`) — only an
   `internal` request raises the change mark, through its signed change inputs and the change it
   hides. An `external` request may hide change inside the current window (`mark + 20`) but never
   raises the mark, so signatures it never broadcasts cannot push the wallet's scan further. The
   engine sets `internal` for its own sends; every other caller (dApp, QR counterpart, host)
   passes `"external"` (`psbtOrigin` in the snippet). Requests without `origin` are refused.
2. **`ChainAccount` gains `confirmed` on every variant** — `true` once the serving entry passed
   an on-device address check (`verify-address`); software-seed and card accounts are always
   confirmed (`accountState` in the snippet). The bitcoin variant also gains `changeMark`, the
   sealed mark the hidden-change rule of §34 now bounds by. Show an "unconfirmed — verify on the
   device" state for `confirmed: false` accounts instead of presenting the address as settled.
3. **Pairing and key-adding fetches are verification-gated.** `hardware.begin` `pair` requires
   `verify` — without it the kernel answers `invalid-input`. `hardware.begin` `accounts` answers
   `approval-required` when the pin lacks the requested paths and no `verify` was passed; pass
   `verify` and it runs one verification before the first exchange. A re-read of pinned paths
   needs neither (`startPair`, `refetch` in the snippet; `SignersController.fetchAccounts`
   accepts `{ …, verify? }`). The same holds through `hardware(wallet).start(op, { io, verify })`.
4. **`verify-address` confirms pinned entries.** A `matched: true` answer seals the serving path
   into the hardware record's `confirmed` list; confirming one account node also confirms every
   group whose account is served by it. Entries merged without a check stay unconfirmed forever.
5. **Exports of unconfirmed material need an acknowledgement.** `chain.exportAccount` (and the
   engine's `QrExportParams`/`SignStartParams`) gain `acknowledgeUnconfirmed?: true` — without it
   an export touching an unconfirmed node fails `approval-required`; with it the approval prompt
   leads with one danger row per unconfirmed node (`exportParams` in the snippet). Pass the flag
   only after showing that state; never silently.
6. **Bitcoin sends to unconfirmed keys need an acknowledgement.** An output whose key an
   unconfirmed entry serves is shown as an ordinary send with a danger row (§34) — never as your
   own address, never hidden as change. The `hardware.begin` `sign` operation gains
   `acknowledgeUnconfirmed?: true`; without it such a request fails `approval-required` before
   any prompt (`signUnconfirmed` in the snippet). The engine's signing path passes it once
   `approve` received the `bitcoin-unconfirmed-output` danger finding in `acknowledged`; that
   includes the change of a send from an account whose node was never confirmed — run
   `verify-address` once to stop it where the device can confirm the entry. A Keystone BTC
   testnet/signet or group > 0 account can never be confirmed (item 8), so every send with change
   from it asks for that danger acknowledgement forever: label such accounts permanently
   unverified, or do not offer them for sending.
7. **`nextReceiveAddress` returns `{ address, confirmed }`** — destructure `address` where you
   used the string, and surface `confirmed` next to it (`receive` in the snippet).
8. **Keystone confirmation is allow-listed** to what its Receive menu can show — EVM and TRON
   bip44-style accounts, Solana groups 0–49 and BTC mainnet account-0 receive addresses.
   `verify-address` for BTC testnet/signet, BTC group > 0 or Solana group ≥ 50 answers
   `unsupported` before any exchange: those entries can never be confirmed on a Keystone.
9. **Host-wired `chains.account` answers carry the mark and the flag.** A host that builds its
   own engine controllers (tests, custom wiring) answers the Bitcoin xpub variant of
   `AccountTreeControllerOptions.chains.account` with `{ xpub, changeMark }` and of
   `HistoryControllerOptions.chains.account` with `{ xpub, changeMark, confirmed }` and its
   address variant with `{ address, confirmed }` — the history reads a transfer to an unconfirmed
   account as a send, never as `self`, and never counts its address as known (`historyAccount` in
   the snippet). `wallet.accounts` already returns both fields.
10. **Native idle lock is verification-armed.** On keystore hosts (React Native, Node with a
    keystore) only a successful factor verification re-arms the 15-minute deadline —
    `session.touch` and other presence-marked methods no longer do. On the Web they still count.
    The absolute caps are unchanged (24 h native, 12 h Web/Node).
11. **Hyperliquid approvals name markets by `#id`.** The kernel keeps no trusted id→name map;
    the approval prompt shows the numeric asset id. Show the id next to the market name your UI
    renders — the id is what the user can check.
12. **Unconfirmed accounts are not subscribed for push and are not "known" to history.** The
    engine leaves an account whose serving entry is unconfirmed out of the push subscriptions it
    registers with the gateway, and out of the known-address set the history's
    `address-poisoning` flag compares against. Nothing to call; expect no push events for such an
    account until `verify-address` confirms it.
13. **A send that spends a change coin beyond the sealed scan reach is cross-checked.** When the
    engine's own send, replacement or CPFP would spend a change-chain coin past
    `changeScanReach(changeMark)` — a coin only the endpoint's "used" answers led to — and a second
    endpoint is configured, the engine reads the coin's transaction there first. A second endpoint
    that does not know it, or serves a different output, refuses the build with `ChainError`
    `invalid-request` ("the endpoints disagree on a far change coin") and nothing is signed; a
    failed second read adds `reads-unverified`. Treat the refusal like any other endpoint
    disagreement: retry later or switch the primary endpoint.

[`tests/migration/signer-confirmation.ts`](tests/migration/signer-confirmation.ts):

```ts
import type { VerifyFactor } from "@qntx/wallet";
import type {
  HistoryControllerOptions,
  SignersController,
  TransactionController,
} from "@qntx/wallet-engine";
import type { QrExportParams } from "@qntx/wallet-engine/qr";
import type { ChainAccount, ChainSignRequest } from "@qntx/wallet/chains";
import type { DeviceIo, HardwareApi, HardwareResult } from "@qntx/wallet/hardware";

/**
 * Signer confirmation and the sealed change mark (section 35): `bitcoin.psbt` requests carry a
 * required `origin`; every `ChainAccount` reports `confirmed` and the bitcoin variant adds
 * `changeMark`; fetches that add device keys take a `verify`; exports of — and Bitcoin sends to —
 * unconfirmed material need `acknowledgeUnconfirmed`; `nextReceiveAddress` returns `{ address,
 * confirmed }`; and a host-wired history `chains.account` answers the xpub variant with
 * `changeMark` and `confirmed`. Compiled only.
 */

/** Every `bitcoin.psbt` request declares where it came from — only "internal" raises the mark. */
export function psbtOrigin(request: ChainSignRequest): "internal" | "external" | undefined {
  return request.kind === "bitcoin.psbt" ? request.origin : undefined;
}

/** `confirmed` names an on-device check; `changeMark` is the sealed change bound (bitcoin). */
export function accountState(account: ChainAccount): {
  confirmed: boolean;
  changeMark: number | undefined;
} {
  return {
    confirmed: account.confirmed,
    changeMark: "changeMark" in account ? account.changeMark : undefined,
  };
}

/** Pairing and key-adding account fetches need a verification the host collects first. */
export function startPair(api: HardwareApi, verify: VerifyFactor): void {
  void api;
  void verify;
  // api.start({ kind: "pair", device }, { io, verify }) — verify is required.
}

/** `fetchAccounts` accepts the same `verify` and may answer `approval-required` without it. */
export function refetch(signers: SignersController, verify: VerifyFactor): void {
  void signers.fetchAccounts({
    walletId: "w",
    groupIndex: 1,
    family: "evm",
    verify,
  });
}

/** Exporting unconfirmed material needs the explicit acknowledgement. */
export function exportParams(verify: VerifyFactor): QrExportParams {
  return {
    account: { walletId: "w", groupIndex: 0 },
    form: "crypto-hdkey",
    verify,
    acknowledgeUnconfirmed: true,
  };
}

/** The receive address arrives with its confirmation state — show "unconfirmed" when false. */
export async function receive(
  transactions: TransactionController,
): Promise<{ address: string; confirmed: boolean }> {
  return transactions.nextReceiveAddress("w", 0, "bitcoin");
}

/** A send to a key the device never confirmed: show the danger row first, then acknowledge it. */
export async function signUnconfirmed(
  api: HardwareApi,
  io: DeviceIo,
  request: ChainSignRequest,
  verify: VerifyFactor,
): Promise<HardwareResult> {
  const op = api.start({ kind: "sign", request, acknowledgeUnconfirmed: true }, { io, verify });
  return op.result;
}

/** A host-wired history account: the xpub variant reports the sealed mark and confirmation. */
export const historyAccount: HistoryControllerOptions["chains"]["account"] = async (params) => {
  void params;
  await Promise.resolve();
  return { xpub: "xpub…", changeMark: 0, confirmed: false };
};
```

## 36. Change from the sealed mark, immediate confirmations and lookalike references

For a host upgrading from 0.14.0 to 0.14.1, the engine places Bitcoin change from the
kernel-sealed mark alone, and a device confirmation now takes effect without a relock. The
host-visible changes:

1. **`requestChangeMark` is removed** from `@qntx/wallet-chains/bitcoin`. Signed inputs never raise
   the change mark — for either origin — so the hidden-change window of §34 is always
   `isDiscoverableChange(output, signed, mark)` with the sealed `mark` itself (`hidesAsChange` in
   the snippet). An `internal` request raises the mark only to the highest change index it hides.
2. **The engine's change index no longer follows the endpoint.** A send, a CPFP child or a
   replacement without a change output of its own pays change to the lowest change index above the
   sealed mark that no in-flight request reserved and no tracked transaction used. A replacement
   still pays back to its parent's change address. When no such index is left the pick reuses the
   address at the reach (§37). After a seed-only restore the mark starts at 0, so change lands on
   indexes the seed already used — expect address reuse there, never hidden funds (a mark
   0.14.0 ratcheted is kept, though — §37.6).
3. **The far-coin cross-check of §35.13 is gone.** A spend of a change coin past the sealed reach
   is built like any other: the second endpoint is never asked about it, never refuses it and
   never learns its txid. Drop any handling of "the endpoints disagree on a far change coin".
4. **`SignersState.confirmations`** counts the on-device address checks `signers.verifyAddress`
   completed this session. The engine's history reloads its loaded groups and its push
   subscriptions reconcile when it moves — §35.12's "until `verify-address` confirms it" now means
   immediately. Subscribe to it to refresh your own "unconfirmed" badges (`onConfirmation`).
5. **Host-wired `HistoryControllerOptions` and `NotificationsControllerOptions` require
   `signers: Pick<SignersController, "store">`** (`wiredSigners`). `createWalletEngine` wires it.
6. **An unconfirmed own address is a lookalike reference.** History flags `lookalike-counterparty`
   for a counterparty imitating an unconfirmed own address exactly as for a confirmed one; the
   unconfirmed address itself is still not exempt — not even as the recipient of a tracked send
   (§37) — so it is flagged when it imitates a contact or
   another known address. Push still never subscribes unconfirmed accounts.

[`tests/migration/change-from-mark.ts`](tests/migration/change-from-mark.ts):

```ts
import { isDiscoverableChange } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinPathTail } from "@qntx/wallet-chains/bitcoin";
import type {
  HistoryControllerOptions,
  NotificationsControllerOptions,
  SignersController,
  SignersState,
} from "@qntx/wallet-engine";

/**
 * Change from the sealed mark and immediate confirmations (section 36): `requestChangeMark` is gone
 * — the hidden-change window is the sealed mark alone; `SignersState.confirmations` counts
 * completed on-device checks, and host-wired history and notifications controllers take the signers
 * store. Compiled only.
 */

/**
 * Where requestChangeMark(stored, …) was called: the sealed mark is the bound, inputs never widen
 * it.
 */
export function hidesAsChange(
  output: BitcoinPathTail,
  signed: ReadonlyArray<BitcoinPathTail>,
  mark: number,
): boolean {
  return isDiscoverableChange(output, signed, mark);
}

/** Re-render whatever shows "unconfirmed" when a device confirmation completes. */
export function onConfirmation(
  signers: Pick<SignersController, "store">,
  render: () => void,
): () => void {
  return signers.store.subscribe((next: SignersState, previous: SignersState) => {
    if (next.confirmations !== previous.confirmations) {
      render();
    }
  });
}

/** Host-wired controllers hand over the signers store next to the other stores they read. */
export function wiredSigners(
  signers: Pick<SignersController, "store">,
): Pick<HistoryControllerOptions, "signers"> & Pick<NotificationsControllerOptions, "signers"> {
  return { signers };
}
```

## 37. The change pick never refuses

For a host upgrading from 0.14.0 to 0.14.1:

1. **No Bitcoin send, sweep, speed-up, cancel or CPFP is refused for want of a change address.** The
   exhausted-window `invalid-request` refusal of an earlier draft of §36 never ships, so there is no
   new error to handle:
   0.14.0 reused an address, and 0.14.1 reuses the address at the window's end when the window
   is full.
2. **A sign attempt that fails before the factor verifies consumes no change index.** A cancelled
   prompt, a wrong password or a pre-verify refusal leaves `draft`/`rejected` rows whose own output
   does not count as taken — either its bytes never existed, or the mark had already sealed past
   that index when the marks committed.
3. **An internal send from a device-unconfirmed entry raises the sealed mark to its change index.**
   Display is unchanged — a plain send with a danger row behind `acknowledgeUnconfirmed` — and an
   upgraded unconfirmed account whose tracked change already fills the window reuses the window's
   last address once, after which the mark follows.
4. **Importing a software wallet onto a card keeps its change marks.** `wallet.delete` still drops
   them — a re-added wallet starts at mark 0 and walks forward past its own tracked change, reusing
   at most one address per full window.
5. **The change of an unconfirmed entry is no longer exempt from `first-recipient`/
   `address-poisoning` as a tracked recipient.**
6. **A mark 0.14.0 ratcheted stays.** Its endpoint could walk the mark one gap limit per send; the
   mark is kept, so change keeps landing at mark + 1 and beyond — past a seed-only restore's
   gap-limit-20 scan. Such coins stay visible on this device and to a restore that scans with a gap
   of at least mark + 20; a default restore does not show them, and no command lowers a mark.

## 38. Unsupported direction

For a host upgrading from 0.14.0:

1. **Every persisted artefact reports `unsupported` with a direction.** The vault status is now the
   `VaultState` object — `snapshot.vault.status` and `status` payloads — and `{ status:
   "unsupported", reason }` says which side wrote a format this build cannot read: `older`, a
   pre-1.0 build whose format has no reader here, or `newer`, a newer build. The same
   `{ status: "unsupported", reason }` surfaces on `engine.backup.list()` rows (`header` is a
   `BackupInspection`, not skipped) and on the `EngineStoreError` (`code: "unsupported"` plus
   `reason`) an IndexedDB open rejects with. Every `vault === "locked"` comparison becomes
   `vault.status === "locked"`.
2. **`older` is recoverable only by starting over — behind a confirmation, never automatically.**
   For the vault, offer restore (mnemonic, passkey or cloud backup) after an explicit
   `vault.reset` — what is lost is in "What users lose" above. For a backup file, the message is
   "this backup was made by an older version and cannot be restored — restore from the mnemonic":
   a `restore` attempt is refused `unsupported` by the kernel before any key is read.
3. **`newer` means "update the app" — never offer a reset.** A newer vault, backup envelope or
   engine database stays exactly where it is; an older app release must not clear it. A vault
   `newer` refuses every request `unsupported` until the app is updated.
4. **An `older` engine database is refused, never wiped — the host discards it.** Open rejects
   `EngineStoreError` `unsupported`/`older` and the database stays intact. On user confirmation —
   explain that the local engine data (address book, custom tokens and RPCs, watch accounts,
   connections, sign log, tracked transactions) is discarded — call
   `indexedDB.deleteDatabase(name)` and reopen; `newer` means "update the app", so rethrow.

[`tests/migration/unsupported-direction.ts`](tests/migration/unsupported-direction.ts):

```ts
import type { BackupInspection, UnsupportedReason, VaultState } from "@qntx/wallet";
import { EngineStoreError } from "@qntx/wallet-engine";
import type { EngineStore } from "@qntx/wallet-engine";

/**
 * Every persisted artefact reports `unsupported` with a direction: `older` — a pre-1.0 build wrote
 * it and this build has no reader; `newer` — a newer build wrote it. `older` is recoverable only by
 * starting over (an explicit reset, then restoring from the mnemonic, passkey or cloud backup —
 * behind a data-loss confirmation, never automatic); `newer` means "update the app" — never offer a
 * reset.
 */
export function unsupportedVaultAction(
  vault: VaultState,
): "restore-flow" | "update-app" | undefined {
  if (vault.status !== "unsupported") {
    return undefined;
  }
  return vault.reason === "older" ? "restore-flow" : "update-app";
}

/**
 * `engine.backup.list()` reports an unreadable file with its direction instead of skipping it:
 * `older` → "this backup was made by an older version — restore from the mnemonic"; `newer` →
 * "update the app to restore this backup".
 */
export function backupRowMessage(header: BackupInspection): string | undefined {
  if (header.status === "ok") {
    return undefined;
  }
  return header.reason === "older"
    ? "This backup was made by an older version and cannot be restored — restore from the mnemonic."
    : "Update the app to restore this backup.";
}

/**
 * The engine store is the one artefact with no reset: an `older` database is refused, never wiped,
 * until the host discards it. On confirmation (what is lost: address book, custom tokens/RPCs,
 * watch accounts, connections, sign log, tracked transactions) delete the database and reopen; a
 * `newer` database means "update the app" — rethrow.
 */
export async function openEngineStore(
  databaseName: string,
  open: () => Promise<EngineStore>,
  confirmDiscard: (reason: UnsupportedReason) => Promise<boolean>,
): Promise<EngineStore> {
  try {
    return await open();
  } catch (error) {
    if (
      error instanceof EngineStoreError &&
      error.code === "unsupported" &&
      error.reason === "older" &&
      (await confirmDiscard("older"))
    ) {
      // Await the deletion — `blocked` means another connection still holds the database.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.addEventListener("success", () => {
          resolve();
        });
        request.addEventListener("blocked", () => {
          reject(new Error("engine store: deleteDatabase blocked"));
        });
        request.addEventListener("error", () => {
          reject(request.error ?? new Error("engine store: deleteDatabase failed"));
        });
      });
      return open();
    }
    throw error;
  }
}
```

## 39. Name services

For a host upgrading from 0.14.1:

1. **Replace `EnsResolution` with `NameResolution`.** `engine.names.resolve` now returns
   `{ name, address, checks, risk }` and dispatches by the send network's family: ENS for EVM,
   SNS for Solana. ENS resolution itself happens on Ethereum mainnet (Sepolia for testnet sends);
   the network chooses the ENSIP-19 coin type. Non-EVM ENS input, a non-mainnet SNS network, more
   than two SNS labels, malformed labels and legacy `.sol` input are refused.
2. **Surface the name findings in the acknowledgement UI.** `NameResolution.risk` and request risk
   can contain `name-unicode` (warning: the normalized name contains non-ASCII labels) and
   `name-mixed-script` (danger: the labels span incompatible scripts). Treat `name-mixed-script`
   like the existing danger findings — an approval without its acknowledgement throws
   `AcknowledgementRequiredError`.
3. **Use `engine.names.lookup(address, network)` for display names.** A result has already passed
   endpoint agreement, normalization and a fresh forward-resolution check. `undefined` means "do not
   show a primary name", including a stale SNS primary, a tokenized/PDA-owned SNS name, malformed
   bytes, or an upstream ENS L2 reverse resolver that is unavailable; it is not a host error.
4. **Migrate `.sol` recipients to `.sns`.** SNS paused `.sol` resolution during its SRS migration.
   Do not strip or rewrite the suffix client-side; ask the user for the `.sns` name and let the
   engine validate it.
5. **Recipient names are request-pipeline state, not route input.** Sends, `evm-nft-send` and
   `solana-nft-send` accept the typed name: the engine resolves it before building the transaction,
   attaches the normalized name to matching outflows, and re-resolves before signing. If resolution
   fails or the answer changes, approval ends the request `failed` with a stale message such as
   `"alice.eth now resolves to 0x…, not 0x… — start over"`; the host re-prepares instead of retrying
   the same approval. A plain address without a dot bypasses resolution exactly as before.

[`tests/migration/name-services.ts`](tests/migration/name-services.ts):

```ts
import type { NameResolution, RiskFinding } from "@qntx/wallet-engine";

/** Display a verified primary name only; never fall back to an unchecked reverse record. */
export function primaryNameText(resolution: NameResolution | undefined): string | undefined {
  return resolution?.name;
}

/** Dangerous script mixtures need the same explicit acknowledgement path as other danger risk. */
export function nameAcknowledgementRequired(resolution: NameResolution): boolean {
  return resolution.risk.some((finding) => finding.code === "name-mixed-script");
}

/** The risk rows a host renders for a named recipient, danger first as the engine orders them. */
export function nameRiskRows(
  resolution: NameResolution,
): ReadonlyArray<Pick<RiskFinding, "code" | "level">> {
  return resolution.risk.map(({ code, level }) => ({ code, level }));
}

/** `.sol` input is a user correction during SNS's SRS migration, not a suffix the host rewrites. */
export function snsMigrationHint(recipient: string): string | undefined {
  return recipient.endsWith(".sol")
    ? "SNS names use .sns during the SRS migration — ask the owner for the .sns name."
    : undefined;
}
```
