import { bytesToHex } from "@noble/hashes/utils.js";

import {
  bitcoinAddressScript,
  decodeBolt11,
  decodeSparkAddress,
  parseSparkInvoice,
} from "@qntx/spark";
import type { SparkNetwork } from "@qntx/spark";
import type { LnurlPayRequest, LnurlWithdrawRequest } from "@qntx/spark/lnurl";
import { decodeLnurl, lightningAddressUrl } from "@qntx/spark/lnurl";

export type PaymentOption =
  | { readonly kind: "spark"; readonly address: string }
  | {
      readonly kind: "spark-invoice";
      readonly invoice: string;
      readonly amountSats?: number;
      readonly memo?: string;
      readonly expiresAt?: number;
    }
  | {
      readonly kind: "lightning";
      readonly invoice: string;
      readonly amountSats?: number;
      readonly paymentHash: string;
      readonly description?: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "lnurl-pay"; readonly request: LnurlPayRequest; readonly address?: string }
  | { readonly kind: "lnurl-withdraw"; readonly request: LnurlWithdrawRequest }
  | { readonly kind: "bitcoin"; readonly address: string };

export type PaymentRequest = {
  readonly options: ReadonlyArray<PaymentOption>;
  readonly amountSats?: number;
  readonly label?: string;
  readonly message?: string;
};

export type PaymentParse =
  | { readonly kind: "request"; readonly request: PaymentRequest }
  | { readonly kind: "lnurl"; readonly url: string; readonly address?: string }
  | {
      readonly kind: "unsupported";
      readonly format:
        | "bolt12"
        | "silent-payment"
        | "lnurl-auth"
        | "spark-token-invoice"
        | "nostr-wallet-connect";
    }
  | {
      readonly kind: "invalid";
      readonly reason: "network" | "expired" | "amount-mismatch" | "malformed";
    }
  | { readonly kind: "unrecognized" };

export type ParseOptions = {
  readonly network: SparkNetwork;
  readonly now: number;
};

/** Invoices with less than this much life left are treated as already expired. */
const BOLT11_EXPIRY_GRACE_MS = 60_000;

type ParseFailure = {
  readonly kind: "invalid";
  readonly reason: "network" | "expired" | "amount-mismatch" | "malformed";
};

const invalid = (reason: ParseFailure["reason"]): PaymentParse => ({ kind: "invalid", reason });

/** BTC decimal `amount` → sats. At most 8 decimal places; must fit a safe integer. */
function btcAmountSats(text: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, whole] = match;
  if (whole === undefined) {
    return undefined;
  }
  const sats = BigInt(whole) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : undefined;
}

type Bolt11Fields = {
  readonly amountSats?: number;
  readonly paymentHash: string;
  readonly description?: string;
  readonly expiresAt: number;
};

/**
 * BOLT11 → fields, network- and expiry-checked. `undefined` = not a bolt11 string; `"network"` /
 * `"expired"` / `"malformed"` are the failure modes.
 */
function bolt11Fields(
  text: string,
  options: ParseOptions,
): Bolt11Fields | "network" | "expired" | "malformed" | undefined {
  let decoded;
  try {
    decoded = decodeBolt11(text);
  } catch {
    return undefined;
  }
  const network =
    decoded.network === "mainnet"
      ? "mainnet"
      : decoded.network === "regtest"
        ? "regtest"
        : undefined;
  if (network === undefined) {
    return "network";
  }
  if (network !== options.network) {
    return "network";
  }
  const expiresAt = (decoded.timestamp + decoded.expirySeconds) * 1000;
  if (expiresAt <= options.now + BOLT11_EXPIRY_GRACE_MS) {
    return "expired";
  }
  return {
    ...(decoded.amountMsat === undefined
      ? {}
      : { amountSats: Math.ceil(Number(decoded.amountMsat) / 1000) }),
    paymentHash: bytesToHex(decoded.paymentHash),
    ...(decoded.description === undefined ? {} : { description: decoded.description }),
    expiresAt,
  };
}

