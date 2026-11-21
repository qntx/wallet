/**
 * The TRON interpreter of the family-claim table (src/families.ts), mirroring evm/families.ts: a
 * request a decoded family claims but which the decoder did not decode is blind with the row's
 * reason.
 */
import { RECOGNISED_FAMILIES } from "../families.ts";
import type { BlindReason } from "../index.ts";
import { lookupTronToken } from "./tokens.ts";
import type { TronTokenTable } from "./tokens.ts";

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
