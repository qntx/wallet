import type { SessionSchemeId, SessionSchemes, Validator } from "@qntx/wallet/protocol";

import { KernelError } from "../../errors.ts";
/**
 * The erased runtime shape of a session scheme and the typed definer schemes build through. The
 * generics are erased at the table boundary — a second scheme could not otherwise join
 * `SESSION_SCHEMES` without hitting TypeScript's correlated-union problem: each definition keeps
 * its own `SessionSchemes[K]` scope/params types while the table stores the erased
 * `SessionScheme`.
 */
import type { KeystorePrompt } from "../../platform.ts";
import type { PromptLocale } from "../../prompts.ts";
import type { SessionHeader } from "./record.ts";

/**
 * What a value-moving scheme declares so the kernel can bind it to a budget: the strict `limits`
 * validator run at create and again on every stored header, the metering that turns a signed action
 * into the session's new spent (or throws `limit-exceeded`), and the approval text the verification
 * prompt shows. A scheme without `metering` signs without accounting — the sessions handlers skip
 * the limits/open/spend path entirely.
 */
export type SessionMetering = {
  /** Strict-validates a limits value into the canonical object the record header stores. */
  readonly parseLimits: (value: unknown) => unknown;
  /**
   * Charges `params` against `limits` and `spent` and returns the new spent as a canonical decimal
   * — throws KernelError `invalid-input` on malformed params and `limit-exceeded` past the budget.
   * `spent` is the header's current value (a canonical decimal, "0" when fresh).
   */
  readonly meter: (params: unknown, limits: unknown, spent: string) => string;
  /** The verification prompt for create (`open` false) and reopen (`open` true). */
  readonly prompt: (
    session: SessionApproval,
    open: boolean,
    locale: PromptLocale,
  ) => KeystorePrompt;
};

/** Everything the approval text needs, resolved before the prompt is rendered. */
export type SessionApproval = {
  readonly scope: string;
  readonly name: string;
  readonly validUntil: number;
  readonly limits: unknown;
  /** Canonical decimal already charged — the open prompt reports the remaining budget. */
  readonly spent: string;
};

export type SessionScheme = {
  readonly id: SessionSchemeId;
  readonly maxTtlMs: number;
  readonly maxPerVault: number;
  /** Strict-validates a scope value — throws on an invalid scope. */
  readonly parseScope: (value: unknown) => string;
  /**
   * Strict-validates `params` (failure → KernelError invalid-input "malformed params"), applies the
   * scheme's signing policy (KernelError invalid-input) and returns the exact EIP-712 JSON document
   * the signature covers. The host never supplies a document.
   */
  readonly document: (params: unknown, header: SessionHeader, now: number) => string;
  /** Present on value-moving schemes: limits validation, metering and the approval prompt. */
  readonly metering?: SessionMetering;
};

export function defineSessionScheme<K extends SessionSchemeId>(definition: {
  readonly id: K;
  readonly maxTtlMs: number;
  readonly maxPerVault: number;
  readonly parseScope: Validator<SessionSchemes[K]["scope"]>;
  readonly params: Validator<SessionSchemes[K]["params"]>;
  readonly document: (
    params: SessionSchemes[K]["params"],
    header: SessionHeader,
    scope: SessionSchemes[K]["scope"],
    now: number,
  ) => string;
  readonly metering?: {
    readonly limits: Validator<SessionSchemes[K]["limits"]>;
    readonly meter: (
      params: SessionSchemes[K]["params"],
      limits: SessionSchemes[K]["limits"],
      spent: string,
    ) => string;
    readonly prompt: (
      session: Omit<SessionApproval, "limits"> & { readonly limits: SessionSchemes[K]["limits"] },
      open: boolean,
      locale: PromptLocale,
    ) => KeystorePrompt;
  };
}): SessionScheme {
  const declared = definition.metering;
  const metering =
    declared === undefined
      ? undefined
      : {
          parseLimits: declared.limits,
          meter: (params: unknown, limits: unknown, spent: string) => {
            let checked: SessionSchemes[K]["params"];
            let checkedLimits: SessionSchemes[K]["limits"];
            try {
              checked = definition.params(params);
              checkedLimits = declared.limits(limits);
            } catch {
              throw new KernelError("invalid-input", "malformed params");
            }
            return declared.meter(checked, checkedLimits, spent);
          },
          prompt: (
            session: SessionApproval,
            open: boolean,
            locale: PromptLocale,
          ): KeystorePrompt => {
            let limits: SessionSchemes[K]["limits"];
            try {
              limits = declared.limits(session.limits);
            } catch {
              throw new KernelError("integrity", "invalid session limits in the vault");
            }
            return declared.prompt({ ...session, limits }, open, locale);
          },
        };
  return {
    id: definition.id,
    maxTtlMs: definition.maxTtlMs,
    maxPerVault: definition.maxPerVault,
    parseScope: definition.parseScope,
    document: (params, header, now) => {
      let checked: SessionSchemes[K]["params"];
      let scope: SessionSchemes[K]["scope"];
      try {
        checked = definition.params(params);
        scope = definition.parseScope(header.scope);
      } catch {
        throw new KernelError("invalid-input", "malformed params");
      }
      return definition.document(checked, header, scope, now);
    },
    ...(metering === undefined ? {} : { metering }),
  };
}
