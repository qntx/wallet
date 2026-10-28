import type { SparkPayment } from "@qntx/spark";

/**
 * Local, engine-side metadata pinned to a history entry by transfer id. Written after the payment
 * it annotates has already succeeded — a missing or malformed note must never affect the payment
 * itself.
 */
export type PaymentNote = {
  readonly kind: "zap";
  /** 64 lowercase hex. */
  readonly recipientPubkey: string;
  /** 64 lowercase hex — event zaps carry the zapped event's id. */
  readonly eventId?: string;
  /** At most 2000 characters. */
  readonly comment?: string;
  /** The lud16 or LNURL the zap resolved. */
  readonly lightning: string;
};

export type SparkActivity = SparkPayment & { readonly note?: PaymentNote };

const HEX64 = /^[0-9a-f]{64}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const NOTE_FIELDS: ReadonlySet<string> = new Set([
  "kind",
  "recipientPubkey",
  "eventId",
  "comment",
  "lightning",
]);

/** Strict read-side validation: anything off-shape is `undefined`, never a throw. */
export function parsePaymentNote(value: unknown): PaymentNote | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!NOTE_FIELDS.has(field)) {
      return undefined;
    }
  }
  const { kind, recipientPubkey, eventId, comment, lightning } = value;
  if (kind !== "zap") {
    return undefined;
  }
  if (typeof recipientPubkey !== "string" || !HEX64.test(recipientPubkey)) {
    return undefined;
  }
  if (eventId !== undefined && (typeof eventId !== "string" || !HEX64.test(eventId))) {
    return undefined;
  }
  if (comment !== undefined && (typeof comment !== "string" || comment.length > 2000)) {
    return undefined;
  }
  if (typeof lightning !== "string" || lightning.length === 0) {
    return undefined;
  }
  return {
    kind: "zap",
    recipientPubkey,
    ...(eventId === undefined ? {} : { eventId }),
    ...(comment === undefined ? {} : { comment }),
    lightning,
  };
}

export function encodePaymentNote(note: PaymentNote): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(note));
}
