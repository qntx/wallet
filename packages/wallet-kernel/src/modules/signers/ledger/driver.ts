/**
 * The Ledger driver: APDU exchanges over `message` requests on the device link. `pair` claims the
 * BIP-32 master fingerprint from the Bitcoin app — the only Ledger app that reveals it — and pins
 * the four group-0 account xpubs; `accounts` serves one chain family per call; `verifyAddress` asks
 * the device to show the address; `sign` sends the recomputed payload per plan stage and admits
 * only yields that match the plan.
 */
import type { Driver } from "../driver.ts";
import { display } from "./display.ts";
import { accounts, pair } from "./pair.ts";
import { sign } from "./sign.ts";
import { verifyAddress } from "./verify.ts";

export const LEDGER_DRIVER: Driver = {
  pair,
  display,
  sign,
  accounts,
  verifyAddress,
};
