/**
 * Recognition of Seaport `OrderComponents` typed data. A document is recognized only when the
 * domain names Seaport, the verifying contract is a canonical Seaport deployment (1.5 or 1.6), the
 * primary type is `OrderComponents` and every referenced struct has exactly the seaport-js field
 * lists; `BulkOrder` and any other shape stays an opaque message.
 */
import type { AssetAmount, SeaportItem, SeaportOrder } from "../index.ts";
import { MAX_UINT256 } from "./approval.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import { lookupEvmToken } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import {
  MAX_UINT48,
  sameFields,
  typedDataAddress,
  typedDataMessages,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput, TypedDataMessage } from "./typed-data.ts";

/** Seaport 1.5 and 1.6 deployments, lowercase for a checksum-insensitive compare. */
const SEAPORT_CONTRACTS = new Set([
  "0x0000000000000068f116a894984e2db1123eb395",
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
]);

/** Seaport `itemType` values 0–5; an item type outside the list is not recognized. */
const ITEM_KINDS = [
  "native",
  "erc20",
  "erc721",
  "erc1155",
  "erc721-criteria",
  "erc1155-criteria",
] as const;

const ITEM_FIELDS = [
  "uint8 itemType",
  "address token",
  "uint256 identifierOrCriteria",
  "uint256 startAmount",
  "uint256 endAmount",
];

const typesMatch = (types: TypedDataInput["types"]): boolean =>
  Object.keys(types).filter((name) => name !== "EIP712Domain").length === 3 &&
  sameFields(types, "OrderComponents", [
    "address offerer",
    "address zone",
    "OfferItem[] offer",
    "ConsiderationItem[] consideration",
    "uint8 orderType",
    "uint256 startTime",
    "uint256 endTime",
    "bytes32 zoneHash",
    "uint256 salt",
    "bytes32 conduitKey",
    "uint256 counter",
  ]) &&
  sameFields(types, "OfferItem", ITEM_FIELDS) &&
  sameFields(types, "ConsiderationItem", [...ITEM_FIELDS, "address recipient"]);

const amount = (
  kind: SeaportItem["kind"],
  token: string,
  value: bigint,
  chainId: number,
  table: EvmTokenTable,
): AssetAmount => {
  if (kind === "native") {
    return { asset: EVM_NATIVE_ASSET, amount: value.toString(10), symbol: "ETH", decimals: 18 };
  }
  if (kind === "erc20") {
    const found = lookupEvmToken(table, chainId, token);
    return {
      asset: token,
      amount: value.toString(10),
      ...(found === undefined ? {} : { symbol: found.symbol, decimals: found.decimals }),
    };
  }
  return { asset: token, amount: value.toString(10) };
};

const item = (
  message: TypedDataMessage,
  chainId: number,
  table: EvmTokenTable,
): SeaportItem | undefined => {
  const itemType = typedDataUint(message["itemType"], 255n);
  const token = typedDataAddress(message["token"]);
  const identifier = typedDataUint(message["identifierOrCriteria"], MAX_UINT256);
  const start = typedDataUint(message["startAmount"], MAX_UINT256);
  const end = typedDataUint(message["endAmount"], MAX_UINT256);
  const kind = itemType === undefined ? undefined : ITEM_KINDS[Number(itemType)];
  if (
    token === undefined ||
    identifier === undefined ||
    start === undefined ||
    end === undefined ||
    kind === undefined
  ) {
    return undefined;
  }
  return {
    kind,
    token,
    identifier: identifier.toString(10),
    startAmount: amount(kind, token, start, chainId, table),
    endAmount: amount(kind, token, end, chainId, table),
  };
};

const all = <T>(
  list: ReadonlyArray<TypedDataMessage> | undefined,
  build: (entry: TypedDataMessage) => T | undefined,
): ReadonlyArray<T> | undefined => {
  const built = list?.map(build);
  return built === undefined || built.some((entry) => entry === undefined)
    ? undefined
    : built.filter((entry): entry is T => entry !== undefined);
};

/**
 * The Seaport order a typed-data document signs, or `undefined` when its shape is not exactly the
 * recognized one. `chainId` is the request network's, used for the built-in token table.
 */
export function recognizeSeaport(
  json: TypedDataInput,
  chainId: number,
  table: EvmTokenTable,
): SeaportOrder | undefined {
  const { types, primaryType, message, domain } = json;
  if (primaryType !== "OrderComponents" || !typesMatch(types)) {
    return undefined;
  }
  const verifying = typedDataAddress(domain["verifyingContract"]);
  if (
    domain["name"] !== "Seaport" ||
    verifying === undefined ||
    !SEAPORT_CONTRACTS.has(verifying.toLowerCase())
  ) {
    return undefined;
  }
  const offerer = typedDataAddress(message["offerer"]);
  const zone = typedDataAddress(message["zone"]);
  const startTime = typedDataUint(message["startTime"], MAX_UINT256);
  const endTime = typedDataUint(message["endTime"], MAX_UINT256);
  const offer = all(typedDataMessages(message["offer"]), (entry) => item(entry, chainId, table));
  const consideration = all(typedDataMessages(message["consideration"]), (entry) => {
    const base = item(entry, chainId, table);
    const recipient = typedDataAddress(entry["recipient"]);
    return base === undefined || recipient === undefined ? undefined : { ...base, recipient };
  });
  if (
    offerer === undefined ||
    zone === undefined ||
    startTime === undefined ||
    endTime === undefined ||
    offer === undefined ||
    consideration === undefined
  ) {
    return undefined;
  }
  return {
    offerer,
    zone,
    startTime: startTime <= MAX_UINT48 ? Number(startTime) : undefined,
    endTime: endTime <= MAX_UINT48 ? Number(endTime) : undefined,
    offer,
    consideration,
  };
}
