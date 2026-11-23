/** The device registry: one driver per `HardwareDevice` literal. Each device lane adds its own row. */
import type { HardwareDevice } from "@qntx/wallet/protocol";

import type { Driver } from "./driver.ts";
import { KEYSTONE_DRIVER } from "./keystone/driver.ts";
import { ONEKEY_DRIVER } from "./onekey/driver.ts";

export const DRIVERS: Readonly<Record<HardwareDevice, Driver>> = {
  keystone: KEYSTONE_DRIVER,
  onekey: ONEKEY_DRIVER,
};
