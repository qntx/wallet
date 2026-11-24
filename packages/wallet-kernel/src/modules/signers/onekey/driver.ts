/**
 * The OneKey driver: Protocol-V1 message transport through `link.exchange({ kind: "message" })`,
 * pairing by Initialize + pinned account-node publication, host-initiated address display, and
 * staged plan signing through the family calls in ./protocol. Every wire detail — frames, schemas,
 * firmware gates — lives in the protocol client; the driver files adapt it to the Driver contract:
 * the `Exchange` shape (link.ts), the OneKeyError → KernelError table (errors.ts), the
 * pinned-material identity checks `wrong-device` guards (pair.ts, verify.ts, sign.ts), and the
 * record-identity → DeviceInfo synthesis `display` runs against (display.ts).
 */
import type { Driver } from "../driver.ts";
import { display } from "./display.ts";
import { accounts, pair } from "./pair.ts";
import { sign } from "./sign.ts";
import { verifyAddress } from "./verify.ts";

export const ONEKEY_DRIVER: Driver = { pair, accounts, verifyAddress, display, sign };
