/**
 * A scripted `SecureInput` for kernel tests: queued replies (`bytes` accepts, `"cancelled"` and
 * `"unavailable"` reject, `"hold"` stays pending until `cancel()`), and a log of every request for
 * label assertions. An empty queue behaves like `"hold"` — the user simply never answers.
 */
import type { SecureInput, SecureInputKind, SecureInputResult } from "../../src/platform.ts";

export type InputReply = Uint8Array | "cancelled" | "unavailable" | "hold";

export type TestSecureInput = {
  readonly secureInput: SecureInput;
  /** Queue replies consumed in order by the next `request` calls. */
  readonly push: (...replies: InputReply[]) => void;
  /** Every `(kind, label)` the kernel asked for, in order. */
  readonly requests: Array<{ kind: SecureInputKind; label: string }>;
  /** Whether a request is still pending (blocked on `"hold"` or an empty queue). */
  readonly pending: () => boolean;
};

export function testSecureInput(): TestSecureInput {
  const replies: InputReply[] = [];
  const requests: Array<{ kind: SecureInputKind; label: string }> = [];
  let held: { resolve: (result: SecureInputResult) => void } | undefined;

  const secureInput: SecureInput = {
    request: async (kind, label) => {
      requests.push({ kind, label });
      const reply = replies.shift();
      if (reply === undefined || reply === "hold") {
        return new Promise<SecureInputResult>((resolve) => {
          held = { resolve };
        });
      }
      if (reply === "cancelled") {
        return { ok: false, failure: "cancelled" };
      }
      if (reply === "unavailable") {
        return { ok: false, failure: "unavailable" };
      }
      // The same buffer goes to the kernel — the wipe tests watch it zero out.
      return { ok: true, value: reply };
    },
    cancel: () => {
      const current = held;
      held = undefined;
      current?.resolve({ ok: false, failure: "cancelled" });
    },
  };
  return {
    secureInput,
    push: (...next) => {
      replies.push(...next);
    },
    requests,
    pending: () => held !== undefined,
  };
}
