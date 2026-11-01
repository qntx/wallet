/**
 * Lazy Spark SDK runtime: the only kernel file that value-imports `@qntx/spark`. It loads behind
 * one memoized `import()` so a nostr-only session never downloads or parses it; the Web/Node kernel
 * builds code-split this module into its own chunk next to the entry.
 */
import type { bitcoinAddressScript, createSparkSigner, decodeBolt11, EPHEMERAL_ANCHOR_SCRIPT, lightningSendHtlcScript, sparkAccountKey, sparkNetworkConfig } from "@qntx/spark/signer";
export type SparkRuntime = {
    readonly bitcoinAddressScript: typeof bitcoinAddressScript;
    readonly createSparkSigner: typeof createSparkSigner;
    readonly decodeBolt11: typeof decodeBolt11;
    readonly EPHEMERAL_ANCHOR_SCRIPT: typeof EPHEMERAL_ANCHOR_SCRIPT;
    readonly lightningSendHtlcScript: typeof lightningSendHtlcScript;
    readonly sparkAccountKey: typeof sparkAccountKey;
    readonly sparkNetworkConfig: typeof sparkNetworkConfig;
};
/** Loads the runtime chunk; the spark module memoizes it per kernel and retries after a failure. */
export declare function loadSparkRuntime(): Promise<SparkRuntime>;
