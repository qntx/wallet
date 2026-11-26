import { SiwxError, checkOrigin, createMessage, parseTimestamp } from "@qntx/siwx";
import type {
  AssetFlow,
  DisplayIntent,
  IntentWarningKind,
  MessageContent,
  SafeTransaction,
  SeaportOrder,
  SignInParse,
} from "@qntx/wallet-chains";
import { SAFE_MULTISEND_CALL_ONLY, evmTokenTable } from "@qntx/wallet-chains/evm";
import { SOLANA_NATIVE_ASSET } from "@qntx/wallet-chains/solana";
import { tronTokenTable } from "@qntx/wallet-chains/tron";

import { mayCarryInscription } from "../chains/bitcoin.ts";
import type { PhishingStatus } from "../phishing/status.ts";
import type { RequestCheckCode } from "./checks.ts";
import { sameAsset } from "./simulation.ts";
import type { SimulationOutcome } from "./simulation.ts";
import type { WalletConnectVerify } from "./types.ts";

/**
 * Request risk, pure. A recipient the wallet has never paid or saved is a `warning`; one that looks
 * like a known address (same first and last four characters, different address) is a `danger` — the
 * shape of an address-poisoning lookalike. Both can apply to one recipient. A page the user trusts
 * despite the phishing list is a `danger`; one that could not be checked is a `warning`. A sign-in
 * over QR carries no verifiable domain at all — a `danger` the user must acknowledge, since a dApp
 * claiming a domain it does not own is refused outright.
 */
export type RiskFinding = {
  readonly code:
    | "first-recipient"
    | "address-poisoning"
    | "phishing-origin"
    | "phishing-unchecked"
    | "token-impersonation"
    | "token-symbol-unicode"
    | "simulation-reverted"
    | "simulation-mismatch"
    | "collection-approval"
    | "unlimited-approval"
    | "sign-in-malformed"
    | "sign-in-domain-mismatch"
    | "sign-in-port-mismatch"
    | "sign-in-address-mismatch"
    | "sign-in-expired"
    | "sign-in-not-yet-valid"
    | "permit-approval"
    | "permit-unlimited"
    | "permit-long-lived"
    | "order-receives-nothing"
    | "order-offerer-mismatch"
    | "safe-delegatecall"
    | "safe-gas-refund"
    | "bitcoin-sighash-single"
    | "bitcoin-inscription-input"
    | "bitcoin-frozen-input"
    | "bitcoin-unusual-output"
    | "bitcoin-unconfirmed-output"
    | "stake-authority"
    | "blind-signing"
    | "contract-recipient"
    | "token-contract-recipient"
    | "token-recipient-empty"
    | "fee-limit-below-estimate"
    | "verify-mismatch"
    | "verify-threat"
    | "fiat24-internal-account"
    | "fiat24-card-pull"
    | "fiat24-unlimited-approval"
    | "fiat24-exact-out-unbounded"
    | "fiat24-payee-offchain"
    | "fiat24-account-move"
    | "fiat24-account-burn"
    | "qr-sign-in-unverified";
  readonly level: "warning" | "danger";
};

const byDanger = (findings: ReadonlyArray<RiskFinding>): ReadonlyArray<RiskFinding> =>
  [...findings].sort((a, b) => Number(b.level === "danger") - Number(a.level === "danger"));

/** The finding for a browser origin's phishing status, if any; `blocked` never reaches a request. */
export function originRisk(status: PhishingStatus): ReadonlyArray<RiskFinding> {
  if (status === "trusted") {
    return [{ code: "phishing-origin", level: "danger" }];
  }
  return status === "unchecked" ? [{ code: "phishing-unchecked", level: "warning" }] : [];
}

/**
 * A WalletConnect peer's Verify verdict: a flagged domain or a domain mismatch is a danger; an
 * unverifiable one is neutral.
 */
export function verifyRisk(verify: WalletConnectVerify): ReadonlyArray<RiskFinding> {
  const found: RiskFinding[] = [];
  if (verify.isScam) {
    found.push({ code: "verify-threat", level: "danger" });
  }
  if (verify.validation === "INVALID") {
    found.push({ code: "verify-mismatch", level: "danger" });
  }
  return found;
}

