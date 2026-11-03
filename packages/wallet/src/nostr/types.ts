/**
 * Public types of the @qntx/wallet/nostr subpath — the only place in this package that imports
 *
 * @qntx/nostr. Secret data never appears here.
 */
import type { Event, NostrSigner, UnsignedEvent } from "@qntx/nostr";
import type { Rumor } from "@qntx/nostr/nips/nip59";

import type {
  DerivedNostrKey,
  ExportedSecret,
  NostrKeyInfo,
  NostrKeyRef,
  UnlockFactor,
  WalletErrorCode,
} from "../types.ts";

export type { DerivedNostrKey, NostrKeyInfo, NostrKeyRef } from "../types.ts";

export type NostrUnwrapResult = { readonly ok: Rumor } | { readonly err: WalletErrorCode };

/** A proxy NostrSigner: the kernel key is resolved per call, so it survives lock/unlock cycles. */
export type WalletSigner = {
  readonly unwrapGiftWraps: (events: ReadonlyArray<Event>) => Promise<ReadonlyArray<Rumor | Error>>;
} & NostrSigner;

/**
 * The wallet metadata sync signer (WD-076): one dedicated key per wallet, derived at the reserved
 * NIP-06 segment `m/44'/1237'/2147483647'/0/0`. It authors and seals only kind-30078 metadata
 * events; `getPublicKey`/`signEvent`/`encrypt`/`decrypt` go through the kernel's nostr.sync*
 * methods with the same forged-event checks as a `WalletSigner`.
 */
export type WalletSyncSigner = {
  readonly getPublicKey: () => Promise<string>;
  readonly signEvent: (unsigned: UnsignedEvent) => Promise<Event>;
  readonly encrypt: (text: string) => Promise<string>;
  readonly decrypt: (payload: string) => Promise<string>;
};

export type NostrExportKeyFormat =
  | { readonly kind: "nsec" }
  | { readonly kind: "ncryptsec"; readonly password: string };

export type NostrApi = {
  readonly signer: (ref: NostrKeyRef) => WalletSigner;
  /** The wallet's dedicated metadata sync signer — seed-derived, never in `nostr.keys`. */
  readonly syncSigner: (walletId: string) => WalletSyncSigner;
  /** Public keys a wallet's identity indices derive — discovery before deriveKey. */
  readonly discover: (
    walletId: string,
    from: number,
    count: number,
  ) => Promise<ReadonlyArray<DerivedNostrKey>>;
  readonly deriveKey: (walletId: string, index: number) => Promise<NostrKeyInfo>;
  readonly removeKey: (ref: NostrKeyRef) => Promise<void>;
  /** One-shot key export; requires re-verification every call. */
  readonly exportKey: (
    ref: NostrKeyRef,
    format: NostrExportKeyFormat,
    verify: UnlockFactor,
  ) => Promise<ExportedSecret>;
};
