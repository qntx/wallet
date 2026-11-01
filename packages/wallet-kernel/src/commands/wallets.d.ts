import type { CreateWithPasskeyParams, Factor, NullValue, RestoreWithPasskeyParams } from "@qntx/wallet/protocol";
import type { WalletInfo } from "@qntx/wallet/types";
import type { KernelPlatform } from "../platform.ts";
import { Secret } from "../secret/secret.ts";
import type { EntropyHeader } from "../vault/headers.ts";
import type { StoredRecord } from "../vault/store.ts";
import type { KernelContext } from "./context.ts";
type WalletMaterial = {
    readonly walletId: string;
    readonly entropy: Uint8Array;
    readonly words: EntropyHeader["words"];
    readonly origin: EntropyHeader["origin"];
};
/** Entropy → master → walletId. `entropy` is not consumed. */
export declare function walletMaterial(platform: KernelPlatform, entropy: Uint8Array, origin: EntropyHeader["origin"], words: EntropyHeader["words"]): Promise<WalletMaterial>;
export declare function walletInfoOf(material: WalletMaterial, backup: WalletInfo["backup"], createdAt: number): WalletInfo;
/** The entropy record for a new wallet, sealed under `dek`. Consumes nothing. */
export declare function walletRecord(ctx: KernelContext, dek: Secret, material: WalletMaterial, backup: WalletInfo["backup"], createdAt: number): StoredRecord;
/**
 * The dynamic gate on every "create or import" command: with an uninitialized vault `factor` is
 * required and the command must commit through `init`; with an established vault `factor` must be
 * absent and the request must carry the live session.
 */
export declare function gate(ctx: KernelContext, factor: Factor | undefined, requestSession: string | undefined): {
    readonly uninitialized: boolean;
    readonly dek: Secret;
};
/**
 * Commits a create/import command. On the uninitialized path the vault (meta + factor + records) is
 * established in ONE `init` commit; a racing establish makes the commit fail with `conflict` and
 * nothing is written. On the initialized path only the records are appended under the live session
 * DEK, guarded by `expect-revision`. Returns the session id.
 */
export declare function commitRecords(ctx: KernelContext, gated: {
    readonly uninitialized: boolean;
    readonly dek: Secret;
}, factor: Factor | undefined, records: StoredRecord[]): Promise<string>;
export declare function createMnemonic(ctx: KernelContext, params: {
    words: 12 | 24;
    factor?: Factor;
}, requestSession: string | undefined): Promise<{
    draft: string;
    words: Uint8Array;
    quiz: ReadonlyArray<number>;
}>;
export declare function confirmMnemonic(ctx: KernelContext, params: {
    draft: string;
    answers: ReadonlyArray<Uint8Array>;
}): Promise<{
    wallet: WalletInfo;
    session: string;
}>;
export declare function discardMnemonic(ctx: KernelContext, params: {
    draft: string;
}): NullValue;
export declare function mnemonicWords(entropy: Uint8Array): EntropyHeader["words"];
export declare function importMnemonic(ctx: KernelContext, params: {
    mnemonic: Uint8Array;
    factor?: Factor;
}, requestSession: string | undefined): Promise<{
    wallet: WalletInfo;
    session: string;
}>;
/**
 * Creates or restores a passkey wallet. The ceremony runs where the platform puts it: in the kernel
 * when a platform authenticator exists, in the host (evidence on the wire) otherwise — the other
 * shape is `factor-unavailable`.
 */
export declare function createWithPasskey(ctx: KernelContext, params: CreateWithPasskeyParams | RestoreWithPasskeyParams, requestSession: string | undefined): Promise<{
    wallet: WalletInfo;
    session: string;
}>;
export declare function deleteWallet(ctx: KernelContext, params: {
    verify: Factor;
    walletId: string;
}, requestSession: string | undefined): Promise<NullValue>;
export {};