/** `findings` plus `extra`, deduplicated by code, `danger` first. */
export function mergeRisk(
  findings: ReadonlyArray<RiskFinding>,
  extra: ReadonlyArray<RiskFinding>,
): ReadonlyArray<RiskFinding> {
  const byCode = new Map<RiskFinding["code"], RiskFinding>();
  for (const finding of [...findings, ...extra]) {
    byCode.set(finding.code, finding);
  }
  return byDanger([...byCode.values()]);
}

/**
 * The finding a decoder's {@link IntentWarning} maps to — one entry for every `IntentWarningKind`,
 * `undefined` where the prompt rows already carry the fact and no request-level risk exists:
 *
 * - `platform-fee` — the fee is a prompt row.
 * - `stake-lockup` — the lockup window is a prompt row.
 * - `sighash-single-anyonecanpay` — already `bitcoin-sighash-single` via assessBitcoinPsbts.
 * - `permit2-witness` — the bound message is a prompt row.
 * - `delegation-replaced` — the replaced delegation is a prompt row.
 * - `token-2022-transfer-fee` — the withheld fee is a prompt row.
 * - `token-2022-extension` — the extension note is a prompt row.
 * - `fiat24-issuer-rate` — the issuer's applied rate is a prompt row.
 * - `fiat24-swap-quote` — the quoted rate is a prompt row.
 * - `fiat24-account-link` — the account link is a prompt row.
 */
export const WARNING_RISK: Readonly<
  Record<
    IntentWarningKind,
    { readonly code: RiskFinding["code"]; readonly level: RiskFinding["level"] } | undefined
  >
> = {
  "platform-fee": undefined,
  "stake-lockup": undefined,
  "sighash-single-anyonecanpay": undefined,
  "permit2-witness": undefined,
  "delegation-replaced": undefined,
  "token-2022-transfer-fee": undefined,
  "token-2022-extension": undefined,
  "fiat24-internal-account": { code: "fiat24-internal-account", level: "warning" },
  "fiat24-card-pull": { code: "fiat24-card-pull", level: "warning" },
  "fiat24-unlimited-approval": { code: "fiat24-unlimited-approval", level: "danger" },
  "fiat24-issuer-rate": undefined,
  "fiat24-exact-out-unbounded": { code: "fiat24-exact-out-unbounded", level: "warning" },
  "fiat24-payee-offchain": { code: "fiat24-payee-offchain", level: "warning" },
  "fiat24-swap-quote": undefined,
  "fiat24-account-link": undefined,
  "fiat24-account-move": { code: "fiat24-account-move", level: "danger" },
  "fiat24-account-burn": { code: "fiat24-account-burn", level: "warning" },
  "unusual-own-output": { code: "bitcoin-unusual-output", level: "warning" },
  "unconfirmed-signer-output": { code: "bitcoin-unconfirmed-output", level: "danger" },
};

/**
 * Findings for every warning the decoded intents carry, through {@link WARNING_RISK}, deduplicated,
 * `danger` first. A warning stamped `level: "danger"` is a `danger` finding whatever the table says
 * — the decoder knows the concrete shape better than the kind default.
 */
export function assessWarnings(
  intents: ReadonlyArray<Pick<DisplayIntent, "warnings">>,
): ReadonlyArray<RiskFinding> {
  const found = new Map<RiskFinding["code"], RiskFinding>();
  for (const intent of intents) {
    for (const warning of intent.warnings) {
      const entry = WARNING_RISK[warning.kind];
      if (entry === undefined) {
        continue;
      }
      const level = warning.level ?? entry.level;
      if (found.get(entry.code)?.level !== "danger") {
        found.set(entry.code, { code: entry.code, level });
      }
    }
  }
  return byDanger([...found.values()]);
}

/**
 * Findings for the approvals a transaction grants: an operator approved for a whole collection is a
 * `danger`; a granted unlimited allowance is a `warning`. Revocations and reductions raise
 * nothing.
 */
