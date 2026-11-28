import type { NameResolution, RiskFinding } from "@qntx/wallet-engine";

/** Display a verified primary name only; never fall back to an unchecked reverse record. */
export function primaryNameText(resolution: NameResolution | undefined): string | undefined {
  return resolution?.name;
}

/** Dangerous script mixtures need the same explicit acknowledgement path as other danger risk. */
export function nameAcknowledgementRequired(resolution: NameResolution): boolean {
  return resolution.risk.some((finding) => finding.code === "name-mixed-script");
}

/** The risk rows a host renders for a named recipient, danger first as the engine orders them. */
export function nameRiskRows(
  resolution: NameResolution,
): ReadonlyArray<Pick<RiskFinding, "code" | "level">> {
  return resolution.risk.map(({ code, level }) => ({ code, level }));
}

/** `.sol` input is a user correction during SNS's SRS migration, not a suffix the host rewrites. */
export function snsMigrationHint(recipient: string): string | undefined {
  return recipient.endsWith(".sol")
    ? "SNS names use .sns during the SRS migration — ask the owner for the .sns name."
    : undefined;
}
