/**
 * `tronRawDataFromJson(rawData, visible)` — a dApp's `raw_data` object → canonical raw_data bytes
 * under TronWeb `txJsonToPb`/`txCheck` semantics: each known contract's value keys are mapped
 * through our strict `TronContract` model and re-encoded by `encodeTronContract`, so the output is
 * exactly the protobuf the node JSON describes — `sha256(bytes) == txID` holds for any well-formed
 * node payload.
 *
 * Where the JSON grammar is stricter than TronWeb's loose parsing, the differences are listed for
 * the differential test:
 *
 * - Unknown keys anywhere (`raw_data`, `contract`, `parameter`, `value`, `votes[]`) refuse — txCheck
 *   ignores them.
 * - `value.support`, and `TriggerSmartContract.parameter` without `function_selector`, refuse —
 *   txCheck silently drops them, which would display an intent the bytes do not carry.
 * - `AccountPermissionUpdateContract` refuses — permission changes are never a dApp payload.
 * - Addresses are base58check when `visible`, `41`-hex otherwise; TronWeb's `toHex` accepts either
 *   form in either mode (and bare hex as garbage bytes) — we require the mode's form.
 * - Integers are decimal strings or safe integers in int64 range; TronWeb's jspb setters and
 *   `parseInt` accept trailing garbage and negative values (which encode non-canonically).
 * - `resource` accepts the `BANDWIDTH`/`ENERGY`/`TRON_POWER` names only, never a numeric enum.
 * - `asset_name` must decode to ASCII (as `decodeTronContract` requires); `ref_block_bytes`/`hash`
 *   must be exactly 2/8 bytes; `expiration` must be present and non-zero.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { isRecord } from "../account-ref.ts";
import { ChainError } from "../index.ts";
import { strictJson } from "../strict-json.ts";
import { isTronAddress, tronAddressFromHex, tronAddressToHex } from "./address.ts";
import { TRON_CONTRACT_TYPES, tronTypeUrl } from "./contract-types.ts";
import { encodeTronContract } from "./contracts.ts";
import type { TronContract, TronVote } from "./contracts.ts";
import { encodeTronRawData } from "./raw.ts";
import type { TronContractSlot, TronRawData } from "./raw.ts";

const refuse = (what: string): never => {
  throw new ChainError("invalid-request", what);
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

const HEADER_KEYS = new Set([
  "ref_block_bytes",
  "ref_block_hash",
  "expiration",
  "timestamp",
  "fee_limit",
  "data",
  "contract",
]);

const INT64_MAX = 2n ** 63n - 1n;

/** A non-negative int64 as a safe integer or decimal string — no floats, signs, or junk. */
const int64 = (value: unknown, what: string): bigint => {
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === "string" && /^[0-9]+$/.test(value)
        ? BigInt(value)
        : undefined;
  if (parsed === undefined || parsed < 0n || parsed > INT64_MAX) {
    return refuse(`${what} is not a non-negative int64`);
  }
  return parsed;
};

/**
 * Mirrors txJsonToPb's `stringToUint8Array`: an all-hex string (optional `0x`) is decoded as hex —
 * an odd tail nibble pairing like TronWeb's `.{1,2}` match — and anything else is UTF-8.
 */
const stringBytes = (value: unknown, what: string): Uint8Array => {
  if (typeof value !== "string") {
    return refuse(`${what} is not a string`);
  }
  const hex = /^(?:0x)?[0-9a-fA-F]+$/.test(value)
    ? value.replace(/^0x/, "")
    : bytesToHex(utf8ToBytes(value));
  return Uint8Array.from((hex.match(/.{1,2}/g) ?? []).map((p) => Number.parseInt(p, 16)));
};

