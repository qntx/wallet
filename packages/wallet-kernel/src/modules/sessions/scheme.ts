import { isProtocolValue } from "@qntx/wallet/protocol";
import type {
  ProtocolValue,
  SessionSchemeId,
  SessionSchemes,
  Validator,
} from "@qntx/wallet/protocol";

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
   * Strict-validates a spent value against the parsed limits — the record's stored metering. Throws
   * on any failure: a spent the scheme's grammar does not accept is a tampered record.
   */
  readonly parseSpent: (value: unknown, limits: unknown) => unknown;
  /** The all-zero metering a fresh record is sealed with — a canonical JSON object. */
  readonly fresh: (limits: unknown) => ProtocolValue;
  /**
   * The spent value whose open-variant prompt renders the longest the limits admit — create checks
   * the dialog bound against it so a later open can never overflow.
   */
  readonly worstSpent: (limits: unknown) => ProtocolValue;
  /**
   * Charges `params` against `limits` and `spent` and returns the new spent as the scheme's
   * canonical JSON object — throws KernelError `invalid-input` on malformed params and
   * `limit-exceeded` past a budget. `spent` is the header's current value, already parsed.
   */
  readonly meter: (params: unknown, limits: unknown, spent: unknown) => ProtocolValue;
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
  /** The parsed metering — the open prompt reports what remains of it. */
  readonly spent: unknown;
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

/* The record header only stores JSON — a scheme whose metering does not encode as a plain JSON
   object is broken, not the caller. */
const asJsonObject = (value: unknown): ProtocolValue => {
  if (
    !isProtocolValue(value) ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new KernelError("integrity", "the scheme's spent is not a JSON object");
  }
  return value;
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
    readonly spent: (
      value: unknown,
      limits: SessionSchemes[K]["limits"],
    ) => SessionSchemes[K]["spent"];
    readonly fresh: (limits: SessionSchemes[K]["limits"]) => SessionSchemes[K]["spent"];
    readonly worstSpent: (limits: SessionSchemes[K]["limits"]) => SessionSchemes[K]["spent"];
    readonly meter: (
      params: SessionSchemes[K]["params"],
      limits: SessionSchemes[K]["limits"],
      spent: SessionSchemes[K]["spent"],
    ) => SessionSchemes[K]["spent"];
    readonly prompt: (
      session: Omit<SessionApproval, "limits" | "spent"> & {
        readonly limits: SessionSchemes[K]["limits"];
        readonly spent: SessionSchemes[K]["spent"];
      },
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
          parseSpent: (value: unknown, limits: unknown) =>
            declared.spent(value, declared.limits(limits)),
          fresh: (limits: unknown) => asJsonObject(declared.fresh(declared.limits(limits))),
          worstSpent: (limits: unknown) =>
            asJsonObject(declared.worstSpent(declared.limits(limits))),
          meter: (params: unknown, limits: unknown, spent: unknown) => {
            let checked: SessionSchemes[K]["params"];
            let checkedLimits: SessionSchemes[K]["limits"];
            let checkedSpent: SessionSchemes[K]["spent"];
            try {
              checked = definition.params(params);
              checkedLimits = declared.limits(limits);
              checkedSpent = declared.spent(spent, checkedLimits);
            } catch {
              throw new KernelError("invalid-input", "malformed params");
            }
            return asJsonObject(declared.meter(checked, checkedLimits, checkedSpent));
          },
          prompt: (
            session: SessionApproval,
            open: boolean,
            locale: PromptLocale,
          ): KeystorePrompt => {
            let limits: SessionSchemes[K]["limits"];
            let spent: SessionSchemes[K]["spent"];
            try {
              limits = declared.limits(session.limits);
              spent = declared.spent(session.spent, limits);
            } catch {
              throw new KernelError("integrity", "invalid session metering in the vault");
            }
            return declared.prompt({ ...session, limits, spent }, open, locale);
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
