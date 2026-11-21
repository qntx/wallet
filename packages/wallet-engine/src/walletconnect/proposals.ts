import type { ProposalTypes } from "@walletconnect/types";
import { normalizeNamespaces } from "@walletconnect/utils";

import { parseWith, tokenName } from "../gateway/contract/index.ts";
import type { PhishingStatus } from "../phishing/status.ts";
import type { RiskFinding } from "../requests/risk.ts";
import { mergeRisk, originRisk, verifyRisk } from "../requests/risk.ts";
import type { WalletConnectVerify } from "../requests/types.ts";
import type { NamespaceRow, Offer } from "./namespaces.ts";
import { offerNamespaces } from "./namespaces.ts";

/** `metadata.url` reduced to its origin, or `undefined` when it is not an http(s) URL. */
export const metadataOrigin = (url: string | undefined): string | undefined => {
  if (typeof url !== "string") {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The peer's self-declared metadata, sanitized for display — never a verified identity. */
export const sanitizePeer = (
  metadata: { name?: unknown; description?: unknown; url?: unknown; icons?: unknown },
  url: string,
): { name: string; url: string; description: string; icons: ReadonlyArray<string> } => ({
  name: parseWith(tokenName, metadata.name) ?? new URL(url).host,
  url,
  description:
    typeof metadata.description === "string" && metadata.description.length <= 256
      ? metadata.description
      : "",
  icons: Array.isArray(metadata.icons)
    ? metadata.icons
        .filter((icon): icon is string => typeof icon === "string" && icon.startsWith("https://"))
        .slice(0, 4)
    : [],
});

/** A proposal or request's Verify context reduced to our verdict — display-only too. */
export const verifyOf = (verified: {
  readonly origin: string;
  readonly validation: string;
  readonly isScam?: boolean;
}): WalletConnectVerify => ({
  validation:
    verified.validation === "VALID" ||
    verified.validation === "INVALID" ||
    verified.validation === "UNKNOWN"
      ? verified.validation
      : "UNKNOWN",
  isScam: verified.isScam === true,
});

export type ProposalVerdict =
  | {
      readonly ok: true;
      readonly proposal: {
        readonly peer: {
          readonly name: string;
          readonly url: string;
          readonly description: string;
          readonly icons: ReadonlyArray<string>;
        };
        readonly verify: WalletConnectVerify;
        readonly risk: ReadonlyArray<RiskFinding>;
        readonly offer: Extract<Offer, { readonly ok: true }>;
        readonly expiresAt: number;
      };
    }
  | {
      readonly ok: false;
      /** The rejection reason for `rejectSession` — an SDK error or `getSdkError("USER_REJECTED")`. */
      readonly error: { readonly code: number; readonly message: string };
    };

/**
 * Validates a proposal end to end — peer URL, phishing list, namespace offer — without any SDK
 * call, so a live `session_proposal` and a recovered pending proposal take the same path.
 */
export const judgeProposal = (
  proposal: ProposalTypes.Struct,
  verify: WalletConnectVerify,
  deps: {
    readonly phishing: (url: string) => PhishingStatus;
    readonly isEnabled: (network: string) => boolean;
    readonly rows: Readonly<Record<string, NamespaceRow>>;
    readonly userRejected: () => { readonly code: number; readonly message: string };
  },
): ProposalVerdict => {
  const url = metadataOrigin(proposal.proposer.metadata.url);
  if (url === undefined) {
    return {
      ok: false,
      error: {
        ...deps.userRejected(),
        message: "the peer metadata url is not an http(s) origin",
      },
    };
  }
  const status = deps.phishing(url);
  if (status === "blocked") {
    return { ok: false, error: deps.userRejected() };
  }
  const offer = offerNamespaces(
    normalizeNamespaces(proposal.requiredNamespaces),
    normalizeNamespaces(proposal.optionalNamespaces),
    deps.rows,
    deps.isEnabled,
  );
  if (!offer.ok) {
    return { ok: false, error: offer.error };
  }
  return {
    ok: true,
    proposal: {
      peer: sanitizePeer(proposal.proposer.metadata, url),
      verify,
      risk: mergeRisk(originRisk(status), verifyRisk(verify)),
      offer,
      expiresAt: proposal.expiryTimestamp * 1000,
    },
  };
};
