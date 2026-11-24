import { pathToString } from "../../../derive/pinned.ts";
/**
 * The Keystone driver: QR air-gapped pairing, compare-style address checks, and QR signing. `pair`
 * scans the device's `crypto-multi-accounts` sync and pins the public material `sync.ts` admits;
 * `verifyAddress` asks the host to show the kernel's address for the user to compare against the
 * device menu (Keystone has no host-initiated address display). `sign` shows the registry request
 * `sign.ts` builds and admits only the answer to that exchange; `accounts` runs the
 * `qr-hardware-call` key-derivation exchange `derive.ts` pins.
 */
import { KernelError } from "../../../errors.ts";
import type { Driver } from "../driver.ts";
import { derive } from "./derive.ts";
import { display, sign } from "./sign.ts";
import { parseSync } from "./sync.ts";

export const KEYSTONE_DRIVER: Driver = {
  pair: async (link) =>
    parseSync(await link.exchange({ kind: "qr", scan: ["crypto-multi-accounts"] })),
  display,
  sign,
  accounts: derive,
  verifyAddress: async (link, target) => {
    const response = await link.exchange({
      kind: "compare",
      address: target.address,
      path: pathToString(target.path),
    });
    if (response.kind !== "compare") {
      throw new KernelError("integrity", "the compare answer is not a compare verdict");
    }
    return { method: "compare", matched: response.matched };
  },
};
