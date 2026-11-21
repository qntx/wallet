/**
 * TRON transaction codec against the tronweb-generated vectors and the real mainnet fixtures:
 * `buildTronRawData` reproduces tronweb's raw_data byte-for-byte, `sha256(raw) == txid`, and
 * decode∘encode is the identity on every accepted input.
 */
// oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect -- fixture comparisons iterate the node JSON
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import { tronAddressToHex } from "../src/tron/address.ts";
import {
  buildTronRawData,
  trc20ApproveContract,
  trc20TransferContract,
  TRON_MEMO_MAX_BYTES,
  tronMemoBytes,
} from "../src/tron/builders.ts";
import { decodeTronContract, encodeTronContract } from "../src/tron/contracts.ts";
import type { TronPermissionWire } from "../src/tron/contracts.ts";
import { TRON_MESSAGE_PREFIX, tronMessageDigest } from "../src/tron/message.ts";
import { readFields } from "../src/tron/proto.ts";
import {
  decodeTronRawData,
  encodeTronRawData,
  encodeTronTransaction,
  tronTransactionId,
} from "../src/tron/raw.ts";
import {
  bool,
  list,
  mainnetVectors,
  num,
  OWNER,
  parseInput,
  rec,
  str,
  tronVectors,
} from "./tron.ts";

const ALICE = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const BOB = "THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3";

const hex = (h: string): Uint8Array => hexToBytes(h);

describe("buildTronRawData", () => {
  it.each(tronVectors.transactions.filter((v) => v.input !== null))(
    "$name: reproduces tronweb's raw_data byte-for-byte and its txid",
    (vector) => {
      const { header, contract } = parseInput(vector.input);
      const built = buildTronRawData(header, contract);
      expect(bytesToHex(built)).toBe(vector.rawDataHex);
      expect(bytesToHex(tronTransactionId(built))).toBe(vector.txId);
      expect(bytesToHex(sha256(built))).toBe(vector.txId);
    },
  );
});

describe("decodeTronRawData", () => {
  it.each(tronVectors.transactions)("$name: decode∘encode is the identity", (vector) => {
    const bytes = hex(vector.rawDataHex);
    const raw = decodeTronRawData(bytes);
    expect(encodeTronRawData(raw)).toStrictEqual(bytes);
    expect(bytesToHex(tronTransactionId(bytes))).toBe(vector.txId);
  });

  it.each(mainnetVectors.transactions)(
    "mainnet $type $txid: decode∘encode is the identity",
    (vector) => {
      const bytes = hex(vector.raw_data_hex);
      const raw = decodeTronRawData(bytes);
      expect(encodeTronRawData(raw)).toStrictEqual(bytes);
      expect(bytesToHex(sha256(bytes))).toBe(vector.txid);
    },
  );
});

