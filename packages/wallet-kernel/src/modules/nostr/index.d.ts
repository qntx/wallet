/**
 * The nostr module: the nostr-key record kind, its signer pool, and every nostr.* command. Wired
 * once in kernel.ts — the VaultHooks give the core the explicit seams (record ownership, reconcile
 * claim/forget, lock dispose, wallet-delete ops) without the core knowing what a nostr key is;
 * `status` produces the module's snapshot section, called from status.ts.
 */
import type { NostrBackend } from "@qntx/nostr";
import type { MethodName, NOSTR_METHODS } from "@qntx/wallet/protocol";
import type { NostrKeyInfo } from "@qntx/wallet/types";
import type { Handler, VaultHooks } from "../../commands/context.ts";
import type { StoredRecord } from "../../vault/store.ts";
export type NostrModule = {
    readonly vault: VaultHooks;
    readonly handlers: {
        [M in keyof typeof NOSTR_METHODS & MethodName]: Handler<M>;
    };
    /**
     * The module's status section, parsed from its own records (status.ts partitions them by
     * ownership). A record whose header fails the module's parser reports `corrupted`.
     */
    readonly status: (records: ReadonlyArray<StoredRecord>) => {
        readonly keys: ReadonlyArray<NostrKeyInfo>;
        readonly corrupted: boolean;
    };
};
export declare function createNostrModule(backend: NostrBackend): NostrModule;
