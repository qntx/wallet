/**
 * Row risk — pure flags over facts the chain reads established. `unlimited` and the spender probes
 * are inputs; address-poisoning reuses the request pipeline's lookalike check (its
 * `address-poisoning` finding only — a first-time grantee is not a finding here); a delegation not
 * pointing at this wallet's delegator is foreign.
 */
import { assessRecipients } from "../requests/risk.ts";
import type { ApprovalRisk } from "./types.ts";

export type RowRiskInput = {
  /** The network family — controls how `known` compares addresses. */
  readonly family: string;
  /** The party the row grants to; assessed for address-poisoning when present. */
  readonly grantee?: string;
  readonly unlimited?: boolean;
  /**
   * What the spender's own address reads as on chain: `eoa` — no code but a nonce (or a 7702
   * designator), `no-code` — nothing there at all, `contract` or `unknown` — no flag.
   */
  readonly spenderProbe?: "eoa" | "no-code" | "contract" | "unknown";
  /** The account's 7702 delegation targets a contract that is not this wallet's delegator. */
  readonly foreignDelegation?: boolean;
  /** The engine's known addresses for `family` — address book + paid recipients. */
  readonly known: ReadonlyArray<string>;
};

/** The risk flags one row carries, in stable order. */
export const assessRow = (input: RowRiskInput): ReadonlyArray<ApprovalRisk> => {
  const risks: ApprovalRisk[] = [];
  if (input.unlimited === true) {
    risks.push("unlimited");
  }
  if (input.spenderProbe === "eoa") {
    risks.push("eoa-spender");
  } else if (input.spenderProbe === "no-code") {
    risks.push("spender-no-code");
  }
  if (
    input.grantee !== undefined &&
    assessRecipients(input.family, [input.grantee], input.known).some(
      (finding) => finding.code === "address-poisoning",
    )
  ) {
    risks.push("address-poisoning");
  }
  if (input.foreignDelegation === true) {
    risks.push("foreign-delegation");
  }
  return risks;
};
