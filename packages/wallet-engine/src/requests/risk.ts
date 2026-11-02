/**
 * Recipient risk, pure: a recipient the wallet has never paid or saved is a `warning`; one that
 * looks like a known address (same first and last four characters, different address) is a `danger`
 * — the shape of an address-poisoning lookalike. Both can apply to one recipient.
 */
export type RiskFinding = {
  readonly code: "first-recipient" | "address-poisoning";
  readonly level: "warning" | "danger";
};

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
  return [...found.values()].sort(
    (a, b) => Number(b.level === "danger") - Number(a.level === "danger"),
  );
}
