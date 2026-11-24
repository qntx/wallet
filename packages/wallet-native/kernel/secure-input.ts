/**
 * Binds the native `__qntx.secureInput` object to the kernel's `SecureInput` contract — the card's
 * secrets and the cloud-backup password travel through here only, never the main runtime. The C++
 * side already validates what it hands over; this module re-checks every result so a platform that
 * reports an out-of-contract outcome (an unknown code, or bytes that do not match the requested
 * input kind) degrades to `unavailable` instead of feeding the vault out-of-shape data.
 */
import type {
  SecureInput,
  SecureInputKind,
  SecureInputResult,
} from "../../wallet-kernel/src/platform.ts";

type RequestDone = (value: Uint8Array | undefined, code: string | undefined) => void;

/** The `__qntx.secureInput` surface the native host injects. */
export type KernelSecureInputNative = {
  readonly request: (kind: SecureInputKind, label: string, done: RequestDone) => void;
  readonly cancel: () => void;
};

const isValidUtf8 = (value: Uint8Array): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * The hub's contract for `kind`, rechecked here: an access code is 1..64 printable-ASCII bytes, a
 * short id is exactly 8 upper-case hex characters, a backup password is 1..1024 bytes of valid
 * UTF-8, a session approval is exactly 4 ASCII digits. A platform that hands over out-of-shape
 * bytes gets them wiped, not forwarded.
 */
function validFor(kind: SecureInputKind, value: Uint8Array): boolean {
  // The closed kind set, in the shared enum order — the structure test reads it off this chain.
  if (kind === "access-code") {
    return (
      value.length > 0 && value.length <= 64 && value.every((byte) => byte >= 0x20 && byte <= 0x7e)
    );
  }
  if (kind === "short-id") {
    return (
      value.length === 8 &&
      value.every((byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46))
    );
  }
  if (kind === "backup-password") {
    return value.length > 0 && value.length <= 1024 && isValidUtf8(value);
  }
  if (kind === "session-approval") {
    return value.length === 4 && value.every((byte) => byte >= 0x30 && byte <= 0x39);
  }
  return false;
}

export function bindNativeSecureInput(raw: KernelSecureInputNative): SecureInput {
  return {
    request: async (kind, label) =>
      new Promise<SecureInputResult>((resolve) => {
        raw.request(kind, label, (value, code) => {
          if (value instanceof Uint8Array) {
            if (validFor(kind, value)) {
              resolve({ ok: true, value });
              return;
            }
            value.fill(0);
            resolve({ ok: false, failure: "unavailable" });
            return;
          }
          resolve({ ok: false, failure: code === "cancelled" ? "cancelled" : "unavailable" });
        });
      }),
    cancel: () => {
      raw.cancel();
    },
  };
}
