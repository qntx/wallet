/**
 * A scripted `SecureInput`: records every (kind, label) pair the kernel requests and answers from a
 * queue — a Uint8Array resolves `{ ok: true }`, `"cancelled"`/`"unavailable"` resolve the matching
 * failure. An empty queue answers `cancelled`, so a test sees exactly the requests it scripted and
 * nothing more — except `session-approval`, whose code the kernel draws at request time: the
 * `approval` option decides how an unscripted approval answers (`correct` re-enters the code the
 * label's last line shows, `wrong` enters a different one).
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";

import type { SecureInput, SecureInputKind, SecureInputResult } from "../src/platform.ts";

export type SecureInputRequest = {
  readonly kind: SecureInputKind;
  readonly label: string;
};

export type SessionApprovalAnswer = "correct" | "wrong" | "cancelled" | "unavailable";

export type FakeSecureInput = {
  readonly secureInput: SecureInput;
  /** Every request the kernel made, in order. */
  readonly requests: SecureInputRequest[];
  /** Scripts the next request's outcome; entries are consumed in order. */
  readonly answer: (outcome: Uint8Array | "cancelled" | "unavailable") => void;
  /** Changes the unscripted `session-approval` answer mid-test. */
  readonly setApproval: (next: SessionApprovalAnswer) => void;
};

/** The code a `session-approval` label's last line shows, or undefined when it shows none. */
export const labelCode = (label: string): string | undefined =>
  /([0-9]{4})/.exec(label.split("\n").at(-1) ?? "")?.[1];

export function fakeSecureInput(opts?: {
  readonly approval?: SessionApprovalAnswer;
}): FakeSecureInput {
  const requests: SecureInputRequest[] = [];
  const outcomes: SecureInputResult[] = [];
  let approval = opts?.approval ?? "cancelled";
  const secureInput: SecureInput = {
    request: async (kind, label) => {
      requests.push({ kind, label });
      await Promise.resolve();
      const scripted = outcomes.shift();
      if (scripted !== undefined) {
        return scripted;
      }
      if (kind === "session-approval") {
        if (approval === "correct" || approval === "wrong") {
          const code = labelCode(label);
          if (code === undefined) {
            return { ok: false, failure: "cancelled" };
          }
          const entered = approval === "correct" ? code : code === "0000" ? "0001" : "0000";
          return { ok: true, value: utf8ToBytes(entered) };
        }
        return { ok: false, failure: approval };
      }
      return { ok: false, failure: "cancelled" };
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
    setApproval: (next) => {
      approval = next;
    },
  };
}
