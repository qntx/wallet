import { bytesToHex } from "@noble/hashes/utils.js";

import { decodeBolt11, encodeSparkAddress, parseSparkInvoice } from "@qntx/spark";
import type { LightningInvoice } from "@qntx/spark";
import { requestInvoice, submitWithdraw } from "@qntx/spark/lnurl";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { SparkController } from "../spark/controller.ts";
import { SparkControllerError } from "../spark/errors.ts";
import { INVOICE_EXPIRY_GRACE_MS, feeCheck } from "./action.ts";
import type { PreparedSparkAction } from "./action.ts";
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
};

export type PayContext = {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
};

const lightningDetails = (
  invoice: string,
): { readonly payee: string; readonly expiresAt: number } => {
  const decoded = decodeBolt11(invoice);
  return {
    payee: bytesToHex(decoded.payee),
    expiresAt: (decoded.timestamp + decoded.expirySeconds) * 1000,
  };
};

/**
 * Validates one parsed payment option and fixes everything the approval needs — including the
 * LNURL-pay invoice, fetched here exactly once. Every input validation happens before the approval
 * round, so a `PaymentError` here never consumed a verification. `lnurl-withdraw` receives funds
 * and has its own entry, {@link withdrawLnurl}.
 */
export async function preparePay(
  context: PayContext,
  params: PayParams,
): Promise<PreparedSparkAction> {
  const ref = params.account;
  const { network } = ref;
  if (params.option.kind === "lnurl-withdraw") {
    throw new PaymentError(
      "invalid-input",
      "lnurl-withdraw receives funds: use payments.withdrawLnurl",
    );
  }
  switch (params.option.kind) {
    case "spark": {
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "spark payment: amountSats is required");
      }
      const { address } = params.option;
      const { amountSats } = params;
      return {
        display: { family: "spark", network, kind: "transfer", amountSats, receiver: address },
        checks: [],
        staleReason: () => undefined,
        execute: async (spark, verify) => ({
          kind: "spark",
          transfer: await spark.send(ref, { receiver: address, amountSats, verify }),
        }),
      };
    }
    case "spark-invoice": {
      const { option } = params;
      if (option.expiresAt !== undefined && option.expiresAt <= context.now()) {
        throw new PaymentError("rejected", "spark invoice expired");
      }
      if (
        option.amountSats !== undefined &&
        params.amountSats !== undefined &&
        params.amountSats !== option.amountSats
      ) {
        throw new PaymentError(
          "invalid-input",
          "spark invoice: amountSats conflicts with the invoice amount",
        );
      }
      const amountSats = option.amountSats ?? params.amountSats;
      if (amountSats === undefined) {
        throw new PaymentError(
          "invalid-input",
          "spark invoice: amountless invoice requires amountSats",
        );
      }
      // A fixed-amount invoice derives the amount itself — only an open one takes the caller's.
      const openAmount = option.amountSats === undefined ? params.amountSats : undefined;
      const parsed = parseSparkInvoice(option.invoice, { network, now: context.now() });
      const { expiresAt } = option;
      return {
        display: {
          family: "spark",
          network,
          kind: "transfer",
          amountSats,
          receiver: encodeSparkAddress({
            network,
            identityPublicKey: parsed.receiverIdentityPublicKey,
          }),
          ...(option.memo === undefined ? {} : { description: option.memo }),
        },
        checks: [],
        staleReason: (now) =>
          expiresAt !== undefined && expiresAt <= now ? "spark invoice expired" : undefined,
        execute: async (spark, verify) => ({
          kind: "spark",
          transfer: await spark.paySparkInvoice(ref, {
            invoice: option.invoice,
            ...(openAmount === undefined ? {} : { amountSats: openAmount }),
            verify,
          }),
        }),
      };
    }
    case "lightning": {
      const { option } = params;
      if (option.amountSats === undefined && params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "amountless invoice: amountSats is required");
      }
      if (params.maxFeeSats === undefined) {
        throw new PaymentError("invalid-input", "lightning payment: maxFeeSats is required");
      }
      if (option.expiresAt <= context.now() + INVOICE_EXPIRY_GRACE_MS) {
        throw new PaymentError("rejected", "lightning invoice expired");
      }
      if (
        option.amountSats !== undefined &&
        params.amountSats !== undefined &&
        params.amountSats !== option.amountSats
      ) {
        throw new PaymentError("invalid-input", "amountSats conflicts with the invoice amount");
      }
      const { maxFeeSats } = params;
      // amountSats is only for amountless invoices — a fixed-amount invoice must not carry it.
      const openAmount = option.amountSats === undefined ? params.amountSats : undefined;
      const amountSats = option.amountSats ?? params.amountSats ?? 0;
      const { payee } = lightningDetails(option.invoice);
      const { expiresAt } = option;
      return {
        display: {
          family: "spark",
          network,
          kind: "lightning",
          amountSats,
          maxFeeSats,
          receiver: payee,
          ...(option.description === undefined ? {} : { description: option.description }),
        },
        checks: feeCheck(amountSats, maxFeeSats),
        staleReason: (now) =>
          expiresAt <= now + INVOICE_EXPIRY_GRACE_MS ? "lightning invoice expired" : undefined,
        execute: async (spark, verify) => ({
          kind: "lightning",
          payment: await spark.payInvoice(ref, {
            invoice: option.invoice,
            maxFeeSats,
            ...(openAmount === undefined ? {} : { amountSats: openAmount }),
            verify,
          }),
        }),
      };
    }
    case "lnurl-pay": {
      const { request } = params.option;
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "lnurl-pay: amountSats is required");
      }
      if (params.maxFeeSats === undefined) {
        throw new PaymentError("invalid-input", "lnurl-pay: maxFeeSats is required");
      }
      const { amountSats, maxFeeSats } = params;
      const amountMsat = amountSats * 1000;
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
          network,
          amountMsat,
          ...(params.comment === undefined ? {} : { comment: params.comment }),
        });
      } catch (error) {
        if (error instanceof PaymentError || error instanceof SparkControllerError) {
          throw error;
        }
        throw new PaymentError("network", "lnurl-pay: invoice request failed", error);
      }
      const { invoice } = requested;
      const { payee, expiresAt } = lightningDetails(invoice);
      return {
        display: {
          family: "spark",
          network,
          kind: "lightning",
          amountSats,
          maxFeeSats,
          receiver: payee,
          description: request.description,
        },
        checks: feeCheck(amountSats, maxFeeSats),
        staleReason: (now) =>
          expiresAt <= now + INVOICE_EXPIRY_GRACE_MS ? "lightning invoice expired" : undefined,
        execute: async (spark, verify) => ({
          kind: "lightning",
          payment: await spark.payInvoice(ref, { invoice, maxFeeSats, verify }),
        }),
      };
    }
    default: {
      if (params.amountSats === undefined) {
        throw new PaymentError("invalid-input", "bitcoin payment: amountSats is required");
      }
      const { address } = params.option;
      const { amountSats, maxFeeSats } = params;
      const speed = params.speed ?? "MEDIUM";
      return {
        display: {
          family: "spark",
          network,
          kind: "exit",
          amountSats,
          ...(maxFeeSats === undefined ? {} : { maxFeeSats }),
          receiver: address,
        },
        checks: feeCheck(amountSats, maxFeeSats),
        staleReason: () => undefined,
        execute: async (spark, verify) => ({
          kind: "withdraw",
          exit: await spark.withdraw(ref, {
            address,
            speed,
            verify,
            amountSats,
            ...(maxFeeSats === undefined ? {} : { maxFeeSats }),
          }),
        }),
      };
    }
  }
}

export type WithdrawLnurlParams = {
  readonly account: SparkAccountRef;
  readonly option: Extract<PaymentOption, { kind: "lnurl-withdraw" }>;
  readonly amountSats: number;
};

/**
 * LNURL-withdraw: asks the service to pay an invoice this wallet creates. It receives funds, so it
 * needs no verification factor and does not go through the request pipeline.
 */
export async function withdrawLnurl(
  context: PayContext & { readonly spark: SparkController },
  params: WithdrawLnurlParams,
): Promise<{ readonly kind: "lnurl-withdraw"; readonly invoice: LightningInvoice }> {
  const { request } = params.option;
  const amountMsat = params.amountSats * 1000;
  if (amountMsat < request.minWithdrawableMsat || amountMsat > request.maxWithdrawableMsat) {
    throw new PaymentError("rejected", "lnurl-withdraw: amount outside the service's range");
  }
  const invoice = await context.spark.createInvoice(params.account, {
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
  return { kind: "lnurl-withdraw", invoice };
}
