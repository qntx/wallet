/**
 * Shared TRON vector plumbing: loads vectors/chains/tron.json transactions and parses their JSON
 * `input` (bigint fields as decimal strings, bytes as 0x hex) back into builder types.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";

import type { SignRequest } from "../src/index.ts";
import type { TronBlockRef, TronTransactionHeader } from "../src/tron/builders.ts";
import type { TronContract, TronPermissionWire, TronVote } from "../src/tron/contracts.ts";

export type TronVector = {
  readonly name: string;
  readonly input: unknown;
  readonly rawDataHex: string;
  readonly txId: string;
  readonly signature: string;
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated vector file has a fixed shape
export const tronVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/tron.json"), "utf8"),
) as {
  keys: Array<{ name: string; privateKey: string; address: string }>;
  transactions: ReadonlyArray<TronVector>;
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fetched fixture file has a fixed shape
export const mainnetVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/tron-mainnet.json"), "utf8"),
) as {
  transactions: ReadonlyArray<{
    bucket: string;
    txid: string;
    type: string;
    raw_data_hex: string;
    raw_data: Record<string, unknown>;
    signature: ReadonlyArray<string>;
  }>;
};

const anvil = tronVectors.keys.find((k) => k.name === "anvil");
if (anvil === undefined) {
  throw new Error("vectors: no anvil key");
}
/** The anvil key's address — `owner`/`signer` of every generated vector. */
export const OWNER: string = anvil.address;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Accessors that fail loudly when a fixture field has the wrong shape. */
export const str = (v: unknown): string => {
  if (typeof v !== "string") {
    throw new TypeError("vector: expected string");
  }
  return v;
};

export const num = (v: unknown): number => {
  if (typeof v !== "number") {
    throw new TypeError("vector: expected number");
  }
  return v;
};

export const bool = (v: unknown): boolean => {
  if (typeof v !== "boolean") {
    throw new TypeError("vector: expected boolean");
  }
  return v;
};

export const rec = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) {
    throw new Error("vector: expected object");
  }
  return v;
};

export const list = (v: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(v)) {
    throw new TypeError("vector: expected array");
  }
  return v;
};

export const hex = (v: unknown): Uint8Array => {
  const s = str(v);
  if (!/^0x[0-9a-fA-F]*$/.test(s)) {
    throw new Error("vector: expected 0x hex");
  }
  return hexToBytes(s.slice(2));
};

const dec = (v: unknown): bigint => {
  const s = str(v);
  if (!/^[0-9]+$/.test(s)) {
    throw new Error("vector: expected decimal string");
  }
  return BigInt(s);
};

const permission = (v: unknown): TronPermissionWire => {
  const p = rec(v);
  return {
    type: num(p["type"]),
    id: num(p["id"]),
    name: str(p["name"]),
    threshold: dec(p["threshold"]),
    parentId: num(p["parentId"]),
    operations: hex(p["operations"]),
    keys: list(p["keys"]).map((k) => ({
      address: str(rec(k)["address"]),
      weight: dec(rec(k)["weight"]),
    })),
  };
};

export const parseContract = (v: unknown): TronContract => {
  const c = rec(v);
  switch (str(c["type"])) {
    case "TransferContract":
      return {
        type: "TransferContract",
        owner: str(c["owner"]),
        to: str(c["to"]),
        amount: dec(c["amount"]),
      };
    case "TransferAssetContract":
      return {
        type: "TransferAssetContract",
        owner: str(c["owner"]),
        to: str(c["to"]),
        assetId: str(c["assetId"]),
        amount: dec(c["amount"]),
      };
    case "VoteWitnessContract":
      return {
        type: "VoteWitnessContract",
        owner: str(c["owner"]),
        votes: list(c["votes"]).map((x): TronVote => ({
          witness: str(rec(x)["witness"]),
          count: dec(rec(x)["count"]),
        })),
        support: bool(c["support"]),
      };
    case "WithdrawBalanceContract":
      return { type: "WithdrawBalanceContract", owner: str(c["owner"]) };
    case "TriggerSmartContract":
      return {
        type: "TriggerSmartContract",
        owner: str(c["owner"]),
        contract: str(c["contract"]),
        callValue: dec(c["callValue"]),
        data: hex(c["data"]),
        callTokenValue: dec(c["callTokenValue"]),
        tokenId: dec(c["tokenId"]),
      };
    case "FreezeBalanceV2Contract":
      return {
        type: "FreezeBalanceV2Contract",
        owner: str(c["owner"]),
        amount: dec(c["amount"]),
        resource: num(c["resource"]),
      };
    case "UnfreezeBalanceV2Contract":
      return {
        type: "UnfreezeBalanceV2Contract",
        owner: str(c["owner"]),
        amount: dec(c["amount"]),
        resource: num(c["resource"]),
      };
    case "WithdrawExpireUnfreezeContract":
      return { type: "WithdrawExpireUnfreezeContract", owner: str(c["owner"]) };
    case "DelegateResourceContract":
      return {
        type: "DelegateResourceContract",
        owner: str(c["owner"]),
        resource: num(c["resource"]),
        balance: dec(c["balance"]),
        receiver: str(c["receiver"]),
        lock: bool(c["lock"]),
        lockPeriod: dec(c["lockPeriod"]),
      };
    case "UnDelegateResourceContract":
      return {
        type: "UnDelegateResourceContract",
        owner: str(c["owner"]),
        resource: num(c["resource"]),
        balance: dec(c["balance"]),
        receiver: str(c["receiver"]),
      };
    case "CancelAllUnfreezeV2Contract":
      return { type: "CancelAllUnfreezeV2Contract", owner: str(c["owner"]) };
    case "AccountPermissionUpdateContract":
      return {
        type: "AccountPermissionUpdateContract",
        owner: str(c["owner"]),
        ownerPermission: permission(c["ownerPermission"]),
        ...(c["witnessPermission"] === undefined
          ? {}
          : { witnessPermission: permission(c["witnessPermission"]) }),
        actives: list(c["actives"]).map(permission),
      };
    default:
      throw new Error(`vector: unknown contract type ${str(c["type"])}`);
  }
};

export const parseHeader = (v: unknown): TronTransactionHeader => {
  const h = rec(v);
  const refBlock = rec(h["refBlock"]);
  return {
    refBlock: {
      number: num(refBlock["number"]),
      id: str(refBlock["id"]),
    } satisfies TronBlockRef,
    expiration: num(h["expiration"]),
    timestamp: num(h["timestamp"]),
    ...(h["feeLimit"] === undefined ? {} : { feeLimit: dec(h["feeLimit"]) }),
    ...(h["memo"] === undefined ? {} : { memo: hex(h["memo"]) }),
    ...(h["permissionId"] === undefined ? {} : { permissionId: num(h["permissionId"]) }),
  };
};

export const parseInput = (
  input: unknown,
): { readonly header: TronTransactionHeader; readonly contract: TronContract } => {
  if (!isRecord(input)) {
    throw new Error("vector: input must be an object");
  }
  return { header: parseHeader(input["header"]), contract: parseContract(input["contract"]) };
};

export const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44" as const,
};

export const txRequest = (rawDataHex: string): SignRequest => ({
  kind: "tron.transaction",
  network: "tron:728126428",
  account: ACCOUNT,
  rawData: hexToBytes(rawDataHex),
});
