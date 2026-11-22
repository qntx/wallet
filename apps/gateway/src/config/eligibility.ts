import type { AppAvailability } from "@qntx/wallet-engine/gateway/contract";

/**
 * Per-app restricted-jurisdiction tables. Every entry carries its source; dates are when the source
 * was checked. These lists drive DISPLAY gating only — the platforms enforce their own restrictions
 * and this endpoint is not a security boundary.
 *
 * Sources:
 *
 * - Hyperliquid Terms of Use §1.6 (2026-06-15) — archived evidence/docs/pm-geoblock.md. §1.6(a) names
 *   the United States and Ontario; §1.6(b) covers comprehensively-sanctioned jurisdictions, which
 *   the terms do not enumerate — the OFAC comprehensive set is taken as published by Polymarket's
 *   geo-block table below.
 * - Polymarket geo-block table (2026-06-15) — https://polymarket.com/tos + geoblock list, archived
 *   evidence/docs/pm-geoblock.md.
 */

/** Iran, Syria, Cuba, North Korea, Crimea/Donetsk/Luhansk (UA-43/14/09) — sanctioned set. */
const SANCTIONED = ["IR", "SY", "CU", "KP", "UA-43", "UA-14", "UA-09"] as const;

/** One app's restricted-jurisdiction table — `blocked` always wins over `closeOnly`. */
export type EligibilityRow = {
  readonly blocked: ReadonlyArray<string>;
  readonly closeOnly: ReadonlyArray<string>;
};

/** The configured apps, keyed by app id — a client treats an absent app as unknown. */
export const ELIGIBILITY: Readonly<Record<string, EligibilityRow>> = {
  hyperliquid: {
    /* Terms §1.6(a): the United States — territories (PR/GU/VI/AS/MP/UM) are a conservative
       reading — and Ontario (CA-ON). §1.6(b): the sanctioned set. No close-only tier. */
    blocked: ["US", "PR", "GU", "VI", "AS", "MP", "UM", "CA-ON", ...SANCTIONED],
    closeOnly: [],
  },
  polymarket: {
    blocked: [...SANCTIONED],
    /* Polymarket geo-block table: frontend+API restricted jurisdictions. IE/JP/MT/NL/KR are the
       frontend-only tier — the wallet is a frontend, so they are close-only here. MT is
       "sports only" in the source and treated as close-only conservatively. KP also appears in
       the close-only table — blocked wins at lookup. */
    closeOnly: [
      "AR",
      "AU",
      "BY",
      "BE",
      "BI",
      "BR",
      "CA-BC",
      "CA-ON",
      "CA-AB",
      "CA-QC",
      "CF",
      "CD",
      "ET",
      "FR",
      "DE",
      "IQ",
      "IT",
      "LB",
      "LY",
      "MM",
      "NZ",
      "NI",
      "PL",
      "RU",
      "SG",
      "SO",
      "SK",
      "SS",
      "SD",
      "TW",
      "TH",
      "GB",
      "US",
      "UM",
      "VE",
      "YE",
      "ZW",
      "IE",
      "JP",
      "MT",
      "NL",
      "KR",
    ],
  },
};

/**
 * The app's availability for `${country}-${region}`: the subdivision code is checked first, then
 * the bare country — `blocked` always wins over `close-only`.
 */
export function availabilityFor(
  table: EligibilityRow,
  country: string,
  region?: string,
): AppAvailability {
  const codes = region === undefined ? [country] : [`${country}-${region}`, country];
  for (const code of codes) {
    if (table.blocked.includes(code)) {
      return "blocked";
    }
  }
  for (const code of codes) {
    if (table.closeOnly.includes(code)) {
      return "close-only";
    }
  }
  return "available";
}
