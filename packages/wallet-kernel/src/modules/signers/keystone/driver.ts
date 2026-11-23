/**
 * The Keystone driver: QR air-gapped signing. The protocol itself (UR/CBOR sync, sign and
 * multi-account flows) is not implemented yet — every method refuses `unsupported` so the module
 * scaffolding around it typechecks; `display` returns `unsupported` so a sign request is refused
 * before any prompt.
 */
import { KernelError } from "../../../errors.ts";
import type { Driver } from "../driver.ts";

const unsupported = (): never => {
  throw new KernelError("unsupported", "the keystone driver is not implemented yet");
};

export const KEYSTONE_DRIVER: Driver = {
  pair: unsupported,
  display: () => "unsupported",
  sign: unsupported,
  accounts: unsupported,
  verifyAddress: unsupported,
};
