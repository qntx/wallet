import type { Event } from "@qntx/nostr";
import type { SignedEvent, UnsignedEventInput, UnwrapResult } from "@qntx/wallet/protocol";
import type { KernelContext } from "../../commands/context.ts";
import type { SignerPool } from "./pool.ts";
export declare function sign(ctx: KernelContext, pool: SignerPool, params: {
    publicKey: string;
    event: UnsignedEventInput;
}, requestSession: string | undefined): Promise<SignedEvent>;
export declare function nip04Encrypt(ctx: KernelContext, pool: SignerPool, params: {
    publicKey: string;
    peer: string;
    text: string;
}, requestSession: string | undefined): Promise<string>;
export declare function nip04Decrypt(ctx: KernelContext, pool: SignerPool, params: {
    publicKey: string;
    peer: string;
    text: string;
}, requestSession: string | undefined): Promise<string>;
export declare function nip44Encrypt(ctx: KernelContext, pool: SignerPool, params: {
    publicKey: string;
    peer: string;
    text: string;
}, requestSession: string | undefined): Promise<string>;
export declare function nip44Decrypt(ctx: KernelContext, pool: SignerPool, params: {
    publicKey: string;
    peer: string;
    text: string;
}, requestSession: string | undefined): Promise<string>;
export declare function unwrapGiftWraps(ctx: KernelContext, pool: SignerPool, params: {
    publicKey: string;
    events: ReadonlyArray<Event>;
}, requestSession: string | undefined): Promise<{
    results: ReadonlyArray<UnwrapResult>;
}>;
