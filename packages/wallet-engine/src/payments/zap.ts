import { bytesToHex } from "@noble/hashes/utils.js";

import type { Event } from "@qntx/nostr";
import { makeZapRequest } from "@qntx/nostr/nips/nip57";
import { SparkInputError } from "@qntx/spark";
import type { LightningPayment } from "@qntx/spark";
import { encodeLnurl, lightningAddressUrl, requestInvoice, resolveLnurl } from "@qntx/spark/lnurl";
import type { NostrKeyRef } from "@qntx/wallet";
import type { WalletSigner } from "@qntx/wallet/nostr";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { SparkController } from "../spark/controller.ts";
import { categorize, SparkControllerError } from "../spark/errors.ts";

/** A profile zap names the recipient pubkey; an event zap carries the event it zaps. */
export type ZapRecipient =
  | { readonly pubkey: string; readonly lightning: string }
  | { readonly event: Event; readonly lightning: string };

export type ZapParams = {
  readonly account: SparkAccountRef;
  readonly nostrKey: NostrKeyRef;
  readonly recipient: ZapRecipient;
  readonly amountSats: number;
  readonly comment?: string | undefined;
  readonly relays: ReadonlyArray<string>;
  readonly maxFeeSats: number;
  readonly verify: Parameters<SparkController["payInvoice"]>[1]["verify"];
};

export type ZapResult = {
  /** The signed 9734 that went out with the invoice request. */
  readonly zapRequest: Event;
  readonly invoice: string;
  readonly payment: LightningPayment;
  /** The LNURL service's zap-receipt signing pubkey — validates the 9735. */
  readonly receiptPubkey: string;
};

export type ZapOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly nostr: (key: NostrKeyRef) => WalletSigner;
  readonly spark: SparkController;
};

/**
 * NIP-57 zap through LNURL-pay: resolve, sign the 9734 with the wallet's Nostr key, request the
 * invoice with the signed zap attached, then pay it through the controller's approve-first path.
 */
export async function zap(params: ZapParams, options: ZapOptions): Promise<ZapResult> {
  const amountMsat = params.amountSats * 1000;
  if (
    !Number.isSafeInteger(params.amountSats) ||
    params.amountSats <= 0 ||
    !Number.isSafeInteger(amountMsat)
  ) {
    throw new SparkControllerError("rejected", "zap amount is not a positive safe integer");
  }
  try {
    const resolved = await resolveLnurl(params.recipient.lightning, { fetch: options.fetch });
    if (resolved.tag !== "payRequest") {
      throw new SparkControllerError("rejected", "recipient is not an LNURL-pay endpoint");
    }
    if (!resolved.allowsNostr || resolved.nostrPubkey === undefined) {
      throw new SparkControllerError("rejected", "LNURL service does not accept nostr zaps");
    }
    if (amountMsat < resolved.minSendableMsat || amountMsat > resolved.maxSendableMsat) {
      throw new SparkControllerError("rejected", "zap amount outside the service's bounds");
    }
    const lnurl = params.recipient.lightning.startsWith("lnurl1")
      ? params.recipient.lightning
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
    const signer = options.nostr(params.nostrKey);
    const zapRequest = await signer.signEvent({
      ...template,
      pubkey: await signer.getPublicKey(),
    });
    const { invoice } = await requestInvoice(resolved, {
      fetch: options.fetch,
      network: params.account.network,
      amountMsat,
      ...(params.comment === undefined ? {} : { comment: params.comment }),
      zapRequest: JSON.stringify(zapRequest),
    });
    const payment = await options.spark.payInvoice(params.account, {
      note: {
        kind: "zap",
        recipientPubkey:
          "event" in params.recipient ? params.recipient.event.pubkey : params.recipient.pubkey,
        ...("event" in params.recipient ? { eventId: params.recipient.event.id } : {}),
        ...(params.comment === undefined ? {} : { comment: params.comment }),
        lightning: params.recipient.lightning,
      },
      invoice,
      maxFeeSats: params.maxFeeSats,
      verify: params.verify,
    });
    return { zapRequest, invoice, payment, receiptPubkey: bytesToHex(resolved.nostrPubkey) };
  } catch (error) {
    if (error instanceof SparkControllerError) {
      throw error;
    }
    if (error instanceof SparkInputError) {
      throw new SparkControllerError("rejected", "zap failed invoice validation");
    }
    throw new SparkControllerError(categorize(error), "zap failed");
  }
}
