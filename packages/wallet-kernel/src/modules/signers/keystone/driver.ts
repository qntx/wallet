/**
 * The Keystone driver: QR air-gapped pairing and compare-style address checks. `pair` scans the
 * device's `crypto-multi-accounts` sync and pins the public material `sync.ts` admits;
 * `verifyAddress` asks the host to show the kernel's address for the user to compare against the
 * device menu (Keystone has no host-initiated address display). Signing and the key-derivation call
 * are not implemented yet — `display` returns `unsupported` so a sign request is refused before any
 * prompt, and `sign`/`accounts` refuse `unsupported`.
 */
import { KernelError } from "../../../errors.ts";
import type { Driver } from "../driver.ts";
import { pathToString } from "../record.ts";
import { parseSync } from "./sync.ts";

const unsupported = (): never => {
  throw new KernelError("unsupported", "keystone signing is not implemented yet");
};

export const KEYSTONE_DRIVER: Driver = {
  pair: async (link) =>
    parseSync(await link.exchange({ kind: "qr", scan: ["crypto-multi-accounts"] })),
  display: () => "unsupported",
  sign: unsupported,
  accounts: unsupported,
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