export function assessApprovals(
  intent: Pick<DisplayIntent, "approvals">,
): ReadonlyArray<RiskFinding> {
  const found = new Map<RiskFinding["code"], RiskFinding>();
  for (const change of intent.approvals) {
    if (change.kind === "operator") {
      if (change.approved) {
        found.set("collection-approval", { code: "collection-approval", level: "danger" });
      }
    } else if (change.kind === "stake-authority") {
      /* The decoder only emits this for a role handed to a key other than the signer. */
      found.set("stake-authority", { code: "stake-authority", level: "danger" });
    } else if (change.kind === "allowance" && change.change !== "decrease" && change.unlimited) {
      found.set("unlimited-approval", { code: "unlimited-approval", level: "warning" });
    }
  }
  return byDanger([...found.values()]);
}

const PERMIT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Findings for what a signed permit grants: any non-revoking allowance is a `warning`, an unlimited
 * one a `danger`, and a Permit2 allowance that lasts more than 30 days from `now` a `danger`.
 */
export function assessPermits(
  intent: Pick<DisplayIntent, "approvals">,
  now: number,
): ReadonlyArray<RiskFinding> {
  const found = new Map<RiskFinding["code"], RiskFinding>();
  for (const change of intent.approvals) {
    if (change.kind !== "allowance" || change.amount.amount === "0") {
      continue;
    }
    found.set("permit-approval", { code: "permit-approval", level: "warning" });
    if (change.unlimited) {
      found.set("permit-unlimited", { code: "permit-unlimited", level: "danger" });
    }
    if (
      change.via === "permit2" &&
      change.change === "set" &&
      change.expiration !== undefined &&
      change.expiration * 1000 > now + PERMIT_MAX_LIFETIME_MS
    ) {
      found.set("permit-long-lived", { code: "permit-long-lived", level: "danger" });
    }
  }
  return byDanger([...found.values()]);
}

/**
 * Findings for a recognized Seaport order: an order whose `offer` gives up items without any
 * consideration paying the offerer is the zero-price-listing phishing shape (`danger`), and an
 * `offerer` other than the signing account is a `warning`.
 */
export function assessSeaport(
  order: SeaportOrder | undefined,
  signer: string,
): ReadonlyArray<RiskFinding> {
  if (order === undefined) {
    return [];
  }
  const found = new Map<RiskFinding["code"], RiskFinding>();
  const paid = order.consideration.some(
    (item) =>
      item.recipient.toLowerCase() === order.offerer.toLowerCase() &&
      (BigInt(item.startAmount.amount) > 0n || BigInt(item.endAmount.amount) > 0n),
  );
  if (order.offer.length > 0 && !paid) {
    found.set("order-receives-nothing", { code: "order-receives-nothing", level: "danger" });
  }
  if (order.offerer.toLowerCase() !== signer.toLowerCase()) {
    found.set("order-offerer-mismatch", { code: "order-offerer-mismatch", level: "warning" });
  }
  return byDanger([...found.values()]);
}

/**
 * Findings for a recognized Safe transaction: a `delegatecall` into a contract that is not a
 * canonical MultiSendCallOnly is the multisig-hijack phishing shape (`danger`), a non-zero gas
 * refund is a `warning`, and every decoded inner call's approvals are assessed too.
 */
export function assessSafe(safe: SafeTransaction | undefined): ReadonlyArray<RiskFinding> {
  if (safe === undefined) {
    return [];
  }
  const found = new Map<RiskFinding["code"], RiskFinding>();
  for (const finding of safe.calls.flatMap((call) => assessApprovals(call))) {
    found.set(finding.code, finding);
  }
  if (safe.operation === "delegatecall" && !SAFE_MULTISEND_CALL_ONLY.has(safe.to.toLowerCase())) {
    found.set("safe-delegatecall", { code: "safe-delegatecall", level: "danger" });
  }
  if (safe.refund !== undefined) {
    found.set("safe-gas-refund", { code: "safe-gas-refund", level: "warning" });
  }
  return byDanger([...found.values()]);
}

/**
 * Findings for the inputs a dApp PSBT asks the wallet to sign. A `SINGLE|ANYONECANPAY` input binds
 * only its same-index output, so anyone can change the rest of the transaction: `danger`. Until
 * inscription data exists the heuristic is ord's postage rule — every taproot (ordinals-account)
 * input and every input worth at most ord's MAX_POSTAGE of 20_000 sat may carry an inscription:
 * such an input is a `warning` when it is signed as a listing (the sighash that fits selling it)
 * and a `danger` otherwise.
 */
