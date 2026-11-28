import { readFileSync } from "node:fs";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import {
  parseTypedData,
  planEvm,
  typedDataHashes,
  typedDataSchemaHash,
  typedDataLeaf,
} from "../src/evm/index.ts";
import type { AccountRef } from "../src/index.ts";

/**
 * `typedDataHashes` must produce exactly the EIP-712 digests the vectors and plans already commit
 * to: keccak256(0x1901 | domainSeparator | messageHash) recombined per document and compared
 * against each file's own record — the signing-plan task digest, the signed signature in evm.json
 * (verified over our digest), and the plan task digest for the signing-classes documents.
 */

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, `../../../vectors/chains/${name}`), "utf8"));

const digestOf = (typedData: string): Uint8Array => {
  const { domain, message } = typedDataHashes(parseTypedData(typedData).json);
  return keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...(message ?? new Uint8Array(0))]));
};

type PlansVector = {
  cases: Array<{
    name: string;
    request: { kind: string; typedData?: string };
    stages: ReadonlyArray<ReadonlyArray<{ digest?: string }>>;
  }>;
};
const plans = load("signing-plans.json") as PlansVector;
const planCases = plans.cases.flatMap((c) =>
  c.request.kind === "evm.typed-data" && c.request.typedData !== undefined
    ? [
        {
          name: c.name,
          typedData: c.request.typedData,
          digest: c.stages[0]?.[0]?.digest ?? "",
        },
      ]
    : [],
);

type ClassesVector = {
  cases: Array<{
    name: string;
    request: { kind: string; network: string; account: AccountRef; typedData?: unknown };
  }>;
};
const classes = load("signing-classes.json") as ClassesVector;
const KEY = {
  path: [0x80_00_00_2c, 0x80_00_00_3c, 0x80_00_00_00, 0, 0],
  publicKey: new Uint8Array(33),
};
const classCases = classes.cases.flatMap((c) => {
  if (c.request.kind !== "evm.typed-data" || c.request.typedData === undefined) {
    return [];
  }
  const typedData = JSON.stringify(c.request.typedData);
  const request: Parameters<typeof planEvm>[0] = {
    kind: "evm.typed-data",
    network: c.request.network,
    account: c.request.account,
    typedData,
  };
  const plan = planEvm(request, KEY);
  const [task] = plan.tasks;
  return [
    {
      name: c.name,
      typedData,
      // The plan's task digest — the digest signing-classes records.
      digest: task !== undefined && "digest" in task ? task.digest : new Uint8Array(0),
    },
  ];
});

const evm = load("evm.json") as {
  typedData: string;
  privateKey: string;
  expected: { typedData: string };
};

describe("typedDataHashes", () => {
  it.each(planCases)("signing-plans %s recomposes to the recorded task digest", (c) => {
    expect(digestOf(c.typedData)).toStrictEqual(hexToBytes(c.digest));
  });

  it("the evm.json signature verifies over the recomposed digest", () => {
    const digest = digestOf(evm.typedData);
    const signature = hexToBytes(evm.expected.typedData.replace(/^0x/, ""));
    const publicKey = secp256k1.getPublicKey(hexToBytes(evm.privateKey.replace(/^0x/, "")), true);
    expect(secp256k1.verify(signature.subarray(0, 64), digest, publicKey, { prehash: false })).toBe(
      true,
    );
  });

  it.each(classCases)("signing-classes %s recomposes to the plan task digest", (c) => {
    expect(digestOf(c.typedData)).toStrictEqual(c.digest);
  });

  it("omits the message hash when the primary type is EIP712Domain", () => {
    const doc = JSON.stringify({
      types: { EIP712Domain: [{ name: "name", type: "string" }] },
      primaryType: "EIP712Domain",
      domain: { name: "D" },
      message: {},
    });
    const { domain, message } = typedDataHashes(parseTypedData(doc).json);
    expect(domain).toHaveLength(32);
    expect(message).toBeUndefined();
  });
});

describe("typedDataSchemaHash", () => {
  it.each<[string, Record<string, ReadonlyArray<{ name: string; type: string }>>, string]>([
    ["an empty schema", {}, "5cdd15a873608087be07a41b7f1a04e96d3a66fe7a9b0faac71f8d05"],
    [
      "the EIP-712 Mail example",
      {
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      "7e4e49a17c15e38c6e3c8c4ffcaf7e018065ab3ede693abc32e8a11a",
    ],
    [
      "non-ASCII type and field names, hashed as UTF-8",
      {
        "Zeta é": [{ name: "a b", type: "string" }],
        "Alpha 😀": [{ name: "x", type: "uint256" }],
      },
      "9f5293184d8ae84120a496d192a69ef36848fe63fec3eb1a781e3ef5",
    ],
  ])("returns the known SHA-224 digest for %s", (_name, schema, expected) => {
    expect(typedDataSchemaHash(schema)).toBe(expected);
  });

  it("is order-independent over type names", () => {
    const a = {
      Mail: [{ name: "x", type: "string" }],
      EIP712Domain: [{ name: "y", type: "uint256" }],
    };
    const b = {
      EIP712Domain: [{ name: "y", type: "uint256" }],
      Mail: [{ name: "x", type: "string" }],
    };
    expect(typedDataSchemaHash(a)).toBe(typedDataSchemaHash(b));
  });
});

describe("typedDataLeaf", () => {
  const { json } = parseTypedData(
    JSON.stringify({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Details: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
        ],
        PermitSingle: [
          { name: "details", type: "Details" },
          { name: "spender", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "PermitSingle",
      domain: {
        name: "x",
        chainId: 1,
        verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      },
      message: {
        details: { token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: "7" },
        spender: "0x2222222222222222222222222222222222222222",
        deadline: "1",
      },
    }),
  );

  it("resolves nested and root leaves to type and message value", () => {
    expect(typedDataLeaf(json, "details.token")).toStrictEqual({
      type: "address",
      value: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    });
    expect(typedDataLeaf(json, "deadline")).toStrictEqual({ type: "uint256", value: "1" });
  });

  it("refuses unknown fields, struct leaves and array dimensions", () => {
    expect(typedDataLeaf(json, "missing")).toBeUndefined();
    expect(typedDataLeaf(json, "details.missing")).toBeUndefined();
    expect(typedDataLeaf(json, "details")).toBeUndefined();
    expect(typedDataLeaf(json, "spender.extra")).toBeUndefined();
    const arrayDoc = parseTypedData(
      JSON.stringify({
        types: {
          EIP712Domain: [{ name: "chainId", type: "uint256" }],
          Batch: [{ name: "values", type: "uint256[]" }],
        },
        primaryType: "Batch",
        domain: { chainId: 1 },
        message: { values: ["1"] },
      }),
    ).json;
    expect(typedDataLeaf(arrayDoc, "values")).toBeUndefined();
  });
});
