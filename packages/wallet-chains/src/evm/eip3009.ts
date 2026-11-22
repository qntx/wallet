import type { AssetFlow, TokenAuthorization } from "../index.ts";
/**
 * Recognition of EIP-3009 authorizations — `TransferWithAuthorization`, `ReceiveWithAuthorization`
 * and `CancelAuthorization` as emitted by FiatToken (circlefin/stablecoin-evm@fc85788
 * `contracts/v2/EIP3009.sol`: the three TYPEHASH field lists).
 *
 * Binding rules beyond the field list: `types` is exactly `EIP712Domain` plus the one primary type,
 * the domain carries a `verifyingContract` (the token itself) and a `chainId` equal to the request
 * network's, and `from`/`authorizer` is the signer — FiatToken v2.2 checks the authorization with
 * `SignatureChecker.isValidSignatureNow(from, …)`, so a `from` that is an ERC-1271 contract wallet
 * could spend that contract's funds on this EOA's signature; anything else is a near miss
 * (`typed-data-variant`).
 *
 * `nonce` is a bytes32 one-time id the family owns — not a commitment, and not shown (the ERC-7730
 * registry descriptor marks it `visible: never`) except on `CancelAuthorization`, where it names
 * the authorization being cancelled.
 */
import { MAX_UINT256 } from "./approval.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import {
  domainChainId,
  sameFields,
  typedDataAddress,
  typedDataBytes,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

const TRANSFER_FIELDS = [
  "address from",
  "address to",
  "uint256 value",
  "uint256 validAfter",
  "uint256 validBefore",
  "bytes32 nonce",
] as const;

const CANCEL_FIELDS = ["address authorizer", "bytes32 nonce"] as const;

const MAX_UINT48_SECONDS = 2n ** 48n;

export type Eip3009Result = {
  readonly content: { readonly authorization: TokenAuthorization };
  readonly summary: "transfer" | "message";
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly verifiability: "full" | "partial";
};

/**
 * The authorization the document grants, or `undefined` when the shape is not exactly one of the
 * FiatToken EIP-3009 primary types bound to the signer on `chainId`.
 */
export function recognizeEip3009(
  json: TypedDataInput,
  chainId: number,
  table: EvmTokenTable,
  signer: string,
): Eip3009Result | undefined {
  const { types, primaryType, message, domain } = json;
  if (Object.keys(types).length !== 2 || domainChainId(domain) !== chainId) {
    return undefined;
  }
  const token = typedDataAddress(domain["verifyingContract"]);
  if (token === undefined) {
    return undefined;
  }
  const listed = lookupEvmToken(table, chainId, token);
  const amount = (value: bigint): AssetFlow["amount"] =>
    listed === undefined
      ? { asset: token, amount: value.toString() }
      : {
          asset: token,
          amount: value.toString(),
          symbol: listed.symbol,
          decimals: listed.decimals,
        };
  const isSigner = (candidate: string | undefined): boolean =>
    candidate !== undefined && candidate.toLowerCase() === signer.toLowerCase();

  if (primaryType === "TransferWithAuthorization" || primaryType === "ReceiveWithAuthorization") {
    if (!sameFields(types, primaryType, TRANSFER_FIELDS)) {
      return undefined;
    }
    const from = typedDataAddress(message["from"]);
    const to = typedDataAddress(message["to"]);
    const value = typedDataUint(message["value"], MAX_UINT256);
    const validAfter = typedDataUint(message["validAfter"], MAX_UINT256);
    const validBefore = typedDataUint(message["validBefore"], MAX_UINT256);
    const nonce = typedDataBytes(message["nonce"]);
    if (
      !isSigner(from) ||
      to === undefined ||
      value === undefined ||
      validAfter === undefined ||
      validAfter >= MAX_UINT48_SECONDS ||
      validBefore === undefined ||
      nonce === undefined ||
      nonce.length !== 66
    ) {
      return undefined;
    }
    return {
      content: {
        authorization: {
          kind: primaryType === "TransferWithAuthorization" ? "transfer" : "receive",
          to,
          amount: amount(value),
          validAfter: Number(validAfter),
          ...(validBefore < MAX_UINT48_SECONDS ? { validBefore: Number(validBefore) } : {}),
        },
      },
      summary: "transfer",
      outflows: [{ to, amount: amount(value), verified: listed !== undefined }],
      verifiability: listed === undefined ? "partial" : "full",
    };
  }
  if (primaryType === "CancelAuthorization") {
    if (!sameFields(types, primaryType, CANCEL_FIELDS)) {
      return undefined;
    }
    const authorizer = typedDataAddress(message["authorizer"]);
    const nonce = typedDataBytes(message["nonce"]);
    if (!isSigner(authorizer) || nonce === undefined || nonce.length !== 66) {
      return undefined;
    }
    return {
      content: {
        authorization: { kind: "cancel", token, nonce: nonce.toLowerCase() },
      },
      summary: "message",
      outflows: [],
      verifiability: "full",
    };
  }
  return undefined;
}
