import type {
  CooperativeExitResult,
  LightningPayment,
  SparkNetwork,
  SparkTransfer,
} from "@qntx/spark";
import type { UnlockFactor } from "@qntx/wallet";

import type { RequestCheckCode } from "../requests/checks.ts";
import type { SparkController } from "../spark/controller.ts";

/**
 * What the host shows for a Spark, Lightning or exit request; `family` tells it apart from a chain
 * intent.
 */
export type SparkDisplay = {
  readonly family: "spark";
  readonly network: SparkNetwork;
  readonly kind: "transfer" | "lightning" | "exit";
  readonly amountSats: number;
  readonly maxFeeSats?: number;
  /** Spark address, Lightning payee public key (hex) or bitcoin address. */
  readonly receiver: string;
  /** Invoice description or the LNURL metadata text. */
  readonly description?: string;
};

export type SparkResult =
  | { readonly kind: "spark"; readonly transfer: SparkTransfer }
  | { readonly kind: "lightning"; readonly payment: LightningPayment }
  | { readonly kind: "withdraw"; readonly exit: CooperativeExitResult };

/**
 * A validated, fixed Spark payment: everything that does not need the user's verification has
 * happened (including any LNURL invoice fetch), so approval only re-checks expiry and executes.
 */
export type PreparedSparkAction = {
  readonly display: SparkDisplay;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  /** Why the action can no longer be paid at `now` (an expiring invoice), if so. */
  readonly staleReason: (now: number) => string | undefined;
  /** Runs the controller's approve-first payment call. */
  readonly execute: (spark: SparkController, verify: UnlockFactor) => Promise<SparkResult>;
};

/** An invoice must have more than this much life left when approved. */
export const INVOICE_EXPIRY_GRACE_MS = 60_000;

export const feeCheck = (
  amountSats: number,
  maxFeeSats: number | undefined,
): ReadonlyArray<RequestCheckCode> =>
  maxFeeSats !== undefined && maxFeeSats >= amountSats ? ["fee-exceeds-amount"] : [];
