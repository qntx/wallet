import type { Address, NETWORK, OutScript, TEST_NETWORK } from "@scure/btc-signer";

/**
 * Lazy Spark SDK runtime: the only kernel file that value-imports `@qntx/spark` and
 * `@scure/btc-signer`. Both packages load behind one memoized `import()` so a nostr-only session
 * never downloads or parses them; the Web/Node kernel builds code-split this module into its own
 * chunk next to the entry.
 */
import type {
  createSparkSigner,
  decodeBolt11,
  EPHEMERAL_ANCHOR_SCRIPT,
  lightningSendHtlcScript,
  sparkAccountKey,
  sparkNetworkConfig,
} from "@qntx/spark/signer";

export type SparkRuntime = {
  readonly createSparkSigner: typeof createSparkSigner;
  readonly decodeBolt11: typeof decodeBolt11;
  readonly EPHEMERAL_ANCHOR_SCRIPT: typeof EPHEMERAL_ANCHOR_SCRIPT;
  readonly lightningSendHtlcScript: typeof lightningSendHtlcScript;
  readonly sparkAccountKey: typeof sparkAccountKey;
  readonly sparkNetworkConfig: typeof sparkNetworkConfig;
  readonly Address: typeof Address;
  readonly NETWORK: typeof NETWORK;
  readonly OutScript: typeof OutScript;
  readonly TEST_NETWORK: typeof TEST_NETWORK;
};

/** Loads the runtime chunk; the spark module memoizes it per kernel and retries after a failure. */
export async function loadSparkRuntime(): Promise<SparkRuntime> {
  const [signer, btc] = await Promise.all([
    import("@qntx/spark/signer"),
    import("@scure/btc-signer"),
  ]);
  return {
    createSparkSigner: signer.createSparkSigner,
    decodeBolt11: signer.decodeBolt11,
    EPHEMERAL_ANCHOR_SCRIPT: signer.EPHEMERAL_ANCHOR_SCRIPT,
    lightningSendHtlcScript: signer.lightningSendHtlcScript,
    sparkAccountKey: signer.sparkAccountKey,
    sparkNetworkConfig: signer.sparkNetworkConfig,
    Address: btc.Address,
    NETWORK: btc.NETWORK,
    OutScript: btc.OutScript,
    TEST_NETWORK: btc.TEST_NETWORK,
  };
}
