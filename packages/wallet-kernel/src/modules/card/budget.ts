/**
 * Per-tap plan budget (host.md §8: one iOS connection plans for 18 s). Command prices are the
 * conservative milliseconds of protocol.md §16.6 — rounded up where the spec measures a real card —
 * plus 40 ms per APDU transit. `tap.cost()` sums the executed commands so an op can decide how much
 * work one tap may still carry. Only this table changes with real-device measurements.
 */
import type { CommandName } from "./protocol/commands.ts";

/** The plan one tap may spend, in milliseconds. */
export const PLAN_MS = 18_000;

/** Conservative per-command milliseconds (§16.6, each including its 40 ms transit). */
const PRICE: Readonly<Record<CommandName, number>> = {
  status: 40,
  create: 146,
  verify: 164,
  change: 164,
  erase: 164,
  wait: 1005,
  "public-key": 340,
  "sign-ecdsa": 451,
  "sign-bip340": 764,
  "ed25519-begin": 470,
  "ed25519-update": 61,
  "ed25519-finish": 526,
  offer: 177,
  "export-head": 464,
  "export-payload": 40,
  "import-head": 511,
  "import-payload": 40,
};

/** The OPEN round trip itself — every tap pays it. */
export const PRICE_OPEN = 200;

/** Estimated milliseconds one command costs the card-side budget. */
export const priceOf = (command: CommandName): number => PRICE[command];
