/**
 * Inner status-word mapping (protocol.md §9.2, §13.2): `result` turns a successfully unwrapped
 * response into its data or into the CardError the design's allow-list assigns. A failure word the
 * command can never produce — including `6700`, `6A86`, `6D00` — and any data carried by a failure
 * are `card-fault`.
 */
import type { CommandName, Inner } from "./commands.ts";
import type { CardStatus } from "./decode.ts";
import { CardError } from "./errors.ts";
import type { InnerResponse } from "./session.ts";

/** Words each command may legitimately fail with; `verify`'s `63Cx` range is checked separately. */
const ALLOWED: Readonly<Record<CommandName, ReadonlyArray<number>>> = {
  status: [],
  create: [0x6985, 0x6a80],
  verify: [0x6983, 0x6985],
  change: [0x6985, 0x6982],
  erase: [0x6985, 0x6982],
  wait: [0x6985],
  "public-key": [0x6985, 0x6982, 0x6a80],
  "sign-ecdsa": [0x6985, 0x6982, 0x6a80],
  "sign-bip340": [0x6985, 0x6982, 0x6a80],
  "ed25519-begin": [0x6985, 0x6982, 0x6a80],
  "ed25519-update": [0x6985, 0x6982],
  "ed25519-finish": [0x6985, 0x6982],
  offer: [],
  "export-head": [0x6985, 0x6982, 0x6a80],
  "export-payload": [0x6985, 0x6982],
  "import-head": [0x6985, 0x6a80],
  "import-payload": [0x6985, 0x6a80],
};

export function result(command: Inner, response: InnerResponse): Uint8Array {
  const { sw, data } = response;
  if (sw === 0x9000) {
    return data;
  }
  if (sw === 0x6f00) {
    throw new CardError("card-fault", "card reported an internal fault", sw);
  }
  if (data.length > 0) {
    throw new CardError("card-fault", "a failed command returned data", sw);
  }
  const { name } = command;
  if (name === "verify" && sw >= 0x63c1 && sw <= 0x63c9) {
    throw new CardError("wrong-access-code", "access code rejected", sw, sw - 0x63c0);
  }
  if (!ALLOWED[name].includes(sw)) {
    throw new CardError("card-fault", "command returned a status word it cannot produce", sw);
  }
  if (sw === 0x6983) {
    throw new CardError("wallet-erased", "failure count reached the erase limit", sw);
  }
  if (sw === 0x6985) {
    throw name === "verify"
      ? new CardError("wait-required", "verify is gated by the wait counter", sw)
      : new CardError("wrong-state", "command is not allowed in this card state", sw);
  }
  if (sw === 0x6982) {
    throw new CardError("not-verified", "command requires a verified session", sw);
  }
  // the only remaining word in every allow-list is 6A80
  throw new CardError("invalid-data", "command data was rejected by the card", sw);
}

/** §13.2 access policy: L failure limit, F free attempts, W waits per gated attempt. */
export const ACCESS_LIMITS = { failures: 10, free: 3, waits: 15 } as const;

/**
 * Waits needed before a `VERIFY` so the card accepts it without `6985` (§9.5 step 3, §9.15): `W`
 * while `tries ≤ L − F`, else `0`. `BLANK` — no wallet — and `tries = 0` — the next attempt would
 * erase without comparing — are `wrong-state`.
 */
export function waitsBeforeVerify(status: CardStatus): number {
  if (status.life === "blank") {
    throw new CardError("wrong-state", "a blank card holds no wallet");
  }
  if (status.tries === 0) {
    throw new CardError("wrong-state", "the next verify would erase without comparing");
  }
  return status.tries <= ACCESS_LIMITS.failures - ACCESS_LIMITS.free ? ACCESS_LIMITS.waits : 0;
}
