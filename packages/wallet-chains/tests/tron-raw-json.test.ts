/**
 * `tronRawDataFromJson` — TronWeb `txJsonToPb`/`txCheck` semantics. Every supported mainnet
 * vector's node JSON re-encodes byte-for-byte to its raw_data_hex (sha256 == txID), in visible
 * (`41`-hex) and non-visible (base58) address modes; `AccountPermissionUpdateContract` is refused.
 * The differential block mutates each vector's raw_data one field at a time and requires our
 * accept/refuse to agree with tronweb's `txCheck`, except for the documented stricter cases listed
 * in STRICTER (they mirror the header comment of src/tron/json.ts).
 */
// oxlint-disable vitest/expect-expect -- differential/refuse helpers wrap the expect calls
import { createRequire } from "node:module";

import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import { tronAddressFromHex } from "../src/tron/address.ts";
import { tronRawDataFromJson } from "../src/tron/json.ts";
import { mainnetVectors } from "./tron.ts";

const req = createRequire(import.meta.url);
const { txCheck, txJsonToPb, txPbToRawDataHex } = req("tronweb/utils") as {
  txCheck: (transaction: unknown) => boolean;
  txJsonToPb: (transaction: unknown) => unknown;
  txPbToRawDataHex: (pb: unknown) => string;
};

/** Tronweb's own JSON → protobuf encoder: the byte-level oracle for `tronRawDataFromJson`. */
const oracleHex = (raw: RawData, visible: boolean): string =>
  txPbToRawDataHex(txJsonToPb({ raw_data: raw, visible })).toLowerCase();

type RawData = Record<string, unknown>;
const clone = (v: RawData): RawData => structuredClone(v);

const SUPPORTED = new Set([
  "TransferContract",
  "TransferAssetContract",
  "VoteWitnessContract",
  "WithdrawBalanceContract",
  "TriggerSmartContract",
  "FreezeBalanceV2Contract",
  "UnfreezeBalanceV2Contract",
  "WithdrawExpireUnfreezeContract",
  "DelegateResourceContract",
  "UnDelegateResourceContract",
  "CancelAllUnfreezeV2Contract",
]);

const vectors = mainnetVectors.transactions.filter((t) => SUPPORTED.has(t.type));

/** The node JSON's hex form → the base58 form visible=true mode sends. */
const toVisible = (raw: RawData): RawData => {
  const out = clone(raw);
  const contracts = out["contract"] as Array<Record<string, unknown>>;
  const parameter = contracts[0]?.["parameter"] as Record<string, unknown> | undefined;
  const value = parameter?.["value"] as RawData | undefined;
  if (value === undefined) {
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key === "asset_name" && typeof v === "string" && /^[0-9a-fA-F]+$/.test(v)) {
      value[key] = new TextDecoder().decode(
        Uint8Array.from((v.match(/.{2}/g) ?? []).map((p) => Number.parseInt(p, 16))),
      );
      continue;
    }
    if (typeof v === "string" && /^41[0-9a-fA-F]{40}$/.test(v)) {
      value[key] = tronAddressFromHex(v);
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") {
          for (const [k2, v2] of Object.entries(item as RawData)) {
            if (typeof v2 === "string" && /^41[0-9a-fA-F]{40}$/.test(v2)) {
              (item as RawData)[k2] = tronAddressFromHex(v2);
            }
          }
        }
      }
    }
  }
  return out;
};

