import type {
  CooperativeExitResult,
  LightningPayment,
  SparkNetwork,
  SparkTransfer,
} from "@qntx/spark";
import type { VerifyFactor } from "@qntx/wallet";

import type { RequestCheckCode } from "../requests/checks.ts";
import type { SparkController } from "../spark/controller.ts";
import { SparkControllerError } from "../spark/errors.ts";
import type { SparkPaymentRecord } from "../spark/payments.ts";

/**
 * What the host shows for a Spark, Lightning or exit request; `family` tells it apart from a chain
 * intent.
 */
export type SparkDisplay =
  | {
      readonly family: "spark";
      readonly network: SparkNetwork;
      readonly kind: "transfer" | "lightning" | "exit";
      readonly amountSats: number;
      readonly maxFeeSats?: number;
      /** Exits only: the quoted fee; the debit is `amountSats + feeSats`. */
      readonly feeSats?: number;
      /** Spark address, Lightning payee public key (hex) or bitcoin address. */
      readonly receiver: string;
      /** Invoice description or the LNURL metadata text. */
      readonly description?: string;
    }
  | {
      readonly family: "spark";
      readonly network: SparkNetwork;
      readonly kind: "token";
      /** Bech32m token identifier (`btkn`/`btknrt`). */
      readonly tokenIdentifier: string;
      /** Decimal base units. */
      readonly amount: string;
      /** Spark address of the receiver. */
      readonly receiver: string;
    };

export type SparkResult =
  | { readonly kind: "spark"; readonly transfer: SparkTransfer }
  | { readonly kind: "lightning"; readonly payment: LightningPayment }
  | { readonly kind: "withdraw"; readonly exit: CooperativeExitResult }
  | { readonly kind: "token"; readonly transactionHash: string }
  /**
   * The commit response was lost and the payment may have gone out: `payment` is its open record,
   * which `SparkAccountState.payments` and `engine.history` keep following until the Spark operator
   * settles or fails it.
   */
  | { readonly kind: "pending"; readonly payment: SparkPaymentRecord };

/**
 * A validated, fixed Spark payment: everything that does not need the user's verification has
 * happened (including any LNURL invoice fetch), so approval only re-checks expiry and executes.
 */
export type PreparedSparkAction = {
  readonly display: SparkDisplay;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  /** Why the action can no longer be paid at `now` (an expiring invoice), if so. */
  readonly staleReason: (now: number) => string | undefined;
  /**
   * Runs the controller's approve-first payment call. `commit` is the request's point of no return
   * — the controller calls it immediately before the client call that sends, and a throw there
   * means nothing may be sent.
   */
  readonly execute: (
    spark: SparkController,
    verify: VerifyFactor,
    commit: () => void,
  ) => Promise<SparkResult>;
};

/**
 * Runs the committing call: an "unknown" controller error means the response was lost after the
 * payment may have committed — the request reports `pending` with the open payment record, never
 * `failed`.
 */
export const pendingOnUnknown = async (run: () => Promise<SparkResult>): Promise<SparkResult> => {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof SparkControllerError &&
      error.category === "unknown" &&
      error.payment !== undefined
    ) {
      return { kind: "pending", payment: error.payment };
    }
    throw error;
  }
};

/** An invoice must have more than this much life left when approved. */
export const INVOICE_EXPIRY_GRACE_MS = 60_000;

export const feeCheck = (
  amountSats: number,
  maxFeeSats: number | undefined,
): ReadonlyArray<RequestCheckCode> =>
  maxFeeSats !== undefined && maxFeeSats >= amountSats ? ["fee-exceeds-amount"] : [];
