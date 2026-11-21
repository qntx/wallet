/**
 * The TRON interpreter of the family-claim table (src/families.ts), mirroring evm/families.ts: a
 * request a decoded family claims but which the decoder did not decode is blind with the row's
 * reason.
 */
import type { TypedDataInput } from "../evm/typed-data.ts";
import { RECOGNISED_FAMILIES } from "../families.ts";
import type { BlindReason } from "../index.ts";
import { TRON_PERMIT2 } from "./permit2.ts";
import { lookupTronToken } from "./tokens.ts";
import type { TronTokenTable } from "./tokens.ts";
import { tronTypedDataBase58 } from "./typed-data.ts";

/**
 * The claim an undecoded `TriggerSmartContract` into `callee` makes: a listed token's selector
 * table did not decode it, so it is an unrecognised function of a token the owner holds.
 */
export const tronCallNearMiss = (
  callee: string,
  network: string,
  table: TronTokenTable,
): BlindReason | undefined =>
  RECOGNISED_FAMILIES.find(
    (row) =>
      row.claim.surface === "tron.call" &&
      row.claim.callee === "token-table" &&
      lookupTronToken(table, network, callee) !== undefined,
  )?.nearMiss;

/**
 * The claim an unrecognised `tron.typed-data` document makes: a `Permit*` primary type, a Permit2
 * verifying contract, or a built-in TRC-20 verifying contract names a family the decoder should
 * have recognised — when it did not, the document blinds with the row's reason.
 */
export const tronTypedDataNearMiss = (
  json: TypedDataInput,
  network: string,
  table: TronTokenTable,
): BlindReason | undefined => {
  const verifying = tronTypedDataBase58(json.domain["verifyingContract"]);
  return RECOGNISED_FAMILIES.find((row) => {
    const { claim } = row;
    if (claim.surface !== "tron.typed-data") {
      return false;
    }
    if ("primaryType" in claim) {
      return claim.primaryType.test(json.primaryType);
    }
    if (verifying === undefined) {
      return false;
    }
    return (
      (claim.verifyingContract === "permit2" && verifying === TRON_PERMIT2[network]) ||
      (claim.verifyingContract === "token-table" &&
        lookupTronToken(table, network, verifying) !== undefined)
    );
  })?.nearMiss;
};