export function assessBitcoinPsbts(
  inputs: ReadonlyArray<{
    readonly value: number;
    readonly template: "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";
    readonly sigHash: "ALL" | "SINGLE|ANYONECANPAY";
    readonly frozen: boolean;
  }>,
): ReadonlyArray<RiskFinding> {
  const found = new Map<RiskFinding["code"], RiskFinding>();
  if (inputs.some((i) => i.sigHash === "SINGLE|ANYONECANPAY")) {
    found.set("bitcoin-sighash-single", { code: "bitcoin-sighash-single", level: "danger" });
  }
  if (inputs.some((i) => i.frozen)) {
    // The user froze this outpoint — the dApp is asking to spend it anyway.
    found.set("bitcoin-frozen-input", { code: "bitcoin-frozen-input", level: "danger" });
  }
  const postage = inputs.filter((i) => mayCarryInscription(i.template === "btc.bip86", i.value));
  if (postage.length > 0) {
    found.set("bitcoin-inscription-input", {
      code: "bitcoin-inscription-input",
      level: postage.some((i) => i.sigHash !== "SINGLE|ANYONECANPAY") ? "danger" : "warning",
    });
  }
  return byDanger([...found.values()]);
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `scheme`, `host` (IPv6 keeps its brackets) and `hostPort` of a `scheme://host[:port]` origin. */
const originParts = (origin: string): { scheme: string; host: string; hostPort: string } => {
  const sep = origin.indexOf("://");
  const rest = origin.slice(sep + 3);
  const end = rest.startsWith("[") ? rest.indexOf("]") + 1 : rest.lastIndexOf(":");
  return {
    scheme: sep === -1 ? "" : origin.slice(0, sep).toLowerCase(),
    host: (end > 0 ? rest.slice(0, end) : rest).toLowerCase(),
    hostPort: rest.toLowerCase(),
  };
};

const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host) || host.endsWith(".localhost");

/**
 * What a Sign-In with X message adds to a request from `origin`: a message for another domain is
 * refused (`reject`) in production and a `danger` on a local development page; the signing address
 * must be the signer; an expired or not-yet-valid window and a text that only resembles a sign-in
 * message are warnings. TRON has no sign-in standard — a `tron` parse is only ever `malformed`, the
 * claims-only path.
 */
export function assessSignIn(input: {
  readonly signIn: SignInParse;
  /** The page origin, `scheme://host[:port]`. */
  readonly origin: string;
  /** The address that will sign. */
  readonly signer: string;
  readonly family: "evm" | "solana" | "tron";
  /** Milliseconds since the epoch. */
  readonly now: number;
}): { readonly reject?: string; readonly risk: ReadonlyArray<RiskFinding> } {
  const { signIn, origin, signer, family, now } = input;
  const { scheme, host, hostPort } = originParts(origin);
  const developer = isLocalHost(host);
  if (signIn.status === "malformed") {
    /* Lenient verifiers accept such a text as a sign-in for every claimed domain, so each claim is
     * bound to the page like a conforming domain: refuse a foreign one on production, flag it on a
     * local development page. */
    for (const claim of signIn.claims) {
      const matches =
        claim.domain.toLowerCase() === hostPort &&
        (claim.scheme === undefined || claim.scheme.toLowerCase() === scheme);
      if (!matches) {
        return developer
          ? { risk: [{ code: "sign-in-domain-mismatch", level: "danger" }] }
          : { reject: `the sign-in message is for ${claim.domain}, not this page`, risk: [] };
      }
    }
    return { risk: [{ code: "sign-in-malformed", level: "warning" }] };
  }
  const { fields } = signIn;
  let findings: ReturnType<typeof checkOrigin>;
  try {
    findings = checkOrigin(
      createMessage(fields),
      origin,
      developer
        ? { allowedSchemes: ["https", "http"], defaultScheme: scheme, developerMode: true }
        : {},
    );
  } catch (error) {
    if (error instanceof SiwxError && error.code === "InvalidOrigin") {
      return { reject: "the page origin is not a valid web origin", risk: [] };
    }
    throw error;
  }
  if (findings.some((f) => f.severity === "reject")) {
    return { reject: `the sign-in message is for ${fields.domain}, not this page`, risk: [] };
  }
  const found = new Map<RiskFinding["code"], RiskFinding>();
  const add = (code: RiskFinding["code"], level: RiskFinding["level"]): void => {
    found.set(code, { code, level });
  };
  for (const finding of findings) {
    if (finding.code === "PortMismatch") {
      add("sign-in-port-mismatch", "warning");
    } else {
      add("sign-in-domain-mismatch", "danger");
    }
  }
  const same =
    family === "evm"
      ? fields.address.toLowerCase() === signer.toLowerCase()
      : fields.address === signer;
  if (!same) {
    add("sign-in-address-mismatch", "danger");
  }
  const expires =
    fields.expirationTime === undefined ? undefined : parseTimestamp(fields.expirationTime);
  if (expires !== undefined && expires.epochMs < now) {
    add("sign-in-expired", "warning");
  }
  const notBefore = fields.notBefore === undefined ? undefined : parseTimestamp(fields.notBefore);
  if (notBefore !== undefined && notBefore.epochMs > now) {
    add("sign-in-not-yet-valid", "warning");
  }
  return { risk: byDanger([...found.values()]) };
}