/** An address in the mode `visible` dictates, returned as base58 for the contract model. */
const ownerAddress = (value: unknown, what: string, visible: boolean): string => {
  if (typeof value !== "string") {
    return refuse(`${what} is not a string`);
  }
  if (visible) {
    if (!isTronAddress(value)) {
      return refuse(`${what} is not a base58 TRON address`);
    }
    return tronAddressFromHex(tronAddressToHex(value));
  }
  if (!/^41[0-9a-fA-F]{40}$/.test(value)) {
    return refuse(`${what} is not a 41-hex TRON address`);
  }
  return tronAddressFromHex(`41${value.slice(2).toLowerCase()}`);
};

/**
 * `asset_name` via `flexToUint8Array`: visible → the UTF-8 bytes; hidden → the string's hex, or its
 * UTF-8 when it is not all-hex. The bytes must decode to the ASCII token id our model carries —
 * non-ASCII bytes cannot round-trip through `decodeTronContract`.
 */
const assetId = (value: unknown, visible: boolean): string => {
  if (typeof value !== "string") {
    return refuse("asset_name is not a string");
  }
  const bytes = visible ? utf8ToBytes(value) : stringBytes(value.replace(/^0x/, ""), "asset_name");
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return refuse("asset_name does not decode as UTF-8");
  }
  for (const c of text) {
    if ((c.codePointAt(0) ?? 0) > 0x7f) {
      return refuse("asset_name is not ASCII");
    }
  }
  return text;
};

const RESOURCE_CODES: Readonly<Record<string, number>> = {
  BANDWIDTH: 0,
  ENERGY: 1,
  TRON_POWER: 3,
};

const resourceCode = (value: unknown): number => {
  const code = typeof value === "string" ? RESOURCE_CODES[value] : undefined;
  if (code === undefined) {
    return refuse("resource is not BANDWIDTH, ENERGY or TRON_POWER");
  }
  return code;
};

/** The value object's keys are exactly `required` ∪ `optional` — nothing else, nothing missing. */
const fields = (
  type: string,
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      refuse(`${type}.${key} is not a known field`);
    }
  }
  for (const key of required) {
    if (value[key] === undefined) {
      refuse(`${type}.${key} is missing`);
    }
  }
};

const triggerData = (value: Record<string, unknown>): Uint8Array => {
  const { data } = value;
  const selector = value["function_selector"];
  const { parameter } = value;
  /* txJsonToPb throws when `data` mixes with a selector or a non-empty parameter, and ignores a
     bare `parameter` — both inputs we refuse rather than mis-model. */
  if (
    data !== undefined &&
    (selector !== undefined || (parameter !== undefined && parameter !== ""))
  ) {
    refuse("TriggerSmartContract.data cannot combine with function_selector or parameter");
  }
  if (parameter !== undefined && selector === undefined) {
    refuse("TriggerSmartContract.parameter requires function_selector");
  }
  if (data !== undefined) {
    return stringBytes(data, "data");
  }
  if (selector === undefined) {
    return new Uint8Array(0);
  }
  if (typeof selector !== "string") {
    return refuse("function_selector is not a string");
  }
  if (parameter !== undefined && typeof parameter !== "string") {
    return refuse("parameter is not a string");
  }
  /* sha3(selector)[0..4] + the parameter text, then the hex-or-UTF-8 read TronWeb applies. */
  const hash = bytesToHex(keccak_256(utf8ToBytes(selector))).slice(0, 8);
  return stringBytes(hash + (parameter ?? ""), "parameter");
};