/** Spark address or sats/token invoice → options. `null` means not a spark input. */
function sparkOptions(
  text: string,
  options: ParseOptions,
): PaymentOption[] | "network" | "expired" | "malformed" | "token" | undefined {
  let decoded;
  try {
    decoded = decodeSparkAddress(text);
  } catch {
    return undefined;
  }
  if (decoded.network !== options.network) {
    return "network";
  }
  if (decoded.invoice === undefined) {
    return [{ kind: "spark", address: text }];
  }
  // Expiry lives in the unsigned fields — check it before validating the signature so an
  // expired invoice reports `expired` rather than `malformed`.
  if (decoded.invoice.expiresAt !== undefined && decoded.invoice.expiresAt <= options.now) {
    return "expired";
  }
  if (decoded.invoice.payment?.type === "tokens") {
    return "token";
  }
  let parsed;
  try {
    parsed = parseSparkInvoice(text, { network: options.network, now: options.now });
  } catch {
    return "malformed";
  }
  const { payment } = parsed.fields;
  return [
    {
      kind: "spark-invoice",
      invoice: text,
      ...(payment?.type === "sats" && payment.amount !== undefined
        ? { amountSats: payment.amount }
        : {}),
      ...(parsed.fields.memo === undefined ? {} : { memo: parsed.fields.memo }),
      ...(parsed.fields.expiresAt === undefined ? {} : { expiresAt: parsed.fields.expiresAt }),
    },
  ];
}

/** Does `address` decode under the other network? Used only to classify a rejection. */
function decodesOnOtherNetwork(address: string, options: ParseOptions): boolean {
  try {
    bitcoinAddressScript(address, options.network === "mainnet" ? "regtest" : "mainnet");
    return true;
  } catch {
    return false;
  }
}

/** BIP-21 URI → request. Only the `spark=` and `lightning=` payment methods are supported. */
function bip21Parse(text: string, options: ParseOptions): PaymentParse {
  const q = text.indexOf("?");
  const address = text.slice("bitcoin:".length, q === -1 ? undefined : q);
  const params = new Map<string, string>();
  if (q !== -1) {
    for (const pair of text.slice(q + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        return invalid("malformed");
      }
      let key;
      let value;
      try {
        key = decodeURIComponent(pair.slice(0, eq)).toLowerCase();
        value = decodeURIComponent(pair.slice(eq + 1));
      } catch {
        return invalid("malformed");
      }
      if (params.has(key)) {
        return invalid("malformed");
      }
      if (key.startsWith("req-") && !BIP21_KNOWN_REQ_PARAMS.has(key)) {
        return invalid("malformed");
      }
      params.set(key, value);
    }
  }
  const options_: PaymentOption[] = [];
  let declaredSats: number | undefined;
  const spark = params.get("spark");
  if (spark !== undefined) {
    const parsed = sparkOptions(spark, options);
    if (parsed === undefined || parsed === "malformed") {
      return invalid("malformed");
    }
    if (parsed === "token") {
      return { kind: "unsupported", format: "spark-token-invoice" };
    }
    if (parsed === "network" || parsed === "expired") {
      return invalid(parsed);
    }
    options_.push(...parsed);
    const sats = parsed.find((o) => o.kind === "spark-invoice")?.amountSats;
    if (sats !== undefined) {
      if (declaredSats !== undefined && declaredSats !== sats) {
        return invalid("amount-mismatch");
      }
      declaredSats = sats;
    }
  }
  const lightning = params.get("lightning");
  if (lightning !== undefined) {
    const parsed = bolt11Fields(lightning, options);
    if (parsed === undefined || parsed === "malformed") {
      return invalid("malformed");
    }
    if (parsed === "network" || parsed === "expired") {
      return invalid(parsed);
    }
    options_.push({
      kind: "lightning",
      invoice: lightning,
      ...(parsed.amountSats === undefined ? {} : { amountSats: parsed.amountSats }),
      paymentHash: parsed.paymentHash,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      expiresAt: parsed.expiresAt,
    });
    if (parsed.amountSats !== undefined) {
      if (declaredSats !== undefined && declaredSats !== parsed.amountSats) {
        return invalid("amount-mismatch");
      }
      declaredSats = parsed.amountSats;
    }
  }
  if (address.length > 0) {
    try {
      bitcoinAddressScript(address, options.network);
    } catch {
      return invalid(decodesOnOtherNetwork(address, options) ? "network" : "malformed");
    }
    options_.push({ kind: "bitcoin", address });
  }
  const declaredAmount = params.get("amount");
  if (declaredAmount !== undefined) {
    const sats = btcAmountSats(declaredAmount);
    if (sats === undefined) {
      return invalid("malformed");
    }
    if (declaredSats !== undefined && declaredSats !== sats) {
      return invalid("amount-mismatch");
    }
    declaredSats = sats;
  }
  if (options_.length === 0) {
    if (params.has("lno")) {
      return { kind: "unsupported", format: "bolt12" };
    }
    if (params.has("sp")) {
      return { kind: "unsupported", format: "silent-payment" };
    }
    return invalid("malformed");
  }
  return {
    kind: "request",
    request: {
      options: options_,
      ...(declaredSats === undefined ? {} : { amountSats: declaredSats }),
      ...(params.get("label") === undefined ? {} : { label: params.get("label") ?? "" }),
      ...(params.get("message") === undefined ? {} : { message: params.get("message") ?? "" }),
    },
  };
}