/** Characters compared at each end of an address. */
export const POISONING_EDGE = 4;

/** EVM addresses compare without the `0x` prefix and case-insensitively. */
export const comparable = (family: string, address: string): string =>
  family === "evm" ? address.replace(/^0x/i, "").toLowerCase() : address;

/**
 * Who a flow pays. A Fiat24 ledger transfer or payout names its recipient in the calldata — `to` is
 * the cash-token contract all of them share — so the account or payee is the recipient compared.
 */
/**
 * Addresses the wallet already knows for a family: contacts, plus recipients of tracked chain sends
 * (Spark payments are not tracked — for spark the contacts list is the whole answer).
 */
export const knownAddresses = (
  entries: ReadonlyArray<{ readonly family: string; readonly address: string }>,
  txs: ReadonlyArray<{
    readonly family: string;
    readonly state: string;
    readonly intent?: DisplayIntent | undefined;
  }>,
  family: string,
): ReadonlyArray<string> => {
  const contacts = entries.filter((e) => e.family === family).map((e) => e.address);
  if (family === "spark") {
    return contacts;
  }
  const paid = txs
    .filter(
      (tx) =>
        tx.family === family &&
        (tx.state === "submitted" || tx.state === "pending" || tx.state === "confirmed"),
    )
    .flatMap((tx) => tx.intent?.outflows.map(recipientOf) ?? []);
  return [...contacts, ...paid];
};

export const recipientOf = (flow: Pick<AssetFlow, "to" | "fiat24">): string =>
  flow.fiat24 === undefined
    ? flow.to
    : "account" in flow.fiat24
      ? `fiat24:account:${flow.fiat24.account}`
      : `fiat24:payee:${flow.fiat24.payee}`;

const looksLike = (a: string, b: string): boolean =>
  a !== b &&
  /* Only address-shaped values look alike: Fiat24 ids are small integers, so two of them sharing
     four digits at both ends says nothing. */
  !a.startsWith("fiat24:") &&
  !b.startsWith("fiat24:") &&
  a.length >= POISONING_EDGE * 2 &&
  b.length >= POISONING_EDGE * 2 &&
  a.slice(0, POISONING_EDGE) === b.slice(0, POISONING_EDGE) &&
  a.slice(-POISONING_EDGE) === b.slice(-POISONING_EDGE);

/**
 * Findings for every recipient of one request, deduplicated, `danger` first. Recipients come from
 * {@link recipientOf}: a Fiat24 flow's recipient is the account or payee it names.
 */
