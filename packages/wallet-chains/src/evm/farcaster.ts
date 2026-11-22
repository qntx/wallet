/**
 * Recognition of Farcaster signer-key documents on OP Mainnet (farcasterxyz/contracts@9894509
 * src/KeyGateway.sol and src/validators/SignedKeyRequestValidator.sol — the only deployments, each
 * probed by scripts/vectors/account-authority.ts):
 *
 * - `Add(address owner,uint32 keyType,bytes key,uint8 metadataType,bytes metadata,uint256
 *   nonce,uint256 deadline)` to the KeyGateway adds an Ed25519 signer to the owner's Farcaster
 *   account — the key posts, reacts and follows as the owner until removed. The document binds
 *   `owner` to the signer (KeyGateway.add requires `owner == msg.sender ||` a signature from
 *   owner), carries the ed25519 `keyType` 1, a 32-byte key, `metadataType` 1 and metadata =
 *   `abi.encode(requestFid, requestSigner, signature, deadline)` — the app's signed key request.
 * - `SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)` to the validator is the app's
 *   key request that metadata embeds.
 *
 * Any other shape is not Farcaster and falls through to the generic rules.
 */
import * as AbiParameters from "ox/AbiParameters";
import * as Hex from "ox/Hex";

import type { FarcasterKey } from "../index.ts";
import {
  domainChainId,
  MAX_UINT48,
  sameFields,
  typedDataAddress,
  typedDataBytes,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";

export const FARCASTER_KEY_GATEWAY = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
export const FARCASTER_KEY_REQUEST_VALIDATOR = "0x00000000FC700472606ED4fA22623Acf62c60553";
const FARCASTER_CHAIN_ID = 10;

const DOMAIN_FIELDS = [
  "string name",
  "string version",
  "uint256 chainId",
  "address verifyingContract",
] as const;
const ADD_FIELDS = [
  "address owner",
  "uint32 keyType",
  "bytes key",
  "uint8 metadataType",
  "bytes metadata",
  "uint256 nonce",
  "uint256 deadline",
] as const;
const REQUEST_FIELDS = ["uint256 requestFid", "bytes key", "uint256 deadline"] as const;

const KEY_METADATA = [
  {
    type: "tuple",
    components: [
      { name: "requestFid", type: "uint256" },
      { name: "requestSigner", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  },
] as const;

const isUint = (value: unknown, max: bigint, expected: bigint): boolean =>
  typedDataUint(value, max) === expected;

const parseUint = (value: unknown): bigint | undefined => typedDataUint(value, 2n ** 256n - 1n);

const isKey = (value: unknown): value is `0x${string}` => {
  const bytes = typedDataBytes(value);
  return bytes !== undefined && Hex.size(bytes) === 32;
};

type KeyMetadata = {
  readonly requestFid: bigint;
  readonly requestSigner: `0x${string}`;
  readonly signature: `0x${string}`;
  readonly deadline: bigint;
};

const isKeyMetadata = (value: unknown): value is KeyMetadata =>
  typeof value === "object" &&
  value !== null &&
  "requestFid" in value &&
  typeof value.requestFid === "bigint" &&
  "requestSigner" in value &&
  typedDataAddress(value.requestSigner) !== undefined &&
  "signature" in value &&
  typedDataBytes(value.signature) !== undefined &&
  "deadline" in value &&
  typeof value.deadline === "bigint";

/* The app-supplied tuple, or undefined unless `bytes` is exactly its canonical ABI encoding. */
const decodeKeyMetadata = (bytes: `0x${string}`): KeyMetadata | undefined => {
  try {
    const decoded: unknown = AbiParameters.decode(KEY_METADATA, bytes);
    const tuple: unknown = Array.isArray(decoded) ? decoded[0] : undefined;
    if (
      !isKeyMetadata(tuple) ||
      AbiParameters.encode(KEY_METADATA, [tuple]).toLowerCase() !== bytes.toLowerCase()
    ) {
      return undefined;
    }
    return tuple;
  } catch {
    return undefined;
  }
};

export type FarcasterResult = {
  readonly content: { readonly farcaster: FarcasterKey };
  readonly summary: "authorization" | "message";
  readonly outflows: ReadonlyArray<never>;
  readonly verifiability: "partial";
};

const result = (
  farcaster: FarcasterKey,
  summary: "authorization" | "message",
): FarcasterResult => ({
  content: { farcaster },
  summary,
  outflows: [],
  verifiability: "partial",
});

/**
 * The Farcaster signer-key document, or `undefined` when the shape is not exactly a KeyGateway
 * `Add` bound to the signer or a `SignedKeyRequest` — on the OP Mainnet deployment.
 */
export const recognizeFarcaster = (
  json: TypedDataInput,
  chainId: number,
  signer: string,
): FarcasterResult | undefined => {
  const { types, primaryType, domain, message } = json;
  if (
    chainId !== FARCASTER_CHAIN_ID ||
    domainChainId(domain) !== chainId ||
    domain["version"] !== "1" ||
    Object.keys(domain).length !== 4 ||
    Object.keys(types).length !== 2 ||
    !sameFields(types, "EIP712Domain", DOMAIN_FIELDS)
  ) {
    return undefined;
  }
  const contract = typedDataAddress(domain["verifyingContract"]);
  if (contract === undefined) {
    return undefined;
  }
  if (
    primaryType === "Add" &&
    domain["name"] === "Farcaster KeyGateway" &&
    contract === FARCASTER_KEY_GATEWAY
  ) {
    if (!sameFields(types, "Add", ADD_FIELDS)) {
      return undefined;
    }
    const owner = typedDataAddress(message["owner"]);
    const { key } = message;
    const metadata = typedDataBytes(message["metadata"]);
    const nonce = parseUint(message["nonce"]);
    const deadline = parseUint(message["deadline"]);
    if (
      owner === undefined ||
      owner.toLowerCase() !== signer.toLowerCase() ||
      !isUint(message["keyType"], 2n ** 32n - 1n, 1n) ||
      !isKey(key) ||
      !isUint(message["metadataType"], 2n ** 8n - 1n, 1n) ||
      metadata === undefined ||
      nonce === undefined ||
      deadline === undefined
    ) {
      return undefined;
    }
    const app = decodeKeyMetadata(metadata);
    if (app === undefined) {
      return undefined;
    }
    return result(
      {
        kind: "add",
        key,
        requestFid: app.requestFid.toString(),
        ...(deadline <= MAX_UINT48 ? { deadline: Number(deadline) } : {}),
      },
      "authorization",
    );
  }
  if (
    primaryType === "SignedKeyRequest" &&
    domain["name"] === "Farcaster SignedKeyRequestValidator" &&
    contract === FARCASTER_KEY_REQUEST_VALIDATOR
  ) {
    if (!sameFields(types, "SignedKeyRequest", REQUEST_FIELDS)) {
      return undefined;
    }
    const requestFid = parseUint(message["requestFid"]);
    const { key } = message;
    const deadline = parseUint(message["deadline"]);
    if (requestFid === undefined || !isKey(key) || deadline === undefined) {
      return undefined;
    }
    return result(
      {
        kind: "request",
        key,
        requestFid: requestFid.toString(),
        ...(deadline <= MAX_UINT48 ? { deadline: Number(deadline) } : {}),
      },
      "message",
    );
  }
  return undefined;
};