describe("mainnet fixtures", () => {
  it.each(mainnetVectors.transactions)(
    "$type $txid: decoded fields equal the node JSON",
    (vector) => {
      const node = vector.raw_data;
      const raw = decodeTronRawData(hex(vector.raw_data_hex));
      expect(bytesToHex(raw.refBlockBytes)).toBe(str(node["ref_block_bytes"]));
      expect(bytesToHex(raw.refBlockHash)).toBe(str(node["ref_block_hash"]));
      expect(raw.expiration).toBe(BigInt(num(node["expiration"])));
      expect(raw.timestamp ?? 0n).toBe(
        node["timestamp"] === undefined ? 0n : BigInt(num(node["timestamp"])),
      );
      expect(raw.feeLimit ?? 0n).toBe(
        node["fee_limit"] === undefined ? 0n : BigInt(num(node["fee_limit"])),
      );
      if (node["data"] !== undefined) {
        expect(bytesToHex(raw.memo ?? new Uint8Array(0))).toBe(str(node["data"]));
      }
      const nodeContract = rec(list(node["contract"])[0]);
      const parameter = rec(nodeContract["parameter"]);
      expect(raw.contract.typeUrl).toBe(str(parameter["type_url"]));
      expect(raw.contract.permissionId).toBe(
        nodeContract["Permission_id"] === undefined ? 0 : num(nodeContract["Permission_id"]),
      );
      const value = rec(parameter["value"]);
      const modeled = decodeTronContract(raw.contract.typeId, raw.contract.value);
      if (modeled === undefined) {
        return;
      }
      const c = modeled.contract;
      // The node's JSON omits fields set to their proto3 default (BANDWIDTH, false, 0);
      // bytes fields like asset_name and data come back hex-encoded.
      const addr = (v: unknown): string | undefined =>
        typeof v === "string" ? v.toLowerCase() : undefined;
      const big = (v: unknown): bigint => (v === undefined ? 0n : BigInt(num(v)));
      const hexText = (v: unknown): string => (v === undefined ? "" : str(v));
      expect("owner" in c ? tronAddressToHex(c.owner) : undefined).toBe(
        addr(value["owner_address"]),
      );
      switch (c.type) {
        case "TransferContract":
          expect(tronAddressToHex(c.to)).toBe(addr(value["to_address"]));
          expect(c.amount).toBe(big(value["amount"]));
          break;
        case "TransferAssetContract":
          expect(c.assetId).toBe(
            Buffer.from(hexText(value["asset_name"]), "hex").toString("ascii"),
          );
          expect(tronAddressToHex(c.to)).toBe(addr(value["to_address"]));
          expect(c.amount).toBe(big(value["amount"]));
          break;
        case "TriggerSmartContract":
          expect(tronAddressToHex(c.contract)).toBe(addr(value["contract_address"]));
          expect(c.callValue).toBe(big(value["call_value"]));
          expect(c.callTokenValue).toBe(big(value["call_token_value"]));
          expect(c.tokenId).toBe(big(value["token_id"]));
          expect(bytesToHex(c.data)).toBe(hexText(value["data"]));
          break;
        case "FreezeBalanceV2Contract":
          expect(c.amount).toBe(big(value["frozen_balance"]));
          expect(c.resource).toBe(resourceId(value["resource"]));
          break;
        case "UnfreezeBalanceV2Contract":
          expect(c.amount).toBe(big(value["unfreeze_balance"]));
          expect(c.resource).toBe(resourceId(value["resource"]));
          break;
        case "DelegateResourceContract":
          expect(c.balance).toBe(big(value["balance"]));
          expect(tronAddressToHex(c.receiver)).toBe(addr(value["receiver_address"]));
          expect(c.resource).toBe(resourceId(value["resource"]));
          expect(c.lock).toBe(value["lock"] === undefined ? false : bool(value["lock"]));
          expect(c.lockPeriod).toBe(big(value["lock_period"]));
          break;
        case "UnDelegateResourceContract":
          expect(c.balance).toBe(big(value["balance"]));
          expect(tronAddressToHex(c.receiver)).toBe(addr(value["receiver_address"]));
          expect(c.resource).toBe(resourceId(value["resource"]));
          break;
        case "VoteWitnessContract": {
          const votes = value["votes"] === undefined ? [] : list(value["votes"]).map(rec);
          expect(c.votes).toHaveLength(votes.length);
          for (const [i, vote] of votes.entries()) {
            const ours = c.votes[i] ?? fail("vote missing");
            expect(tronAddressToHex(ours.witness)).toBe(addr(vote["vote_address"]));
            expect(ours.count).toBe(big(vote["vote_count"]));
          }
          expect(c.support).toBe(value["support"] === undefined ? false : bool(value["support"]));
          break;
        }
        case "AccountPermissionUpdateContract": {
          const check = (ours: TronPermissionWire, theirs: Record<string, unknown>): void => {
            expect(ours.type).toBe(permTypeId(theirs["type"]));
            expect(ours.threshold).toBe(big(theirs["threshold"]));
            const keys = theirs["keys"] === undefined ? [] : list(theirs["keys"]).map(rec);
            expect(ours.keys).toHaveLength(keys.length);
            for (const [i, key] of keys.entries()) {
              const oursKey = ours.keys[i] ?? fail("key missing");
              expect(tronAddressToHex(oursKey.address)).toBe(addr(key["address"]));
              expect(oursKey.weight).toBe(big(key["weight"]));
            }
            if (theirs["operations"] !== undefined) {
              expect(bytesToHex(ours.operations)).toBe(str(theirs["operations"]));
            }
          };
          check(c.ownerPermission, rec(value["owner"]));
          if (value["witness"] !== undefined) {
            check(c.witnessPermission ?? fail("witness permission missing"), rec(value["witness"]));
          }
          const actives = value["actives"] === undefined ? [] : list(value["actives"]).map(rec);
          expect(c.actives).toHaveLength(actives.length);
          for (const [i, active] of actives.entries()) {
            check(c.actives[i] ?? fail("active missing"), active);
          }
          break;
        }
        default:
          break;
      }
    },
  );
});

const resourceId = (v: unknown): number =>
  v === "ENERGY" ? 1 : v === "TRON_POWER" ? 2 : v === "BANDWIDTH" || v === undefined ? 0 : -1;

