import type { DisplayIntent } from "@qntx/wallet-chains";
import { SOLANA_NATIVE_ASSET } from "@qntx/wallet-chains/solana";

import type { PhishingStatus } from "../phishing/status.ts";
import type { RequestCheckCode } from "./checks.ts";
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
    | "simulation-reverted"
    | "simulation-mismatch";
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

const sameAsset = (a: string, b: string): boolean =>
  a === b || (a.startsWith("0x") && a.toLowerCase() === b.toLowerCase());

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
