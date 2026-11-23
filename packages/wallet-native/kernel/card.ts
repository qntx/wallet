/**
 * Binds the native `__qntx.cardReader` and `__qntx.secureInput` objects to the kernel's
 * `CardReader` and `SecureInput` contracts. APDUs and access-code bytes live only here — the main
 * runtime never sees them. The C++ side already validates what it hands over; this module re-checks
 * every result so a platform that reports an out-of-contract outcome (an unknown code, a response
 * outside the APDU limits, bytes that do not match the requested input kind) degrades to
 * `unavailable` instead of feeding the vault out-of-shape data.
 */
import type {
  CardReader,
  CardReaderFailure,
  CardReaderResult,
  SecureInput,
  SecureInputKind,
  SecureInputResult,
} from "../../wallet-kernel/src/platform.ts";
import { detailOf } from "./detail.ts";

type OpenDone = (code: string | undefined, detail: string | undefined) => void;
type TransmitDone = (
  response: Uint8Array | undefined,
  code: string | undefined,
  detail: string | undefined,
) => void;

/** The `__qntx.cardReader` surface the native host injects. */
export type KernelCardReaderNative = {
  readonly open: (prompt: string, done: OpenDone) => void;
  readonly transmit: (apdu: Uint8Array, done: TransmitDone) => void;
  readonly close: (outcome: "success" | "failure", text: string) => void;
};

type RequestDone = (value: Uint8Array | undefined, code: string | undefined) => void;

/** The `__qntx.secureInput` surface the native host injects. */
export type KernelSecureInputNative = {
  readonly request: (kind: SecureInputKind, label: string, done: RequestDone) => void;
  readonly cancel: () => void;
};

// A card answer is data ‖ SW1 ‖ SW2.
const RESPONSE_MIN = 2;
const RESPONSE_MAX = 258;

const isReaderFailure = (code: string | undefined): code is CardReaderFailure =>
  code === "cancelled" ||
  code === "timeout" ||
  code === "tag-lost" ||
  code === "interrupted" ||
  code === "unavailable";

function readerOutcome(
  code: string | undefined,
  detail: string | undefined,
): CardReaderResult<never> {
  return {
    ok: false,
    failure: isReaderFailure(code) ? code : "unavailable",
    detail: detailOf(detail),
  };
}

export function bindNativeCardReader(raw: KernelCardReaderNative): CardReader {
  return {
    open: async (prompt) =>
      new Promise((resolve) => {
        raw.open(prompt, (code, detail) => {
          resolve(
            code === undefined ? { ok: true, value: undefined } : readerOutcome(code, detail),
          );
        });
      }),
    transmit: async (apdu) =>
      new Promise((resolve) => {
        raw.transmit(apdu, (response, code, detail) => {
          if (response !== undefined) {
            resolve(
              response instanceof Uint8Array &&
                response.length >= RESPONSE_MIN &&
                response.length <= RESPONSE_MAX
                ? { ok: true, value: response }
                : { ok: false, failure: "unavailable", detail: undefined },
            );
            return;
          }
          resolve(readerOutcome(code, detail));
        });
      }),
    close: (outcome, text) => {
      raw.close(outcome, text);
    },
  };
}

/**
 * The hub's contract for `kind`, rechecked here: an access code is 1..64 printable-ASCII bytes, a
 * short id is exactly 8 upper-case hex characters. A platform that hands over out-of-shape bytes
 * gets them wiped, not forwarded.
 */
function validFor(kind: SecureInputKind, value: Uint8Array): boolean {
  if (kind === "access-code") {
    return (
      value.length > 0 && value.length <= 64 && value.every((byte) => byte >= 0x20 && byte <= 0x7e)
    );
  }
  return (
    value.length === 8 &&
    value.every((byte) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46))
  );
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
