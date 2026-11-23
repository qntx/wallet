/** The device registry: one driver per `HardwareDevice` literal. Each device lane adds its own row. */
import type { HardwareDevice } from "@qntx/wallet/protocol";

import type { Driver } from "./driver.ts";
import { KEYSTONE_DRIVER } from "./keystone/driver.ts";
import { LEDGER_DRIVER } from "./ledger/driver.ts";

export const DRIVERS: Readonly<Record<HardwareDevice, Driver>> = {
  keystone: KEYSTONE_DRIVER,
  ledger: LEDGER_DRIVER,
};