const contractValue = (type: string, value: unknown, visible: boolean): TronContract => {
  if (!isRecord(value)) {
    return refuse(`${type}.parameter.value is not an object`);
  }
  const json = value;
  const owner = (): string => ownerAddress(json["owner_address"], "owner_address", visible);
  switch (type) {
    /* Node JSON elides proto3-default scalars — amount/resource/call_value absent means 0. */
    case "TransferContract":
      fields(type, json, ["owner_address", "to_address"], ["amount"]);
      return {
        type,
        owner: owner(),
        to: ownerAddress(json["to_address"], "to_address", visible),
        amount: json["amount"] === undefined ? 0n : int64(json["amount"], "amount"),
      };
    case "TransferAssetContract":
      fields(type, json, ["owner_address", "to_address", "asset_name"], ["amount"]);
      return {
        type,
        owner: owner(),
        to: ownerAddress(json["to_address"], "to_address", visible),
        assetId: assetId(json["asset_name"], visible),
        amount: json["amount"] === undefined ? 0n : int64(json["amount"], "amount"),
      };
    case "VoteWitnessContract": {
      fields(type, json, ["owner_address", "votes"]);
      const list = json["votes"];
      if (!Array.isArray(list)) {
        return refuse("votes is not an array");
      }
      const votes: TronVote[] = list.map((v: unknown, i: number) => {
        if (!isRecord(v)) {
          return refuse(`votes[${i}] is not an object`);
        }
        fields("votes[]", v, ["vote_address"], ["vote_count"]);
        return {
          witness: ownerAddress(v["vote_address"], `votes[${i}].vote_address`, visible),
          count:
            v["vote_count"] === undefined ? 0n : int64(v["vote_count"], `votes[${i}].vote_count`),
        };
      });
      return { type, owner: owner(), votes, support: false };
    }
    case "WithdrawBalanceContract":
    case "WithdrawExpireUnfreezeContract":
    case "CancelAllUnfreezeV2Contract":
      fields(type, json, ["owner_address"]);
      return { type, owner: owner() };
    case "TriggerSmartContract":
      fields(
        type,
        json,
        ["owner_address", "contract_address"],
        ["call_value", "call_token_value", "token_id", "data", "function_selector", "parameter"],
      );
      return {
        type,
        owner: owner(),
        contract: ownerAddress(json["contract_address"], "contract_address", visible),
        callValue: json["call_value"] === undefined ? 0n : int64(json["call_value"], "call_value"),
        data: triggerData(json),
        callTokenValue:
          json["call_token_value"] === undefined
            ? 0n
            : int64(json["call_token_value"], "call_token_value"),
        tokenId: json["token_id"] === undefined ? 0n : int64(json["token_id"], "token_id"),
      };
    case "FreezeBalanceV2Contract":
    case "UnfreezeBalanceV2Contract": {
      const amountKey = type === "FreezeBalanceV2Contract" ? "frozen_balance" : "unfreeze_balance";
      fields(type, json, ["owner_address"], [amountKey, "resource"]);
      return {
        type,
        owner: owner(),
        amount: json[amountKey] === undefined ? 0n : int64(json[amountKey], amountKey),
        resource: json["resource"] === undefined ? 0 : resourceCode(json["resource"]),
      };
    }
    case "DelegateResourceContract":
      fields(
        type,
        json,
        ["owner_address", "receiver_address"],
        ["balance", "resource", "lock", "lock_period"],
      );
      return {
        type,
        owner: owner(),
        receiver: ownerAddress(json["receiver_address"], "receiver_address", visible),
        balance: json["balance"] === undefined ? 0n : int64(json["balance"], "balance"),
        resource: json["resource"] === undefined ? 0 : resourceCode(json["resource"]),
        lock: json["lock"] === true,
        lockPeriod:
          json["lock_period"] === undefined ? 0n : int64(json["lock_period"], "lock_period"),
      };
    case "UnDelegateResourceContract":
      fields(type, json, ["owner_address", "receiver_address"], ["balance", "resource"]);
      return {
        type,
        owner: owner(),
        resource: json["resource"] === undefined ? 0 : resourceCode(json["resource"]),
        balance: json["balance"] === undefined ? 0n : int64(json["balance"], "balance"),
        receiver: ownerAddress(json["receiver_address"], "receiver_address", visible),
      };
    default:
      return refuse(`contract type ${JSON.stringify(type)} is not supported`);
  }
};

