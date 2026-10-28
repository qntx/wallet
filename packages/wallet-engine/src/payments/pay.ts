import type {
  CooperativeExitResult,
  LightningInvoice,
  LightningPayment,
  SparkTransfer,
} from "@qntx/spark";
import { requestInvoice, submitWithdraw } from "@qntx/spark/lnurl";
import type { UnlockFactor } from "@qntx/wallet";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { SparkController } from "../spark/controller.ts";
import { SparkControllerError } from "../spark/errors.ts";
import { PaymentError } from "./errors.ts";
import type { PaymentOption } from "./parse.ts";

export type PayParams = {
  readonly account: SparkAccountRef;
  readonly option: PaymentOption;
  /** Caller-supplied amount — required by open invoices, the `spark` option, and LNURL flows. */
  readonly amountSats?: number;
  readonly comment?: string;
  readonly maxFeeSats?: number;
  readonly speed?: "FAST" | "MEDIUM" | "SLOW";
  readonly verify: UnlockFactor;
};

export type PayContext = {
  readonly spark: SparkController;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
};

export type PayResult =
  | { readonly kind: "spark"; readonly transfer: SparkTransfer }
  | { readonly kind: "lightning"; readonly payment: LightningPayment }
  | { readonly kind: "withdraw"; readonly exit: CooperativeExitResult }
  | { readonly kind: "lnurl-withdraw"; readonly invoice: LightningInvoice };

/**
 * Executes one parsed payment option. Every input validation happens before the approval round — a
 * `PaymentError` here never consumed a verification. `SparkControllerError` and `WalletError` pass
 * through untouched.
 */
export async function pay(context: PayContext, params: PayParams): Promise<PayResult> {
  const { spark } = context;
  const ref = params.account;
  let result: PayResult;
  switch (params.option.kind) {
    case "spark": {
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "spark payment: amountSats is required");
      }
      const transfer = await spark.send(ref, {
        receiver: params.option.address,
        amountSats: params.amountSats,
        verify: params.verify,
      });
      result = { kind: "spark", transfer };
      break;
    }
    case "spark-invoice": {
      if (params.option.expiresAt !== undefined && params.option.expiresAt <= context.now()) {
        throw new PaymentError("rejected", "spark invoice expired");
      }
      if (
        params.option.amountSats !== undefined &&
        params.amountSats !== undefined &&
        params.amountSats !== params.option.amountSats
      ) {
        throw new PaymentError(
          "invalid-input",
          "spark invoice: amountSats conflicts with the invoice amount",
        );
      }
      // A fixed-amount invoice derives the amount itself — only an open one takes the caller's.
      const invoiceAmount = params.option.amountSats === undefined ? params.amountSats : undefined;
      const transfer = await spark.paySparkInvoice(ref, {
        invoice: params.option.invoice,
        ...(invoiceAmount === undefined ? {} : { amountSats: invoiceAmount }),
        verify: params.verify,
      });
      result = { kind: "spark", transfer };
      break;
    }
    case "lightning": {
      if (params.option.amountSats === undefined && params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "amountless invoice: amountSats is required");
      }
      if (params.maxFeeSats === undefined) {
        throw new PaymentError("invalid-input", "lightning payment: maxFeeSats is required");
      }
      // amountSats is only for amountless invoices — a fixed-amount invoice must not carry it.
      if (params.option.expiresAt <= context.now() + 60_000) {
        throw new PaymentError("rejected", "lightning invoice expired");
      }
      if (
        params.option.amountSats !== undefined &&
        params.amountSats !== undefined &&
        params.amountSats !== params.option.amountSats
      ) {
        throw new PaymentError("invalid-input", "amountSats conflicts with the invoice amount");
      }
      const payment = await spark.payInvoice(ref, {
        invoice: params.option.invoice,
        maxFeeSats: params.maxFeeSats,
        ...(params.option.amountSats === undefined && params.amountSats !== undefined
          ? { amountSats: params.amountSats }
          : {}),
        verify: params.verify,
      });
      result = { kind: "lightning", payment };
      break;
    }
    case "lnurl-pay": {
      const { request } = params.option;
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "lnurl-pay: amountSats is required");
      }
      if (params.maxFeeSats === undefined) {
        throw new PaymentError("invalid-input", "lnurl-pay: maxFeeSats is required");
      }
      const amountMsat = params.amountSats * 1000;
      if (amountMsat < request.minSendableMsat || amountMsat > request.maxSendableMsat) {
        throw new PaymentError("rejected", "lnurl-pay: amount outside the service's range");
      }
      if (request.commentAllowed === 0 && params.comment !== undefined) {
        throw new PaymentError("rejected", "lnurl-pay: comments not accepted by this service");
      }
      if (params.comment !== undefined && params.comment.length > request.commentAllowed) {
        throw new PaymentError("rejected", "lnurl-pay: comment exceeds the service's limit");
      }
      let requested;
      try {
        requested = await requestInvoice(request, {
          fetch: context.fetch,
          network: ref.network,
          amountMsat,
          ...(params.comment === undefined ? {} : { comment: params.comment }),
        });
      } catch (error) {
        if (error instanceof PaymentError || error instanceof SparkControllerError) {
          throw error;
        }
        throw new PaymentError("network", "lnurl-pay: invoice request failed", error);
      }
      const payment = await spark.payInvoice(ref, {
        invoice: requested.invoice,
        maxFeeSats: params.maxFeeSats,
        verify: params.verify,
      });
      result = { kind: "lightning", payment };
      break;
    }
    case "lnurl-withdraw": {
      const { request } = params.option;
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "lnurl-withdraw: amountSats is required");
      }
      const amountMsat = params.amountSats * 1000;
      if (amountMsat < request.minWithdrawableMsat || amountMsat > request.maxWithdrawableMsat) {
        throw new PaymentError("rejected", "lnurl-withdraw: amount outside the service's range");
      }
      const invoice = await spark.createInvoice(ref, {
        amountSats: params.amountSats,
        memo: request.defaultDescription,
      });
      try {
        await submitWithdraw(request, { fetch: context.fetch, invoice: invoice.invoice });
      } catch (error) {
        if (error instanceof PaymentError || error instanceof SparkControllerError) {
          throw error;
        }
        throw new PaymentError("network", "lnurl-withdraw: submission failed", error);
      }
      result = { kind: "lnurl-withdraw", invoice };
      break;
    }
    case "bitcoin": {
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "bitcoin payment: amountSats is required");
      }
      const exit = await spark.withdraw(ref, {
        address: params.option.address,
        speed: params.speed ?? "MEDIUM",
        verify: params.verify,
        amountSats: params.amountSats,
        ...(params.maxFeeSats === undefined ? {} : { maxFeeSats: params.maxFeeSats }),
      });
      result = { kind: "withdraw", exit };
      break;
    }
  }
  return result;
}
