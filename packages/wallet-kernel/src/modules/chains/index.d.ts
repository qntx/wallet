import type { CHAINS_METHODS, MethodName } from "@qntx/wallet/protocol";
import type { Handler, VaultHooks } from "../../commands/context.ts";
export type ChainsModule = {
    readonly vault: VaultHooks;
    readonly handlers: {
        [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M>;
    };
};
export declare function createChainsModule(): ChainsModule;
