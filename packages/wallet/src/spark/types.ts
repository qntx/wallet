/**
 * Public types of the @qntx/wallet/spark subpath — the only place in this package that references
 *
 * @qntx/spark, and only as types: the proxy's wire shapes are the protocol module's, checked
 * against the signer types in tests.
 */
import type { SparkSigner } from "@qntx/spark/signer";

import type {
  SparkAccountRef,
  SparkApprovalSummary,
  SparkApproveIntent,
} from "../protocol/index.ts";
import type { UnlockFactor } from "../types.ts";

export type {
  SparkAccountRef,
  SparkApprovalSummary,
  SparkApproveIntent,
} from "../protocol/index.ts";
export type { SparkSigner } from "@qntx/spark/signer";

export type SparkApi = {
  /**
   * The SparkSigner for one wallet account group on one network. The kernel owns the signer pool —
   * `dispose()` on the proxy is a no-op so closing a SparkClient cannot affect other clients of the
   * same wallet.
   */
  readonly signer: (ref: SparkAccountRef) => SparkSigner;
  /**
   * Register a 60-second outflow approval for an account. `verify` re-verifies the session's factor
   * (same as `exportMnemonic`); the kernel returns its own decode of the intent — the
   * receivers/amounts or invoice payment hash and amount it will match future signatures against —
   * never host-provided text. `verify` is the same re-verification factor as `exportMnemonic`
   * (Web/Node: passkey or password).
   */
  readonly approve: (params: {
    readonly account: SparkAccountRef;
    readonly intent: SparkApproveIntent;
    readonly verify: UnlockFactor;
  }) => Promise<SparkApprovalSummary>;
};
