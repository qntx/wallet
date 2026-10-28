import { bytesToHex } from "@noble/hashes/utils.js";

import { signedMatchesUnsigned, verifyEvent } from "@qntx/nostr";
import type { Event, NostrSigner } from "@qntx/nostr";
import { makeZapRequest } from "@qntx/nostr/nips/nip57";
import { SparkInputError, decodeBolt11 } from "@qntx/spark";
import type { LightningPayment, SparkNetwork } from "@qntx/spark";
import { encodeLnurl, lightningAddressUrl, requestInvoice, resolveLnurl } from "@qntx/spark/lnurl";
import type { UnlockFactor } from "@qntx/wallet";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { SparkController } from "../spark/controller.ts";
import { categorize } from "../spark/errors.ts";
import { PaymentError } from "./errors.ts";

/** A profile zap names the recipient pubkey; an event zap carries the event it zaps. */
export type ZapRecipient =
  | { readonly pubkey: string; readonly lightning: string }
  | { readonly event: Event; readonly lightning: string };

export type PrepareZapParams = {
  /** Any `NostrSigner` — wallet key, external key, NIP-07/46 — signs the 9734. */
  readonly signer: NostrSigner;
  readonly recipient: ZapRecipient;
  readonly amountSats: number;
  readonly comment?: string | undefined;
  readonly relays: ReadonlyArray<string>;
  readonly network: SparkNetwork;
};

export type PrepareZapContext = {
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
};

/** Everything a payer needs: the signed 9734, the invoice, and the note fields. */
export type PreparedZap = {
  readonly zapRequest: Event;
  readonly invoice: string;
  /** Hex payment hash decoded from the invoice. */
  readonly paymentHash: string;
  /** Millisecond expiry decoded from the invoice. */
  readonly expiresAt: number;
  readonly amountSats: number;
  /** The LNURL service's 9735 signing pubkey. */
  readonly receiptPubkey: string;
  readonly recipientPubkey: string;
  readonly eventId?: string;
  readonly comment?: string;
  /** The lud16 or LNURL as given. */
  readonly lightning: string;
};

export type PayZapOptions = {
  readonly maxFeeSats: number;
  readonly verify: UnlockFactor;
  readonly now: () => number;
};

/** Everything up to payment: resolve LNURL, sign the 9734, request the invoice. */
export async function prepareZap(
  params: PrepareZapParams,
  context: PrepareZapContext,
): Promise<PreparedZap> {
  const amountMsat = params.amountSats * 1000;
  if (
    !Number.isSafeInteger(params.amountSats) ||
    params.amountSats <= 0 ||
    !Number.isSafeInteger(amountMsat)
  ) {
    throw new PaymentError("invalid-input", "zap amount is not a positive safe integer");
  }
  try {
    const resolved = await resolveLnurl(params.recipient.lightning, { fetch: context.fetch });
    if (resolved.tag !== "payRequest") {
      throw new PaymentError("rejected", "recipient is not an LNURL-pay endpoint");
    }
    if (!resolved.allowsNostr || resolved.nostrPubkey === undefined) {
      throw new PaymentError("rejected", "LNURL service does not accept nostr zaps");
    }
    if (amountMsat < resolved.minSendableMsat || amountMsat > resolved.maxSendableMsat) {
      throw new PaymentError("rejected", "zap amount outside the service's bounds");
    }
    if (params.comment !== undefined) {
      if (resolved.commentAllowed === 0) {
        throw new PaymentError("rejected", "the service does not accept comments");
      }
      if (params.comment.length > resolved.commentAllowed) {
        throw new PaymentError("rejected", "comment exceeds the service's limit");
      }
    }
    // LNURL detection is case-insensitive; the 9734 carries lowercase bech32.
    const lnurl = params.recipient.lightning.toLowerCase().startsWith("lnurl1")
      ? params.recipient.lightning.toLowerCase()
      : encodeLnurl(lightningAddressUrl(params.recipient.lightning));
    const base = {
      amount: amountMsat,
      relays: [...params.relays],
      comment: params.comment,
      lnurl,
    };
    const template =
      "event" in params.recipient
        ? makeZapRequest({ event: params.recipient.event, ...base })
        : makeZapRequest({ pubkey: params.recipient.pubkey, ...base });
    const unsigned = { ...template, pubkey: await params.signer.getPublicKey() };
    const zapRequest = await params.signer.signEvent(unsigned);
    // External signers (NIP-07/46) are untrusted: the 9734 must be validly signed over exactly
    // the template, or the receipt would commit to content the user never approved.
    if (!verifyEvent(zapRequest) || !signedMatchesUnsigned(zapRequest, unsigned)) {
      throw new PaymentError("rejected", "signer returned a zap request that does not match");
    }
    const { invoice } = await requestInvoice(resolved, {
      fetch: context.fetch,
      network: params.network,
      amountMsat,
      ...(params.comment === undefined ? {} : { comment: params.comment }),
      zapRequest: JSON.stringify(zapRequest),
    });
    const decoded = decodeBolt11(invoice);
    const expiresAt = (decoded.timestamp + decoded.expirySeconds) * 1000;
    if (expiresAt <= context.now() + 60_000) {
      throw new PaymentError("rejected", "zap invoice expires too soon");
    }
    const eventId = "event" in params.recipient ? params.recipient.event.id : undefined;
    return {
      zapRequest,
      invoice,
      paymentHash: bytesToHex(decoded.paymentHash),
      expiresAt,
      amountSats: params.amountSats,
      receiptPubkey: bytesToHex(resolved.nostrPubkey),
      recipientPubkey:
        "event" in params.recipient ? params.recipient.event.pubkey : params.recipient.pubkey,
      ...(eventId === undefined ? {} : { eventId }),
      ...(params.comment === undefined ? {} : { comment: params.comment }),
      lightning: params.recipient.lightning,
    };
  } catch (error) {
    if (error instanceof PaymentError) {
      throw error;
    }
    if (
      error instanceof SparkInputError ||
      (error instanceof Error && error.cause instanceof SparkInputError)
    ) {
      throw new PaymentError("rejected", "zap failed invoice validation");
    }
    throw new PaymentError(categorizePayment(error), "zap failed");
  }
}

/**
 * Pays a prepared zap through the controller's approve-first path. A nearly-expired invoice is
 * rejected before approval — the user may have sat on the confirm screen since `prepareZap`.
 */
export async function payZap(
  spark: SparkController,
  account: SparkAccountRef,
  prepared: PreparedZap,
  options: PayZapOptions,
): Promise<LightningPayment> {
  if (prepared.expiresAt <= options.now() + 60_000) {
    throw new PaymentError("rejected", "zap invoice expired");
  }
  return spark.payInvoice(account, {
    invoice: prepared.invoice,
    maxFeeSats: options.maxFeeSats,
    verify: options.verify,
    note: {
      kind: "zap",
      recipientPubkey: prepared.recipientPubkey,
      ...(prepared.eventId === undefined ? {} : { eventId: prepared.eventId }),
      ...(prepared.comment === undefined ? {} : { comment: prepared.comment }),
      lightning: prepared.lightning,
    },
  });
}

function categorizePayment(error: unknown): "network" | "rejected" {
  const category = categorize(error);
  return category === "network" ? "network" : "rejected";
}
