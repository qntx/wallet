/**
 * The WebLN (`window.webln`) handler — the bridge routes `provider: "webln"` messages here.
 * `enable` asks for a `lightning` connection approval when the origin is not yet authorized;
 * `sendPayment` and `lnurl` pay through the request pipeline's `pay` (a funds request with a
 * factor) and then poll `paymentStatus` for the settled preimage; `makeInvoice` goes through the
 * factor-free `webln-invoice`; `getBalance` additionally needs the session's
 * `lightningPolicy.balance`; `getInfo` exposes only the configured alias and methods.
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import type { LightningPayment } from "@qntx/spark";
import type { SparkAccountRef, SparkNetwork } from "@qntx/wallet/protocol";

import type { PaymentOption } from "../payments/parse.ts";
import { parsePayment } from "../payments/parse.ts";
import type { RequestController } from "../requests/controller.ts";
import type { SparkController } from "../spark/controller.ts";
import type { ConnectionController } from "./controller.ts";
import { LIGHTNING_METHODS } from "./controller.ts";
import {
  invalidParams,
  paymentPending,
  ProviderError,
  unauthorized,
  unsupportedMethod,
} from "./errors.ts";

/** A WebLN method call from the page. */
export type WeblnRequest = {
  readonly method: string;
  readonly params?: unknown;
};

export type WeblnHandlerOptions = {
  readonly connections: Pick<
    ConnectionController,
    | "checkOrigin"
    | "authorize"
    | "session"
    | "sessionAccounts"
    | "lightningPolicy"
    | "request"
    | "touch"
  >;
  readonly requests: Pick<RequestController, "prepare" | "outcome">;
  readonly spark: Pick<SparkController, "accountBalance" | "paymentStatus">;
  /** The Spark network the account's signer runs on. */
  readonly sparkNetwork: SparkNetwork;
  readonly now: () => number;
  /** The node's display alias — host-configured, never a pubkey. */
  readonly alias: string;
  /** The host's lightning fee cap — `pay`'s `maxFeeSats` comes from here. */
  readonly lightningMaxFee: (amountSats: number) => number;
  /** The injected wait for the preimage poll. */
  readonly sleep: (ms: number) => Promise<void>;
};

const MAX_MEMO_LENGTH = 640;
const PREIMAGE_POLL_START_MS = 1000;
const PREIMAGE_POLL_MAX_MS = 8000;
const PREIMAGE_POLL_BUDGET_MS = 60000;

const NOT_SETTLED = "the payment has not settled yet and may still settle; do not retry it";

/** A committed payment whose answer was lost: it may still settle under its transfer id. */
const unknownOutcome = (transferId: string): ProviderError =>
  paymentPending(
    `the payment outcome is unknown: it may still settle under transfer ${transferId}; do not retry it`,
  );

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const checkString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") {
    throw invalidParams(`${name} must be a non-empty string`);
  }
  return value;
};

const checkAmount = (value: unknown, name: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw invalidParams(`${name} must be a non-negative safe integer`);
  }
  return n;
};

const checkInvoiceArgs = (
  params: unknown,
): { readonly amountSats: number; readonly memo?: string } => {
  const args = isObject(params) ? params : {};
  const amount =
    checkAmount(args["amount"], "makeInvoice amount") ??
    checkAmount(args["defaultAmount"], "makeInvoice defaultAmount");
  checkAmount(args["minimumAmount"], "makeInvoice minimumAmount");
  checkAmount(args["maximumAmount"], "makeInvoice maximumAmount");
  if (amount === undefined) {
    throw invalidParams("makeInvoice needs an amount or a defaultAmount");
  }
  const memo = args["defaultMemo"];
  if (memo !== undefined && (typeof memo !== "string" || memo.length > MAX_MEMO_LENGTH)) {
    throw invalidParams("makeInvoice defaultMemo must be a string at most 640 characters");
  }
  return { amountSats: amount, ...(typeof memo === "string" ? { memo } : {}) };
};

const checkMaxFee = (fn: (n: number) => number, amountSats: number): number => {
  const maxFee = fn(amountSats);
  if (!Number.isSafeInteger(maxFee) || maxFee < 0) {
    throw new ProviderError(-32603, "invalid lightning fee cap");
  }
  return maxFee;
};

export class WeblnHandler {
  private readonly options: WeblnHandlerOptions;

  constructor(options: WeblnHandlerOptions) {
    this.options = options;
  }

  /** The session's `lightning` binding as a Spark ref — the group the session authorized. */
  private ref(origin: string): SparkAccountRef {
    const group = this.options.connections.sessionAccounts(origin, "lightning")?.group;
    if (group === undefined) {
      throw unauthorized("no lightning account is bound to the session");
    }
    return { ...group, network: this.options.sparkNetwork };
  }

  async handle(origin: string, request: WeblnRequest): Promise<unknown> {
    if (request.method === "enable") {
      if (this.options.connections.lightningPolicy(origin) === undefined) {
        await this.options.connections.request(origin, { kind: "connect", namespace: "lightning" });
      }
      await this.options.connections.touch(origin);
      return true;
    }
    this.options.connections.authorize(origin, "lightning", request.method);
    await this.options.connections.touch(origin);
    const ref = this.ref(origin);
    switch (request.method) {
      case "getInfo":
        return { node: { alias: this.options.alias }, methods: [...LIGHTNING_METHODS] };
      case "sendPayment":
        return this.sendPayment(origin, ref, request.params);
      case "makeInvoice":
        return this.makeInvoice(origin, ref, request.params);
      case "lnurl":
        return this.lnurl(origin, ref, request.params);
      case "getBalance":
        return this.getBalance(origin);
      default:
        throw unsupportedMethod(request.method);
    }
  }