export function assessRecipients(
  family: string,
  recipients: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
): ReadonlyArray<RiskFinding> {
  const knownSet = new Set(known.map((a) => comparable(family, a)));
  const found = new Map<RiskFinding["code"], RiskFinding>();
  for (const recipient of recipients) {
    const candidate = comparable(family, recipient);
    if (knownSet.has(candidate)) {
      continue;
    }
    found.set("first-recipient", { code: "first-recipient", level: "warning" });
    if ([...knownSet].some((k) => looksLike(candidate, k))) {
      found.set("address-poisoning", { code: "address-poisoning", level: "danger" });
    }
  }
  return byDanger([...found.values()]);
}

/**
 * Every party a decoded intent names as receiving value or authority over the signer's value: the
 * outflow recipients (a burned output's script is nobody — a destroyed amount has no recipient),
 * the recipients swap and bridge terms enforce, approval and permission grantees (a revocation
 * names nobody), the inner calls a batch names, and the destinations a recognized typed-data
 * document signs.
 */
export const intentRecipients = (intent: DisplayIntent): ReadonlyArray<string> => {
  const recipients: string[] = [];
  const push = (inner: DisplayIntent): void => {
    recipients.push(
      ...inner.outflows.filter((flow) => flow.burn !== true).map(recipientOf),
      ...(inner.minimumReceived?.map((minimum) => minimum.to) ?? []),
    );
    for (const approval of inner.approvals ?? []) {
      /* A grantee takes authority over the signer's value — assessed like a recipient; a
         revocation names nobody: a decrease, a zeroed allowance, a revoked operator or delegate,
         a cleared approval. */
      if (approval.kind === "allowance") {
        if (
          approval.change !== "decrease" &&
          !(approval.change === "set" && approval.amount.amount === "0")
        ) {
          recipients.push(approval.spender);
        }
      } else if (approval.kind === "operator") {
        if (approval.approved) {
          recipients.push(approval.spender);
        }
      } else if (approval.kind === "stake-authority") {
        recipients.push(approval.authority);
      }
    }
    if (inner.bridge !== undefined) {
      recipients.push(inner.bridge.refundTo);
    }
    if (inner.hyperliquidDeposit !== undefined) {
      recipients.push(inner.hyperliquidDeposit.recipient);
    }
    for (const action of inner.staking ?? []) {
      /* A withdraw's destination, the claim NFT's owner and a delegate's receiver take value off
         the signer; a split's `to` is the stake account the same call creates, and an
         undelegate's receiver only gets delegated resources back. */
      if (action.kind === "withdraw") {
        recipients.push(action.to);
      } else if (action.kind === "lido-request") {
        recipients.push(action.owner);
      } else if (action.kind === "tron-delegate") {
        recipients.push(action.receiver);
      }
    }
    const { permissionUpdate } = inner.tron ?? {};
    if (permissionUpdate !== undefined) {
      for (const permission of [
        permissionUpdate.owner,
        ...(permissionUpdate.witness === undefined ? [] : [permissionUpdate.witness]),
        ...permissionUpdate.actives,
      ]) {
        recipients.push(...permission.keys.map((key) => key.address));
      }
    }
    const { message } = inner;
    if (message?.kind === "typed-data") {
      recipients.push(...messageRecipients(message));
    }
    for (const call of inner.calls ?? []) {
      push(call);
    }
  };
  push(intent);
  return recipients;
};

/** The destinations a recognized typed-data document pays, wherever its own shape names them. */
const messageRecipients = (
  message: Extract<MessageContent, { kind: "typed-data" }>,
): ReadonlyArray<string> => {
  const recipients: string[] = [
    ...(message.order?.receive.map((entry) => entry.recipient) ?? []),
    ...(message.seaport?.consideration.map((item) => item.recipient) ?? []),
  ];
  const { safe } = message;
  if (safe !== undefined) {
    /* `to` receives value only when the call pays; a zero-value call can still move tokens, which
       its decoded inner calls already name. */
    if (safe.value !== "0") {
      recipients.push(safe.to);
    }
    for (const call of safe.calls) {
      recipients.push(...intentRecipients(call));
    }
    if (safe.refund?.receiver !== undefined) {
      recipients.push(safe.refund.receiver);
    }
  }
  const action = message.hyperliquid;
  /* Only the user-signed actions that pay a destination — usd-send, withdraw, spot-send and
     send-asset are exactly the shapes carrying `destination`. */
  if (action !== undefined && "destination" in action) {
    recipients.push(action.destination);
  }
  const { polymarket } = message;
  if (polymarket?.kind === "batch") {
    for (const call of polymarket.calls) {
      recipients.push(...intentRecipients(call));
    }
  }
  const { authorization } = message;
  if (authorization !== undefined && authorization.kind !== "cancel") {
    recipients.push(authorization.to);
  }
  const { authority } = message;
  /* Authority grants hand the signer's account to the grantee — assessed like recipients;
     a revocation (morpho grant=false, a zero aave credit line) names nobody, and a
     snapshot-alias grants no authority over value. */
  if (authority?.kind === "morpho") {
    if (authority.grant) {
      recipients.push(authority.authorized);
    }
  } else if (authority?.kind === "aave-credit" && authority.amount.amount !== "0") {
    recipients.push(authority.delegatee);
  }
  return recipients;
};