describe("tronRawDataFromJson mainnet vectors", () => {
  it.each(vectors)("$type $txid: node JSON re-encodes to raw_data_hex", (t) => {
    expect(bytesToHex(tronRawDataFromJson(t.raw_data, false))).toBe(t.raw_data_hex);
  });

  it.each(vectors)("$type $txid: base58 mode re-encodes to raw_data_hex", (t) => {
    expect(bytesToHex(tronRawDataFromJson(toVisible(t.raw_data), true))).toBe(t.raw_data_hex);
  });

  it.each(["FreezeBalanceV2Contract", "UnfreezeBalanceV2Contract"] as const)(
    "a TRON_POWER %s encodes exactly like txJsonToPb",
    (type) => {
      const raw = first(type);
      value(raw)["resource"] = "TRON_POWER";
      expect(bytesToHex(tronRawDataFromJson(raw, false))).toBe(oracleHex(raw, false));
      const vt = toVisible(raw);
      expect(bytesToHex(tronRawDataFromJson(vt, true))).toBe(oracleHex(vt, true));
    },
  );

  it("a TRON_POWER DelegateResourceContract encodes exactly like txJsonToPb", () => {
    const raw = first("DelegateResourceContract");
    value(raw)["resource"] = "TRON_POWER";
    value(raw)["lock"] = true;
    expect(bytesToHex(tronRawDataFromJson(raw, false))).toBe(oracleHex(raw, false));
  });

  it("refuses a non-boolean DelegateResourceContract.lock", () => {
    for (const lock of ["true", 5, ""]) {
      const raw = first("DelegateResourceContract");
      value(raw)["lock"] = lock;
      refuse(raw, false, /lock is not a boolean/);
    }
  });

  it("refuses AccountPermissionUpdateContract", () => {
    const apu = mainnetVectors.transactions.filter(
      (t) => t.type === "AccountPermissionUpdateContract",
    );
    expect(apu.length).toBeGreaterThan(0);
    for (const t of apu) {
      expect(() => tronRawDataFromJson(t.raw_data, false)).toThrow(ChainError);
    }
  });
});

const first = (type: string): RawData => {
  const t = vectors.find((v) => v.type === type);
  if (t === undefined) {
    throw new Error(`missing mainnet vector for ${type}`);
  }
  return clone(t.raw_data);
};

const value = (raw: RawData): RawData => {
  const contracts = raw["contract"] as Array<Record<string, unknown>>;
  return ((contracts[0]?.["parameter"] as Record<string, unknown>)?.["value"] ?? {}) as RawData;
};

const refuse = (raw: RawData, visible: boolean, match: RegExp | string): void => {
  try {
    tronRawDataFromJson(raw, visible);
  } catch (error) {
    expect(error).toBeInstanceOf(ChainError);
    expect((error as ChainError).code).toBe("invalid-request");
    expect((error as ChainError).message).toMatch(match);
    return;
  }
  throw new Error(`expected ChainError (${String(match)})`);
};

