/**
 * Public types of the @qntx/wallet/spark subpath — the only place in this package that references
 *
 * @qntx/spark, and only as types: the proxy's wire shapes are the protocol module's, checked
 * against the signer types in tests.
 */
import type { SparkSigner } from "@qntx/spark/signer";

import type { SparkAccountRef } from "../protocol/index.ts";

export type { SparkAccountRef } from "../protocol/index.ts";
export type { SparkSigner } from "@qntx/spark/signer";

export type SparkApi = {
  /**
   * The SparkSigner for one wallet account group on one network. The kernel owns the signer pool —
   * `dispose()` on the proxy is a no-op so closing a SparkClient cannot affect other clients of the
   * same wallet.
   */
  readonly signer: (ref: SparkAccountRef) => SparkSigner;
};