/**
 * Recipient findings for one decoded intent: {@link assessRecipients} over {@link intentRecipients},
 * except the signer itself — swaps, wraps and refunds routinely pay the account back.
 */
export function assessIntentRecipients(
  intent: DisplayIntent,
  self: string | undefined,
  known: ReadonlyArray<string>,
): ReadonlyArray<RiskFinding> {
  const own = self === undefined ? undefined : comparable(intent.family, self);
  return assessRecipients(
    intent.family,
    intentRecipients(intent).filter(
      (recipient) => own === undefined || comparable(intent.family, recipient) !== own,
    ),
    known,
  );
}

type DecodedIntent = Pick<DisplayIntent, "outflows" | "verifiability">;

const declaredOutflow = (intent: DecodedIntent, asset: string): bigint =>
  intent.outflows
    .filter((flow) => sameAsset(flow.amount.asset, asset))
    .reduce((sum, flow) => sum + BigInt(flow.amount.amount), 0n);

/**
 * What a simulation adds to a request. `unavailable` blocks silent approval; `reverted` is a
 * danger; an outflow above what the decode declares for that asset is a danger too — but only
 * against a decode that is not `opaque`, and never for Solana lamports (fees and rent always exceed
 * the declared amount).
 */
export function assessSimulation(
  intent: DecodedIntent,
  outcome: SimulationOutcome | undefined,
): { readonly checks: ReadonlyArray<RequestCheckCode>; readonly risk: ReadonlyArray<RiskFinding> } {
  if (outcome === undefined) {
    return { checks: [], risk: [] };
  }
  if (outcome.status === "unavailable") {
    return { checks: ["simulation-unavailable"], risk: [] };
  }
  if (outcome.status === "reverted") {
    return { checks: [], risk: [{ code: "simulation-reverted", level: "danger" }] };
  }
  const mismatch =
    intent.verifiability !== "opaque" &&
    outcome.changes.some((change) => {
      const amount = BigInt(change.amount);
      return (
        amount < 0n &&
        change.asset !== SOLANA_NATIVE_ASSET &&
        -amount > declaredOutflow(intent, change.asset)
      );
    });
  return {
    checks: [],
    risk: mismatch ? [{ code: "simulation-mismatch", level: "danger" }] : [],
  };
}

/**
 * A token on `chainId` that reports the symbol of a different, built-in token of the same chain —
 * the shape of a lookalike token. Symbols compare case-insensitively.
 */
export function impersonatesBuiltIn(chainId: number, address: string, symbol: string): boolean {
  const wanted = symbol.toLowerCase();
  return Object.entries(evmTokenTable[String(chainId)] ?? {}).some(
    ([known, token]) =>
      known.toLowerCase() !== address.toLowerCase() && token.symbol.toLowerCase() === wanted,
  );
}

/**
 * The TRC-20 counterpart of {@link impersonatesBuiltIn}: a contract reporting the symbol of a
 * different token in the TRON table. Addresses are base58 — case-sensitive, no checksum folding.
 */
export function impersonatesTronToken(network: string, address: string, symbol: string): boolean {
  const wanted = symbol.toLowerCase();
  return Object.entries(tronTokenTable[network] ?? {}).some(
    ([known, token]) => known !== address && token.symbol.toLowerCase() === wanted,
  );
}
