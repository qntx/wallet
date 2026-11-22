/**
 * The Hyperliquid L1 document encoder: the msgpack writer's branch boundaries, the connectionId
 * against the oracle vectors of vectors/chains/hyperliquid.json, and the phantom-agent document the
 * session signature covers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { hyperliquidL1Document, l1ConnectionId } from "../src/evm/hyperliquid-l1.ts";
import { packArray, packBool, packInt, packMap, packStr } from "../src/evm/msgpack.ts";

type L1Case = {
  readonly name: string;
  readonly action: Record<string, unknown>;
  readonly nonce: number;
  readonly vaultAddress?: string;
  readonly expiresAfter?: number;
  readonly network: "Mainnet" | "Testnet";
  readonly connectionId: string;
  readonly digest: string;
  readonly privateKey: string;
  readonly signature: string;
};

/** L1ConnectionId args for a vector: optional fields appear only when the vector carries them. */
const l1IdArgs = (vector: L1Case) => ({
  action: vector.action as never,
  nonce: vector.nonce,
  ...(vector.vaultAddress === undefined ? {} : { vaultAddress: vector.vaultAddress }),
  ...(vector.expiresAfter === undefined ? {} : { expiresAfter: vector.expiresAfter }),
});

const l1Cases = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/hyperliquid.json"), "utf8"),
  ) as { l1: L1Case[] }
).l1;
const allowListed = l1Cases.filter((c) => c.action["type"] !== "dummy");

describe("msgpack writer: branch boundaries", () => {
  const hex = (bytes: Uint8Array): string => bytesToHex(bytes);
  const ints: ReadonlyArray<[number, string]> = [
    [0, "00"],
    [127, "7f"],
    [128, "cc80"],
    [255, "ccff"],
    [256, "cd0100"],
    [65535, "cdffff"],
    [65536, "ce00010000"],
    [4294967295, "ceffffffff"],
    [4294967296, "cf0000000100000000"],
    [-1, "ff"],
    [-32, "e0"],
    [-33, "d0df"],
    [-128, "d080"],
    [-129, "d1ff7f"],
    [-32768, "d18000"],
    [-32769, "d2ffff7fff"],
    [-2147483648, "d280000000"],
    [-2147483649, "d3ffffffff7fffffff"],
  ];

  it.each(ints)("packInt(%i) uses the smallest encoding", (value, expected) => {
    expect(hex(packInt(value))).toBe(expected);
  });

  it("packInt rejects non-integers and unsafe values", () => {
    for (const value of [0.5, Number.NaN, 2 ** 53, -(2 ** 53)]) {
      expect(() => packInt(value)).toThrow("unreachable: non-integer msgpack field");
    }
  });

  it("packStr uses fixstr under 32 bytes and str 8/16 above", () => {
    const s = (n: number) => "a".repeat(n);
    expect(hex(packStr(s(31)))).toBe(`bf${"61".repeat(31)}`);
    expect(hex(packStr(s(32)))).toBe(`d920${"61".repeat(32)}`);
    expect(hex(packStr(s(255)))).toBe(`d9ff${"61".repeat(255)}`);
    expect(hex(packStr(s(256)))).toBe(`da0100${"61".repeat(256)}`);
  });

  it("packBool is the two literal bytes", () => {
    expect(hex(packBool(false))).toBe("c2");
    expect(hex(packBool(true))).toBe("c3");
  });

  it("packArray uses fixarray under 16 entries and array 16 above", () => {
    const items = (n: number) => Array.from({ length: n }, () => packInt(0));
    expect(hex(packArray(items(15)))).toBe(`9f${"00".repeat(15)}`);
    expect(hex(packArray(items(16)))).toBe(`dc0010${"00".repeat(16)}`);
  });

  it("packMap uses fixmap under 16 entries and map 16 above", () => {
    expect(hex(packMap([["k", packInt(1)]]))).toBe("81a16b01");
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => [`k${i}`, packInt(i)] as const);
    expect(hex(packMap(entries(15)))).toBe(
      `8f${entries(15)
        .map(([k, v]) => `${hex(packStr(k))}${hex(v)}`)
        .join("")}`,
    );
    expect(hex(packMap(entries(16)))).toBe(
      `de0010${entries(16)
        .map(([k, v]) => `${hex(packStr(k))}${hex(v)}`)
        .join("")}`,
    );
  });
});

describe("L1 connectionId against the oracle vectors", () => {
  it.each(allowListed)("$name", (vector) => {
    expect(bytesToHex(l1ConnectionId(l1IdArgs(vector)))).toBe(vector.connectionId.slice(2));
  });
});

const l1Params = (vector: L1Case) => ({
  action: vector.action as never,
  nonce: vector.nonce,
  ...(vector.vaultAddress === undefined ? {} : { vaultAddress: vector.vaultAddress }),
  expiresAfter: vector.expiresAfter ?? vector.nonce + 15_000,
});

describe("hyperliquidL1Document", () => {
  it.each(allowListed)("$name signs the phantom-agent Agent document", (vector) => {
    const doc = JSON.parse(hyperliquidL1Document(l1Params(vector), vector.network)) as {
      primaryType: string;
      domain: { name: string; version: string; chainId: number; verifyingContract: string };
      message: { source: string; connectionId: string };
    };
    expect(doc.primaryType).toBe("Agent");
    expect(doc.domain).toStrictEqual({
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
    expect(doc.message.source).toBe({ Mainnet: "a", Testnet: "b" }[vector.network]);
  });

  /* Vectors that carry an expiresAfter pin the exact connectionId the signature covers. */
  it.each(allowListed.filter((c) => c.expiresAfter !== undefined))(
    "$name carries the vector's connectionId",
    (vector) => {
      const doc = JSON.parse(hyperliquidL1Document(l1Params(vector), vector.network)) as {
        message: { connectionId: string };
      };
      expect(doc.message.connectionId).toBe(vector.connectionId);
    },
  );
});
