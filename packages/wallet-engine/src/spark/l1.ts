import type { SparkNetwork } from "@qntx/spark";

/** The bitcoin network each Spark network settles on; deposits and exits must agree with it. */
export const SPARK_L1_NETWORK: Readonly<Record<SparkNetwork, string>> = {
  mainnet: "bip122:000000000019d6689c085ae165831e93",
  regtest: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
};
