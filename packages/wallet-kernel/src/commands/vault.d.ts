import type { Factor, NullValue } from "@qntx/wallet/protocol";
import type { FactorInfo } from "@qntx/wallet/types";
import type { Secret } from "../secret/secret.ts";
import type { KernelContext } from "./context.ts";
export declare function unlockVault(ctx: KernelContext, params: {
    factor: Factor;
}): Promise<{
    session: string;
}>;
/**
 * Opens a session over `ctx.image` and rebuilds live state in one pass: every module drops stale
 * state, then the whole image reconciles in from empty — every record opens under the DEK and every
 * factor binding verifies. A failure latches corrupted and invalidates the session it just opened.
 * Shared by `vault.unlock` and the establish paths that open a session on commit.
 */
export declare function openSession(ctx: KernelContext, dek: Secret, keyId: string): string;
/**
 * Deletes every record and factor. On a keystore host the device owner proves presence first
 * (WD-055: the main runtime alone cannot erase the vault) and the hardware keys go with the data.
 */
export declare function resetVault(ctx: KernelContext): Promise<NullValue>;
/**
 * Adds a factor after re-verifying with an existing one. A password factor REPLACES the existing
 * password factor and rotates the DEK (change password): every record re-seals and every retained
 * factor re-wraps in one guarded commit — other hosts see the keyId change and invalidate. A
 * passkey or hardware factor wraps the current DEK only: no rotation, keyId unchanged. At most one
 * hardware factor exists. Kind and uniqueness are checked before the verification prompt.
 */
export declare function addFactor(ctx: KernelContext, params: {
    verify: Factor;
    factor: Factor;
}, requestSession: string | undefined): Promise<FactorInfo>;
export declare function removeFactor(ctx: KernelContext, params: {
    verify: Factor;
    id: string;
}, requestSession: string | undefined): Promise<NullValue>;
