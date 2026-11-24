/**
 * A scripted `SecureInput`: records every (kind, label) pair the kernel requests and answers from a
 * queue — a Uint8Array resolves `{ ok: true }`, `"cancelled"`/`"unavailable"` resolve the matching
 * failure. An empty queue answers `cancelled`, so a test sees exactly the requests it scripted and
 * nothing more.
 */
import type { SecureInput, SecureInputKind, SecureInputResult } from "../src/platform.ts";

export type SecureInputRequest = {
  readonly kind: SecureInputKind;
  readonly label: string;
};

export type FakeSecureInput = {
  readonly secureInput: SecureInput;
  /** Every request the kernel made, in order. */
  readonly requests: SecureInputRequest[];
  /** Scripts the next request's outcome; entries are consumed in order. */
  readonly answer: (outcome: Uint8Array | "cancelled" | "unavailable") => void;
};

export function fakeSecureInput(): FakeSecureInput {
  const requests: SecureInputRequest[] = [];
  const outcomes: SecureInputResult[] = [];
  const secureInput: SecureInput = {
    request: async (kind, label) => {
      requests.push({ kind, label });
      await Promise.resolve();
      return outcomes.shift() ?? { ok: false, failure: "cancelled" };
    },
    cancel: () => undefined,
  };
  return {
    secureInput,
    requests,
    answer: (outcome) => {
      outcomes.push(
        outcome instanceof Uint8Array
          ? { ok: true, value: outcome }
          : { ok: false, failure: outcome },
      );
    },
  };
}
