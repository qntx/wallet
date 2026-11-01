import type { Factor } from "@qntx/wallet/protocol";
import type { KernelContext } from "./context.ts";
/** One-shot export: the mnemonic as UTF-8 bytes (the host wraps it in a wipeable buffer). */
export declare function exportMnemonic(ctx: KernelContext, params: {
    verify: Factor;
    walletId: string;
}, requestSession: string | undefined): Promise<Uint8Array>;
/**
 * Random per-purpose data key, generated on first use and stored per vault: stable across
 * lock/unlock and DEK rotation, lost on reset or on a restore to another device (callers must be
 * able to rebuild the data from it).
 */
export declare function getDataKey(ctx: KernelContext, params: {
    purpose: string;
}, requestSession: string | undefined): Promise<Uint8Array>;
