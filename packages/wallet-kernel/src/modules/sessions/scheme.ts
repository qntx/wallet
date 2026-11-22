/**
 * The erased runtime shape of a session scheme and the typed definer schemes build through. The
 * generics are erased at the table boundary — a second scheme could not otherwise join
 * `SESSION_SCHEMES` without hitting TypeScript's correlated-union problem: each definition keeps
 * its own `SessionSchemes[K]` scope/params types while the table stores the erased
 * `SessionScheme`.
 */
import type { SessionSchemeId, SessionSchemes, Validator } from "@qntx/wallet/protocol";

import { KernelError } from "../../errors.ts";
import type { SessionHeader } from "./record.ts";

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
}): SessionScheme {
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
  };
}
