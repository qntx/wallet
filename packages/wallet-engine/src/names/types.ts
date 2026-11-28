import type { RequestCheckCode } from "../requests/checks.ts";
import type { RiskFinding } from "../requests/risk.ts";

/** A cross-checked name answer: the normalized name, the address it pays, and its risk findings. */
export type NameResolution = {
  readonly name: string;
  readonly address: string;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  readonly risk: ReadonlyArray<RiskFinding>;
};

/** The primary and independent endpoints answered the same decisive name read differently. */
export class NameDisagreementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameDisagreementError";
  }
}
