/**
 * The EVM interpreters of the family-claim table (src/families.ts): a request a decoded family
 * claims but which the decoder did not decode is blind with the row's reason.
 */
import { RECOGNISED_FAMILIES } from "../families.ts";
import type { BlindReason } from "../index.ts";
import { PERMIT2_ADDRESS } from "./approval.ts";
import { isMorphoBlue } from "./authority.ts";
import { hasFiat24Selector, isFiat24Contract } from "./fiat24.ts";
import { SEAPORT_CONTRACTS } from "./seaport.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { typedDataAddress } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

/**
 * The claim an undecoded call into `to` makes on `chainId`: the Fiat24 row's callee is a pinned
 * contract or a Fiat24-specific selector in `data`; a listed token's claim is the token table.
 */
export const callNearMiss = (
  to: string,
  chainId: number,
  table: EvmTokenTable,
  data: string,
): BlindReason | undefined =>
  RECOGNISED_FAMILIES.find((row) => {
    if (row.claim.surface !== "evm.call") {
      return false;
    }
    return row.claim.callee === "fiat24"
      ? isFiat24Contract(chainId, to) || hasFiat24Selector(data)
      : lookupEvmToken(table, chainId, to) !== undefined;
  })?.nearMiss;

/**
 * The claim a personal message's text makes: an exact, case-sensitive leading sentence of a
 * family's grant message. A grant-shaped text claims the family even though the wallet builds
 * grants only through its own structured request.
 */
export const personalMessageNearMiss = (text: string): BlindReason | undefined =>
  RECOGNISED_FAMILIES.find(
    (row) =>
      row.claim.surface === "evm.personal-message" &&
      row.claim.prefixes.some((prefix) => text.startsWith(prefix)),
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
    /* A contracts claim also carries domainName — either property claims the document, so it
       must be checked before the plain domainName branch. */
    if ("contracts" in claim) {
      const contract = verifying?.toLowerCase();
      return (
        json.domain["name"] === claim.domainName ||
        (contract !== undefined &&
          claim.contracts.some((address) => address.toLowerCase() === contract))
      );
    }
    if ("domainName" in claim) {
      return (
        json.domain["name"] === claim.domainName &&
        (claim.primaryType === undefined || claim.primaryType.test(json.primaryType))
      );
    }
    if ("primaryType" in claim) {
      return claim.primaryType.test(json.primaryType);
    }
    if (verifying === undefined) {
      return false;
    }
    const contract = verifying.toLowerCase();
    return (
      (claim.verifyingContract === "permit2" && contract === PERMIT2_ADDRESS.toLowerCase()) ||
      (claim.verifyingContract === "seaport" && SEAPORT_CONTRACTS.has(contract)) ||
      (claim.verifyingContract === "morpho-blue" && isMorphoBlue(chainId, contract)) ||
      (claim.verifyingContract === "token-table" &&
        lookupEvmToken(table, chainId, verifying) !== undefined)
    );
  })?.nearMiss;
};
