/**
 * The EVM interpreters of the family-claim table (src/families.ts): a request a decoded family
 * claims but which the decoder did not decode is blind with the row's reason.
 */
import { RECOGNISED_FAMILIES } from "../families.ts";
import type { BlindReason } from "../index.ts";
import { PERMIT2_ADDRESS } from "./approval.ts";
import { SEAPORT_CONTRACTS } from "./seaport.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { typedDataAddress } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

/**
 * The claim an undecoded call into `to` makes on `chainId`: a listed token's selector table did
 * not decode it, so it is an unrecognised function of a token the owner holds.
 */
export const callNearMiss = (
  to: string,
  chainId: number,
  table: EvmTokenTable,
): BlindReason | undefined =>
  RECOGNISED_FAMILIES.find(
    (row) =>
      row.claim.surface === "evm.call" &&
      row.claim.callee === "token-table" &&
      lookupEvmToken(table, chainId, to) !== undefined,
  )?.nearMiss;

/**
 * The claim an unrecognised typed-data document makes: a family primary type, or a verifying
 * contract of Permit2, a canonical Seaport deployment or a listed token (case-insensitive).
 */
export const typedDataNearMiss = (
  json: TypedDataInput,
  chainId: number,
  table: EvmTokenTable,
): BlindReason | undefined => {
  const verifying = typedDataAddress(json.domain["verifyingContract"]);
  return RECOGNISED_FAMILIES.find((row) => {
    const { claim } = row;
    if (claim.surface !== "evm.typed-data") {
      return false;
    }
    if ("primaryType" in claim) {
      return claim.primaryType.test(json.primaryType);
    }
    if (verifying === undefined) {
      return false;
    }
    switch (claim.verifyingContract) {
      case "permit2":
        return verifying.toLowerCase() === PERMIT2_ADDRESS.toLowerCase();
      case "seaport":
        return SEAPORT_CONTRACTS.has(verifying.toLowerCase());
      case "token-table":
        return lookupEvmToken(table, chainId, verifying) !== undefined;
    }
  })?.nearMiss;
};