describe("tronRawDataFromJson shape rules", () => {
  it("unknown keys refuse at every level", () => {
    let raw = first("TransferContract");
    raw["bogus"] = 1;
    refuse(raw, false, /raw_data\.bogus/);

    raw = first("TransferContract");
    (raw["contract"] as RawData[])[0]!["bogus"] = 1;
    refuse(raw, false, /contract\.bogus/);

    raw = first("TransferContract");
    ((raw["contract"] as RawData[])[0]!["parameter"] as RawData)["bogus"] = 1;
    refuse(raw, false, /parameter\.bogus/);

    raw = first("TransferContract");
    value(raw)["bogus"] = 1;
    refuse(raw, false, /TransferContract\.bogus/);

    raw = first("VoteWitnessContract");
    (value(raw)["votes"] as RawData[])[0]!["bogus"] = 1;
    refuse(raw, false, /votes\[\]\.bogus/);
  });

  it("requires a 2-byte ref_block_bytes and an 8-byte ref_block_hash", () => {
    let raw = first("TransferContract");
    raw["ref_block_bytes"] = "aa";
    refuse(raw, false, /ref_block_bytes/);
    raw = first("TransferContract");
    raw["ref_block_hash"] = "aabb";
    refuse(raw, false, /ref_block_hash/);
  });

  it("requires exactly one contract", () => {
    const raw = first("TransferContract");
    raw["contract"] = [];
    refuse(raw, false, /exactly one/);
    const two = first("TransferContract");
    const [c] = two["contract"] as RawData[];
    two["contract"] = [c, c];
    refuse(two, false, /exactly one/);
  });

  it("requires type_url to name the declared type", () => {
    const raw = first("TransferContract");
    ((raw["contract"] as RawData[])[0]!["parameter"] as RawData)["type_url"] =
      "type.googleapis.com/protocol.TransferAssetContract";
    refuse(raw, false, /type_url/);
  });

  it("refuses an unsupported type and a typeless contract", () => {
    const raw = first("TransferContract");
    (raw["contract"] as RawData[])[0]!["type"] = "AccountCreateContract";
    refuse(raw, false, /not supported/);
    const raw2 = first("TransferContract");
    (raw2["contract"] as RawData[])[0]!["type"] = 7;
    refuse(raw2, false, /contract\.type/);
  });

  it("rejects non-canonical integers", () => {
    let raw = first("TransferContract");
    value(raw)["amount"] = "10abc";
    refuse(raw, false, /amount/);
    raw = first("TransferContract");
    value(raw)["amount"] = -1;
    refuse(raw, false, /amount/);
    raw = first("TransferContract");
    value(raw)["amount"] = 1.5;
    refuse(raw, false, /amount/);
    raw = first("TransferContract");
    value(raw)["amount"] = "9223372036854775808";
    refuse(raw, false, /amount/);
  });

  it("requires the visible mode's address form", () => {
    const hexRaw = first("TransferContract");
    refuse(hexRaw, true, /base58/);
    const b58Raw = toVisible(first("TransferContract"));
    refuse(b58Raw, false, /41-hex/);
    const raw = first("TransferContract");
    value(raw)["to_address"] = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
    refuse(raw, false, /41-hex/);
  });

  it("refuses a missing or zero expiration", () => {
    const raw = first("TransferContract");
    delete raw["expiration"];
    refuse(raw, false, /expiration/);
    const zero = first("TransferContract");
    zero["expiration"] = 0;
    refuse(zero, false, /expiration/);
  });

  it("refuses resource enum values outside the names", () => {
    const raw = first("FreezeBalanceV2Contract");
    value(raw)["resource"] = 1;
    refuse(raw, false, /resource/);
    const raw2 = first("FreezeBalanceV2Contract");
    value(raw2)["resource"] = "STUFF";
    refuse(raw2, false, /resource/);
  });

  it("accepts JSON text, refusing duplicate keys and trailing text", () => {
    const raw = first("TransferContract");
    const text = JSON.stringify(raw);
    expect(bytesToHex(tronRawDataFromJson(text, false)).length).toBeGreaterThan(0);
    expect(() =>
      tronRawDataFromJson(text.replace('"timestamp"', '"x":1,"timestamp"'), false),
    ).toThrow(ChainError);
    expect(() => tronRawDataFromJson(`${text} null`, false)).toThrow(ChainError);
  });

  it("TriggerSmartContract refuses a parameter without function_selector", () => {
    const raw = first("TriggerSmartContract");
    delete value(raw)["data"];
    value(raw)["parameter"] = "aabb";
    refuse(raw, false, /function_selector/);
    const both = first("TriggerSmartContract");
    value(both)["function_selector"] = "transfer(address,uint256)";
    refuse(both, false, /cannot combine/);
  });
});

/**
 * Single-field mutations where our refusal is intentional strictness over txCheck, keyed by
 * mutation name. Everything not listed must agree with txCheck.
 */
const STRICTER = new Set([
  /* txCheck ignores unknown keys and a wrong/absent type_url — we refuse them all. */
  "value:unknown-key",
  "contract:unknown-key",
  "parameter:unknown-key",
  "raw:unknown-key",
  "contract:bad-type_url",
  "contract:missing-type_url",
  "header:extra-key",
  /* txCheck coerces a truthy non-boolean lock to 1 — we refuse it outright. */
  "value:lock-string",
]);