const CONTRACT_KEYS = new Set(["parameter", "type", "Permission_id"]);
const PARAMETER_KEYS = new Set(["value", "type_url"]);

const contractSlot = (value: unknown, visible: boolean): TronContractSlot => {
  if (!isRecord(value)) {
    return refuse("contract must be an object");
  }
  const json = value;
  for (const key of Object.keys(json)) {
    if (!CONTRACT_KEYS.has(key)) {
      refuse(`contract.${key} is not a contract field`);
    }
  }
  const { type } = json;
  if (typeof type !== "string") {
    return refuse("contract.type is not a string");
  }
  const name = type;
  const meta = TRON_CONTRACT_TYPES.find((t) => t.name === name);
  if (meta === undefined || meta.treatment !== "described") {
    return refuse(`contract type ${JSON.stringify(name)} is not supported`);
  }
  const typeMeta = meta;
  const { parameter } = json;
  if (!isRecord(parameter)) {
    return refuse("contract.parameter is not an object");
  }
  for (const key of Object.keys(parameter)) {
    if (!PARAMETER_KEYS.has(key)) {
      refuse(`contract.parameter.${key} is not a parameter field`);
    }
  }
  if (parameter["type_url"] !== tronTypeUrl(name)) {
    refuse(`contract.parameter.type_url does not name ${name}`);
  }
  const permissionId = json["Permission_id"];
  let permission = 0;
  if (permissionId !== undefined) {
    const parsed = int64(permissionId, "Permission_id");
    if (parsed > BigInt(0x7fffffff)) {
      refuse("Permission_id is out of range");
    }
    permission = Number(parsed);
  }
  return {
    typeId: typeMeta.id,
    typeUrl: tronTypeUrl(name),
    value: encodeTronContract(contractValue(name, parameter["value"], visible)),
    permissionId: permission,
    extra: [],
  };
};

/**
 * `raw_data` (object or its JSON text) → the canonical raw_data bytes. A JSON string is parsed
 * strictly — duplicate keys and trailing text are refused.
 */
export const tronRawDataFromJson = (rawData: unknown, visible: boolean): Uint8Array => {
  const parsed =
    typeof rawData === "string"
      ? strictJson(rawData, (reason) => refuse(`raw_data ${reason}`))
      : rawData;
  if (!isRecord(parsed)) {
    return refuse("raw_data must be an object");
  }
  const rd = parsed;
  for (const key of Object.keys(rd)) {
    if (!HEADER_KEYS.has(key)) {
      refuse(`raw_data.${key} is not a raw_data field`);
    }
  }
  const refBlockBytes = stringBytes(rd["ref_block_bytes"], "ref_block_bytes");
  if (refBlockBytes.length !== 2) {
    refuse("ref_block_bytes must be exactly 2 bytes");
  }
  const refBlockHash = stringBytes(rd["ref_block_hash"], "ref_block_hash");
  if (refBlockHash.length !== 8) {
    refuse("ref_block_hash must be exactly 8 bytes");
  }
  const expiration = int64(rd["expiration"], "expiration");
  if (expiration === 0n) {
    refuse("expiration is missing");
  }
  const timestamp = rd["timestamp"] === undefined ? undefined : int64(rd["timestamp"], "timestamp");
  const feeLimit = rd["fee_limit"] === undefined ? undefined : int64(rd["fee_limit"], "fee_limit");
  const memo = rd["data"] === undefined ? undefined : stringBytes(rd["data"], "data");
  const { contract } = rd;
  if (!Array.isArray(contract) || contract.length !== 1) {
    return refuse("contract must be an array of exactly one contract");
  }
  const raw: TronRawData = {
    refBlockBytes,
    refBlockHash,
    expiration,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(feeLimit === undefined ? {} : { feeLimit }),
    ...(memo === undefined ? {} : { memo }),
    contract: contractSlot(contract[0], visible),
    extra: [],
  };
  return encodeTronRawData(raw);
};