const BIP21_KNOWN_REQ_PARAMS = new Set(["req-amount", "req-label", "req-message"]);

/** `input` → PaymentParse. Never throws: every failure is a structured result. */
export function parsePayment(input: string, options: ParseOptions): PaymentParse {
  try {
    const text = input.trim();
    if (/^nostr\+walletconnect:/i.test(text)) {
      return { kind: "unsupported", format: "nostr-wallet-connect" };
    }
    const stripped = text.toLowerCase().startsWith("lightning:")
      ? text.slice("lightning:".length)
      : text;
    if (/^bitcoin:/i.test(stripped)) {
      return bip21Parse(`bitcoin:${stripped.slice(stripped.indexOf(":") + 1)}`, options);
    }
    const bolt11 = bolt11Fields(stripped, options);
    if (bolt11 === "network" || bolt11 === "expired" || bolt11 === "malformed") {
      return invalid(bolt11);
    }
    if (bolt11 !== undefined) {
      const option: PaymentOption = {
        kind: "lightning",
        invoice: stripped,
        ...(bolt11.amountSats === undefined ? {} : { amountSats: bolt11.amountSats }),
        paymentHash: bolt11.paymentHash,
        ...(bolt11.description === undefined ? {} : { description: bolt11.description }),
        expiresAt: bolt11.expiresAt,
      };
      return {
        kind: "request",
        request: {
          options: [option],
          ...(bolt11.amountSats === undefined ? {} : { amountSats: bolt11.amountSats }),
        },
      };
    }
    const spark = sparkOptions(stripped, options);
    if (spark === "token") {
      return { kind: "unsupported", format: "spark-token-invoice" };
    }
    if (spark === "network" || spark === "expired" || spark === "malformed") {
      return invalid(spark);
    }
    if (spark !== undefined) {
      return { kind: "request", request: { options: spark } };
    }
    if (/^(lnurlp|lnurlw):/i.test(stripped)) {
      const rest = stripped.slice(stripped.indexOf("://") + 3);
      const host = rest.split(/[/?#]/, 1)[0] ?? "";
      const url = `${host.toLowerCase().endsWith(".onion") ? "http" : "https"}://${rest}`;
      if (new URL(url).searchParams.get("tag") === "login") {
        return { kind: "unsupported", format: "lnurl-auth" };
      }
      return { kind: "lnurl", url };
    }
    if (/^keyauth:/i.test(stripped)) {
      return { kind: "unsupported", format: "lnurl-auth" };
    }
    if (!stripped.includes(":") && stripped.includes("@")) {
      return { kind: "lnurl", url: lightningAddressUrl(stripped), address: stripped };
    }
    // BOLT12 offer: bech32 charset, anchored — a lightning address like lnolan@x must not match.
    if (/^lno1[02-9ac-hj-np-z]+$/i.test(stripped)) {
      return { kind: "unsupported", format: "bolt12" };
    }
    try {
      const url = decodeLnurl(stripped);
      if (new URL(url).searchParams.get("tag") === "login") {
        return { kind: "unsupported", format: "lnurl-auth" };
      }
      return { kind: "lnurl", url };
    } catch {
      // not a bech32 LNURL
    }
    try {
      bitcoinAddressScript(stripped, options.network);
      return { kind: "request", request: { options: [{ kind: "bitcoin", address: stripped }] } };
    } catch {
      if (decodesOnOtherNetwork(stripped, options)) {
        return invalid("network");
      }
    }
    return { kind: "unrecognized" };
  } catch {
    return invalid("malformed");
  }
}
