import { BUILT_IN_NETWORKS } from "../networks.ts";

export { TRON_NATIVE_ASSET } from "./assets.ts";
export {
  TRON_ADDRESS_PREFIX,
  isTronAddress,
  tronAddressToBytes,
  tronAddressFromBytes,
  tronAddressToHex,
  tronAddressFromHex,
  tronAddressToEvm,
  tronAddressFromEvm,
  tronAddressFromPublicKey,
} from "./address.ts";

/** The TRON network ids in `BUILT_IN_NETWORKS` — mainnet plus the Shasta and Nile testnets. */
export const TRON_NETWORKS: ReadonlyArray<string> = Object.freeze(
  BUILT_IN_NETWORKS.filter((n) => n.family === "tron").map((n) => n.id),
);
