/**
 * Status-word mapping (design §4): an allow-list per app turns a failure word into the LedgerError
 * the host can act on; every other word is `device-fault` — a word the command can legitimately
 * produce is never silently absorbed, and an unmapped word never leaks a device-supplied meaning.
 *
 * Sources: DMK `api/command/utils/GlobalCommandError.js` (OS words 5515/5501/6E00/6D00/6807),
 * ledger-app-solana `src/apdu.h` (6982/6808), ledger-app-tron `docs/APDU.md` + `src/app_errors.h`
 * (6A8B/6A8C/6A8D/6A8E), ledger-app-ethereum `src/apdu_constants.h` (6985 refusal), app-bitcoin-new
 * `src/boilerplate/sw.h` (6985 SW_DENY, 6A82 SW_NOT_SUPPORTED — e.g. get_extended_pubkey.c for an
 * unusual path without display).
 */
import type { LedgerErrorCode } from "./errors.ts";
import { LedgerError } from "./errors.ts";

export type LedgerApp = "bitcoin" | "ethereum" | "solana" | "tron";

type AppScope = LedgerApp | "dashboard";

/** The error assigned to a status word the allow-list knows. */
function mapped(app: AppScope, sw: number): LedgerErrorCode | undefined {
  switch (sw) {
    case 0x5515:
      return "device-locked";
    case 0x5501:
      return "user-rejected";
    case 0x6e00:
      return "app-not-open";
    case 0x6d00:
      // INS not supported — inside an app that passed requireApp the feature is not compiled
      // into the pinned build (e.g. EIP-7702 on app-ethereum 1.24.0).
      return "unsupported";
    default:
      break;
  }
  switch (app) {
    case "dashboard":
      if (sw === 0x6807) {
        return "app-not-installed";
      }
      break;
    case "solana":
      // ApduReplyNoApduReceived, documented as "Canceled by user" (doc/api.md).
      if (sw === 0x6982) {
        return "user-rejected";
      }
      // ApduReplySdkNotSupported — blind signing required (handle_sign_message.c).
      if (sw === 0x6808) {
        return "setting-required";
      }
      break;
    case "tron":
      if (sw === 0x6a8b || sw === 0x6a8c || sw === 0x6a8d) {
        return "setting-required";
      }
      if (sw === 0x6a8e) {
        return "unsupported";
      }
      break;
    case "bitcoin":
      // SW_NOT_SUPPORTED — the request needs something this build will not do, e.g. a
      // non-standard xpub path without display (get_extended_pubkey.c).
      if (sw === 0x6a82) {
        return "unsupported";
      }
      break;
    default:
      break;
  }
  // ApduReplyUserRefusal / SWO_CONDITIONS_NOT_SATISFIED / SW_DENY — user rejection; every pinned
  // app raises it, the dashboard does not.
  if (app !== "dashboard" && sw === 0x6985) {
    return "user-rejected";
  }
  return undefined;
}

const MESSAGES = {
  "invalid-input": "input out of range",
  transport: "transport framing violation",
  "invalid-response": "device returned an invalid response",
  "device-locked": "device is locked",
  "app-not-open": "the app is not open on the device",
  "app-not-installed": "the app is not installed on the device",
  "user-rejected": "the operation was refused on the device",
  "setting-required": "the app requires a setting that is off",
  unsupported: "the device does not support this request",
  "device-fault": "the device returned an unknown status word",
} as const satisfies Record<LedgerErrorCode, string>;

/** The LedgerError for status word `sw` seen on `app`; the word is always recorded. */
export function statusError(app: AppScope, sw: number): LedgerError {
  const code = mapped(app, sw) ?? "device-fault";
  return new LedgerError(code, MESSAGES[code], sw);
}