type Mutation = { readonly name: string; readonly apply: (raw: RawData) => void };

/** One mutation per supported shape — the differential runs each on every vector type. */
const mutations: ReadonlyArray<Mutation> = [
  {
    name: "value:unknown-key",
    apply: (raw) => {
      value(raw)["zzz_unknown"] = "1";
    },
  },
  {
    name: "contract:unknown-key",
    apply: (raw) => {
      (raw["contract"] as RawData[])[0]!["zzz_unknown"] = 1;
    },
  },
  {
    name: "parameter:unknown-key",
    apply: (raw) => {
      ((raw["contract"] as RawData[])[0]!["parameter"] as RawData)["zzz_unknown"] = 1;
    },
  },
  {
    name: "raw:unknown-key",
    apply: (raw) => {
      raw["zzz_unknown"] = 1;
    },
  },
  {
    name: "value:delete-owner_address",
    apply: (raw) => {
      delete value(raw)["owner_address"];
    },
  },
  {
    name: "value:delete-required",
    apply: (raw) => {
      const v = value(raw);
      Reflect.deleteProperty(v, Object.keys(v).find((k) => k !== "owner_address") ?? "");
    },
  },
  {
    name: "contract:delete-type",
    apply: (raw) => {
      delete (raw["contract"] as RawData[])[0]!["type"];
    },
  },
  {
    name: "contract:type-number",
    apply: (raw) => {
      (raw["contract"] as RawData[])[0]!["type"] = 1;
    },
  },
  {
    name: "contract:mismatch-type",
    apply: (raw) => {
      (raw["contract"] as RawData[])[0]!["type"] = "TransferAssetContract";
    },
  },
  {
    name: "value:noncanonical-amount",
    apply: (raw) => {
      const v = value(raw);
      for (const key of ["amount", "frozen_balance", "balance", "call_value", "vote_count"]) {
        if (v[key] !== undefined && !Array.isArray(v[key])) {
          v[key] = `${String(v[key])}xyz`;
          return;
        }
      }
      delete v["owner_address"];
    },
  },
  {
    name: "value:float-amount",
    apply: (raw) => {
      const v = value(raw);
      for (const key of ["amount", "frozen_balance", "balance", "call_value", "vote_count"]) {
        if (typeof v[key] === "number") {
          v[key] += 0.5;
          return;
        }
      }
      delete v["owner_address"];
    },
  },
  {
    name: "value:resource-tron-power",
    apply: (raw) => {
      const v = value(raw);
      if ("resource" in v) {
        v["resource"] = "TRON_POWER";
      }
    },
  },
  {
    name: "value:lock-string",
    apply: (raw) => {
      const v = value(raw);
      if ("lock" in v) {
        v["lock"] = "true";
      }
    },
  },
  {
    name: "raw:delete-ref_block_bytes",
    apply: (raw) => {
      delete raw["ref_block_bytes"];
    },
  },
  {
    name: "raw:short-ref_block_bytes",
    apply: (raw) => {
      raw["ref_block_bytes"] = "aa";
    },
  },
  {
    name: "raw:short-ref_block_hash",
    apply: (raw) => {
      raw["ref_block_hash"] = "aabbcc";
    },
  },
  {
    name: "raw:missing-expiration",
    apply: (raw) => {
      delete raw["expiration"];
    },
  },
  {
    name: "value:numeric-resource",
    apply: (raw) => {
      const v = value(raw);
      if (v["resource"] === undefined) {
        delete v["owner_address"];
      } else {
        v["resource"] = 1;
      }
    },
  },
  {
    name: "value:bad-resource",
    apply: (raw) => {
      const v = value(raw);
      if (v["resource"] === undefined) {
        delete v["owner_address"];
      } else {
        v["resource"] = "STUFF";
      }
    },
  },
  {
    name: "contract:bad-type_url",
    apply: (raw) => {
      ((raw["contract"] as RawData[])[0]!["parameter"] as RawData)["type_url"] =
        "type.googleapis.com/protocol.Bogus";
    },
  },
  {
    name: "contract:missing-type_url",
    apply: (raw) => {
      delete ((raw["contract"] as RawData[])[0]!["parameter"] as RawData)["type_url"];
    },
  },
  {
    name: "value:trigger-parameter-bare",
    apply: (raw) => {
      const v = value(raw);
      if (v["data"] === undefined) {
        delete v["owner_address"];
        return;
      }
      delete v["data"];
      v["parameter"] = "aabb";
    },
  },
  {
    name: "value:trigger-data-with-selector",
    apply: (raw) => {
      const v = value(raw);
      if (v["data"] === undefined) {
        delete v["owner_address"];
        return;
      }
      v["function_selector"] = "transfer(address,uint256)";
    },
  },
  {
    name: "header:extra-key",
    apply: (raw) => {
      raw["signatures"] = [];
    },
  },
];