const permTypeId = (v: unknown): number =>
  v === "Witness" ? 1 : v === "Active" ? 2 : v === "Owner" || v === undefined ? 0 : -1;

const fail = (what: string): never => {
  throw new Error(what);
};

describe("trc20 builders", () => {
  const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

  it("trc20TransferContract builds transfer calldata", () => {
    const c = trc20TransferContract(OWNER, USDT, ALICE, 10000000n);
    expect(c.type).toBe("TriggerSmartContract");
    if (c.type !== "TriggerSmartContract") {
      return;
    }
    expect(bytesToHex(c.data)).toBe(
      `a9059cbb000000000000000000000000${tronAddressToHex(ALICE).slice(2)}` +
        "0000000000000000000000000000000000000000000000000000000000989680",
    );
    expect(c.owner).toBe(OWNER);
    expect(c.contract).toBe(USDT);
  });

  it("trc20ApproveContract builds approve calldata", () => {
    const c = trc20ApproveContract(OWNER, USDT, BOB, 5000000n);
    if (c.type !== "TriggerSmartContract") {
      throw new Error("not a trigger");
    }
    expect(bytesToHex(c.data)).toBe(
      `095ea7b3000000000000000000000000${tronAddressToHex(BOB).slice(2)}` +
        "00000000000000000000000000000000000000000000000000000000004c4b40",
    );
  });
});

describe("buildTronRawData validation", () => {
  it("refuses a non-hex block id", () => {
    const { header, contract } = parseInput(tronVectors.transactions[0]?.input);
    expect(() =>
      buildTronRawData({ ...header, refBlock: { ...header.refBlock, id: "zz" } }, contract),
    ).toThrow(ChainError);
  });
});

describe("tronMemoBytes", () => {
  it("returns the exact UTF-8 bytes at the bounds", () => {
    expect(tronMemoBytes("x")).toStrictEqual(new Uint8Array([0x78]));
    expect(tronMemoBytes("é")).toStrictEqual(new Uint8Array([0xc3, 0xa9]));
    expect(tronMemoBytes("m".repeat(TRON_MEMO_MAX_BYTES))).toHaveLength(TRON_MEMO_MAX_BYTES);
  });

  it("refuses empty, oversized, newline and hidden inputs", () => {
    for (const bad of [
      "",
      "m".repeat(TRON_MEMO_MAX_BYTES + 1),
      "a\nb",
      "a\rb",
      "a\u200Bb",
      "a\u202Eb",
    ]) {
      expect(() => tronMemoBytes(bad)).toThrow(ChainError);
    }
  });
});

describe("tronMessageDigest", () => {
  it("matches the tronweb prefix scheme", () => {
    const message = new TextEncoder().encode("hello tron");
    const head = new TextEncoder().encode(`${TRON_MESSAGE_PREFIX}${message.length}`);
    const preimage = new Uint8Array(head.length + message.length);
    preimage.set(head);
    preimage.set(message, head.length);
    expect(tronMessageDigest(message)).toStrictEqual(keccak_256(preimage));
  });
});

describe("encodeTronContract", () => {
  it.each(tronVectors.transactions.filter((v) => v.input !== null))(
    "$name: encode∘decode∘encode the contract value",
    (vector) => {
      const raw = decodeTronRawData(hex(vector.rawDataHex));
      const modeled = decodeTronContract(raw.contract.typeId, raw.contract.value);
      expect(modeled?.extra).toStrictEqual([]);
      expect(encodeTronContract(modeled?.contract ?? fail("not modeled"))).toStrictEqual(
        raw.contract.value,
      );
      // decode(build) recovers the modeled contract
      const { contract } = parseInput(vector.input);
      const rebuilt = decodeTronContract(raw.contract.typeId, encodeTronContract(contract));
      expect(rebuilt?.contract).toStrictEqual(contract);
    },
  );
});

describe("encodeTronTransaction", () => {
  it.each(tronVectors.transactions)("$name: raw_data + signature round trip", (vector) => {
    const rawData = hex(vector.rawDataHex);
    const signatures = [hex(vector.signature)];
    const fields = readFields(encodeTronTransaction(rawData, signatures), [2]);
    expect(fields).toHaveLength(2);
    expect(fields[0]?.field).toBe(1);
    expect(fields[0]?.data).toStrictEqual(rawData);
    expect(fields[1]?.field).toBe(2);
    expect(fields[1]?.data).toStrictEqual(signatures[0]);
  });
});
