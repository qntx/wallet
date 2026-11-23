import { readFileSync } from "node:fs";
import { join } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { parseTypedData, planEvm, typedDataHashes } from "../src/evm/index.ts";
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
