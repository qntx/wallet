import type { Factor, NostrExportFormat, NostrImportInput, NullValue } from "@qntx/wallet/protocol";
import type { NostrKeyInfo } from "@qntx/wallet/types";
import type { KernelContext } from "../../commands/context.ts";
export declare function importKey(ctx: KernelContext, params: {
    input: NostrImportInput;
    factor?: Factor;
}, requestSession: string | undefined): Promise<{
    key: NostrKeyInfo;
    session: string;
}>;
export declare function generateKey(ctx: KernelContext, params: {
    factor?: Factor;
}, requestSession: string | undefined): Promise<{
    key: NostrKeyInfo;
    session: string;
}>;
export declare function createNip46ClientKey(ctx: KernelContext, requestSession: string | undefined): Promise<NostrKeyInfo>;
export declare function deriveKey(ctx: KernelContext, params: {
    walletId: string;
    groupIndex: number;
}, requestSession: string | undefined): Promise<NostrKeyInfo>;
export declare function discover(ctx: KernelContext, params: {
    walletId: string;
    from: number;
    count: number;
}, requestSession: string | undefined): Promise<{
    keys: Array<{
        groupIndex: number;
        publicKey: string;
    }>;
}>;
export declare function removeKey(ctx: KernelContext, params: {
    publicKey: string;
    verify?: Factor;
}, requestSession: string | undefined): Promise<NullValue>;
export declare function exportKey(ctx: KernelContext, params: {
    verify: Factor;
    publicKey: string;
    format: NostrExportFormat;
}, requestSession: string | undefined): Promise<Uint8Array>;
