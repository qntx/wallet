import * as Address from "ox/Address";

import { ChainError } from "../index.ts";

/** EIP-55 checksummed address, e.g. `0x52908400098527886E0F7030069857D2E4169EE7`. */
export const isEvmAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

export function checksumEvmAddress(address: string): string {
  if (!isEvmAddress(address)) {
    throw new ChainError("invalid-address", "not an EVM address");
  }
  const checksummed = Address.checksum(address);
  Address.assert(checksummed, { strict: true });
  return checksummed;
}