const txCheckSafe = (tx: unknown): boolean => {
  try {
    return txCheck(tx);
  } catch {
    return false;
  }
};

const oursOk = (raw: RawData, visible: boolean, hex: string): boolean => {
  try {
    return bytesToHex(tronRawDataFromJson(raw, visible)) === hex;
  } catch {
    return false;
  }
};

describe("txCheck differential", () => {
  /* Sanity: tronweb agrees the unmutated vectors are self-consistent. */
  it.each(vectors)("$type $txid: txCheck true on the unmutated JSON", (t) => {
    const tx = { txID: t.txid, raw_data: t.raw_data, raw_data_hex: t.raw_data_hex, visible: false };
    expect(txCheckSafe(tx)).toBe(true);
    expect(oursOk(t.raw_data, false, t.raw_data_hex)).toBe(true);
    const vt = {
      txID: t.txid,
      raw_data: toVisible(t.raw_data),
      raw_data_hex: t.raw_data_hex,
      visible: true,
    };
    expect(txCheckSafe(vt)).toBe(true);
    expect(oursOk(vt.raw_data, true, t.raw_data_hex)).toBe(true);
  });

  const classify = (
    t: (typeof vectors)[number],
    m: Mutation,
    visible: boolean,
  ): { readonly kind: "agree" | "stricter" | "disagree"; readonly tag: string } => {
    const raw = visible ? toVisible(t.raw_data) : clone(t.raw_data);
    m.apply(raw);
    const tx = { txID: t.txid, raw_data: raw, raw_data_hex: t.raw_data_hex, visible };
    const theirs = txCheckSafe(tx);
    const ours = oursOk(raw, visible, t.raw_data_hex);
    const tag = `${t.type}/${t.txid.slice(0, 8)}/${m.name}/visible=${visible}`;
    if (ours === theirs) {
      return { kind: "agree", tag };
    }
    return !ours && theirs && STRICTER.has(m.name)
      ? { kind: "stricter", tag }
      : { kind: "disagree", tag: `${tag} ours=${ours} theirs=${theirs}` };
  };

  it(
    "single-field mutations agree with txCheck, stricter cases documented",
    { timeout: 30_000 },
    () => {
      const results = vectors.flatMap((t) =>
        mutations.flatMap((m) =>
          ([false, true] as const).map((visible) => classify(t, m, visible)),
        ),
      );
      const disagreements = results.filter((r) => r.kind === "disagree").map((r) => r.tag);
      const stricter = results.filter((r) => r.kind === "stricter").map((r) => r.tag);
      expect(disagreements).toStrictEqual([]);
      /* every mutation must exercise at least one vector; the strict-set names must all be used */
      for (const name of STRICTER) {
        expect(stricter.some((s) => s.includes(`/${name}/`))).toBe(true);
      }
    },
  );
});