  private async sendPayment(
    origin: string,
    ref: SparkAccountRef,
    params: unknown,
  ): Promise<unknown> {
    const invoice = checkString(params, "sendPayment invoice");
    const option = this.lightningOption(ref, invoice);
    if (option.amountSats === undefined) {
      throw invalidParams("sendPayment needs a fixed-amount invoice");
    }
    const maxFeeSats = checkMaxFee(this.options.lightningMaxFee, option.amountSats);
    const pending = await this.options.requests.prepare({
      method: "pay",
      origin: { kind: "browser", origin },
      account: ref,
      option,
      maxFeeSats,
    });
    const outcome = await this.options.requests.outcome(pending.id);
    if (!("kind" in outcome) || outcome.kind !== "lightning") {
      if ("kind" in outcome && outcome.kind === "pending") {
        throw unknownOutcome(outcome.transferId);
      }
      throw new ProviderError(-32603, "the lightning payment settled unexpectedly");
    }
    return this.preimage(ref, outcome.payment);
  }

  private async makeInvoice(
    origin: string,
    ref: SparkAccountRef,
    params: unknown,
  ): Promise<unknown> {
    const { amountSats, memo } = checkInvoiceArgs(params);
    const pending = await this.options.requests.prepare({
      method: "webln-invoice",
      origin: { kind: "browser", origin },
      ref,
      amountSats,
      ...(memo === undefined ? {} : { memo }),
    });
    const outcome = await this.options.requests.outcome(pending.id);
    if (!("kind" in outcome) || outcome.kind !== "lightning.invoice") {
      throw new ProviderError(-32603, "the invoice request settled unexpectedly");
    }
    return { paymentRequest: outcome.paymentRequest };
  }

  private async lnurl(origin: string, ref: SparkAccountRef, params: unknown): Promise<unknown> {
    const text = checkString(params, "lnurl");
    const parsed = parsePayment(text, { network: ref.network, now: this.options.now() });
    if (parsed.kind !== "request") {
      throw invalidParams("lnurl is not an LNURL-pay request");
    }
    if (parsed.request.options.some((o) => o.kind === "lnurl-withdraw")) {
      throw unsupportedMethod("lnurl-withdraw");
    }
    const option = parsed.request.options.find((o) => o.kind === "lnurl-pay");
    if (option === undefined || option.kind !== "lnurl-pay") {
      throw invalidParams("lnurl is not an LNURL-pay request");
    }
    const amountSats = Math.ceil(option.request.minSendableMsat / 1000);
    const maxFeeSats = checkMaxFee(this.options.lightningMaxFee, amountSats);
    const pending = await this.options.requests.prepare({
      method: "pay",
      origin: { kind: "browser", origin },
      account: ref,
      option,
      amountSats,
      maxFeeSats,
      amountFromServiceMinimum: true,
    });
    const outcome = await this.options.requests.outcome(pending.id);
    if (!("kind" in outcome) || outcome.kind !== "lightning") {
      if ("kind" in outcome && outcome.kind === "pending") {
        throw unknownOutcome(outcome.transferId);
      }
      throw new ProviderError(-32603, "the lnurl payment settled unexpectedly");
    }
    return this.preimage(ref, outcome.payment);
  }

  private async preimage(ref: SparkAccountRef, payment: LightningPayment): Promise<unknown> {
    let delay = PREIMAGE_POLL_START_MS;
    let waited = 0;
    // The payment is already committed: a status read failure, an exhausted budget or a settled
    // payment without a preimage must never read as failed, or the page pays again.
    while (true) {
      let status: Awaited<ReturnType<SparkController["paymentStatus"]>>;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the preimage poll serially polls
        status = await this.options.spark.paymentStatus(ref, {
          requestId: payment.requestId,
          paymentHash: payment.paymentHash,
        });
      } catch {
        throw paymentPending(NOT_SETTLED);
      }
      if (status.outcome === "failed" || status.outcome === "returned") {
        throw new ProviderError(-32603, "payment failed");
      }
      if (status.outcome === "succeeded") {
        if (status.preimage === undefined) {
          throw paymentPending(
            "the payment settled but its preimage is unavailable; do not retry it",
          );
        }
        return { preimage: bytesToHex(status.preimage) };
      }
      if (waited >= PREIMAGE_POLL_BUDGET_MS) {
        throw paymentPending(NOT_SETTLED);
      }
      const step = Math.min(delay, PREIMAGE_POLL_MAX_MS);
      // oxlint-disable-next-line eslint/no-await-in-loop -- the preimage poll serially waits
      await this.options.sleep(step);
      waited += step;
      delay *= 2;
    }
  }

  private lightningOption(
    ref: SparkAccountRef,
    invoice: string,
  ): Extract<PaymentOption, { readonly kind: "lightning" }> {
    const parsed = parsePayment(invoice, { network: ref.network, now: this.options.now() });
    if (parsed.kind !== "request") {
      throw invalidParams("sendPayment invoice is not a BOLT11 invoice");
    }
    const option = parsed.request.options.find((o) => o.kind === "lightning");
    if (option === undefined || option.kind !== "lightning") {
      throw invalidParams("sendPayment invoice is not a BOLT11 invoice");
    }
    return option;
  }

  private getBalance(origin: string): unknown {
    const policy = this.options.connections.lightningPolicy(origin);
    if (policy?.balance !== true) {
      throw unauthorized("balance access is not granted");
    }
    const balance = this.options.spark.accountBalance(this.ref(origin));
    if (balance === undefined) {
      throw new ProviderError(-32603, "no cached balance for the active spark account");
    }
    return { balance, currency: "sats" };
  }
}
