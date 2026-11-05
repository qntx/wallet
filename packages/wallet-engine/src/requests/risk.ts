import { SiwxError, checkOrigin, createMessage, parseTimestamp } from "@qntx/siwx";
import type { DisplayIntent, SignInParse } from "@qntx/wallet-chains";
import { evmTokenTable } from "@qntx/wallet-chains/evm";
import { SOLANA_NATIVE_ASSET } from "@qntx/wallet-chains/solana";

import type { PhishingStatus } from "../phishing/status.ts";
import type { RequestCheckCode } from "./checks.ts";
import { sameAsset } from "./simulation.ts";
import type { SimulationOutcome } from "./simulation.ts";

/**
 * Request risk, pure. A recipient the wallet has never paid or saved is a `warning`; one that looks
 * like a known address (same first and last four characters, different address) is a `danger` — the
 * shape of an address-poisoning lookalike. Both can apply to one recipient. A page the user trusts
 * despite the phishing list is a `danger`; one that could not be checked is a `warning`.
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
    | "blind-signing";
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
    } else if (change.change !== "decrease" && change.unlimited) {
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

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `scheme`, `host` (IPv6 keeps its brackets) of a `scheme://host[:port]` origin. */
const originParts = (origin: string): { scheme: string; host: string } => {
  const sep = origin.indexOf("://");
  const rest = origin.slice(sep + 3);
  const end = rest.startsWith("[") ? rest.indexOf("]") + 1 : rest.lastIndexOf(":");
  return {
    scheme: sep === -1 ? "" : origin.slice(0, sep).toLowerCase(),
    host: (end > 0 ? rest.slice(0, end) : rest).toLowerCase(),
  };
};

const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host) || host.endsWith(".localhost");

/**
 * What a Sign-In with Ethereum/Solana message adds to a request from `origin`: a message for
 * another domain is refused (`reject`) in production and a `danger` on a local development page;
 * the signing address must be the signer; an expired or not-yet-valid window and a text that only
 * resembles a sign-in message are warnings.
 */
export function assessSignIn(input: {
  readonly signIn: SignInParse;
  /** The page origin, `scheme://host[:port]`. */
  readonly origin: string;
  /** The address that will sign. */
  readonly signer: string;
  readonly family: "evm" | "solana";
  /** Milliseconds since the epoch. */
  readonly now: number;
}): { readonly reject?: string; readonly risk: ReadonlyArray<RiskFinding> } {
  const { signIn, origin, signer, family, now } = input;
  if (signIn.status === "malformed") {
    return { risk: [{ code: "sign-in-malformed", level: "warning" }] };
  }
  const { fields } = signIn;
  const { scheme, host } = originParts(origin);
  const developer = isLocalHost(host);
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

const looksLike = (a: string, b: string): boolean =>
  a !== b &&
  a.length >= POISONING_EDGE * 2 &&
  b.length >= POISONING_EDGE * 2 &&
  a.slice(0, POISONING_EDGE) === b.slice(0, POISONING_EDGE) &&
  a.slice(-POISONING_EDGE) === b.slice(-POISONING_EDGE);

/** Findings for every recipient of one request, deduplicated, `danger` first. */
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
