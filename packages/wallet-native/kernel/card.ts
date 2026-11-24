/**
 * Binds the native `__qntx.cardReader` object to the kernel's `CardReader` contract. APDUs live
 * only here — the main runtime never sees them. The C++ side already validates what it hands over;
 * this module re-checks every result so a platform that reports an out-of-contract outcome (an
 * unknown code or a response outside the APDU limits) degrades to `unavailable` instead of feeding
 * the vault out-of-shape data.
 */
import type {
  CardReader,
  CardReaderFailure,
  CardReaderResult,
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
