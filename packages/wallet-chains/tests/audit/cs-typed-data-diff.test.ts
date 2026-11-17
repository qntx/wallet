/**
 * Audit A1 / chains-signing: differential EIP-712 hashing — every adversarial document that
 * `parseTypedData` accepts (so the kernel signs it) is hashed by ox (the signer) and by
 * @metamask/eth-sig-util v4 (the ecosystem verifier reference). A mismatch means the kernel signs a
 * digest that dApps and contracts built against MetaMask semantics compute differently.
 */
import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as TypedData from "ox/TypedData";
import { describe, expect, it } from "vite-plus/test";

import { parseTypedData } from "../../src/evm/typed-data.ts";

const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
];
const doc = (types: Record<string, unknown>, primaryType: string, message: unknown) => ({
  types: { EIP712Domain: DOMAIN_TYPE, ...types },
  primaryType,
  domain: { name: "D", chainId: 1 },
  message,
});

const CASES: Record<string, ReturnType<typeof doc>> = {
  "odd-length bytes": doc({ M: [{ name: "b", type: "bytes" }] }, "M", { b: "0x123" }),
  "bytes as non-hex string": doc({ M: [{ name: "b", type: "bytes" }] }, "M", { b: "hello" }),
  "string as number": doc({ M: [{ name: "s", type: "string" }] }, "M", { s: 5 }),
  "uint as decimal string with leading zeros": doc({ M: [{ name: "u", type: "uint256" }] }, "M", {
    u: "0010",
  }),
  "uint as hex string": doc({ M: [{ name: "u", type: "uint256" }] }, "M", { u: "0x10" }),
  "int negative": doc({ M: [{ name: "i", type: "int8" }] }, "M", { i: -1 }),
  "bool as string": doc({ M: [{ name: "x", type: "bool" }] }, "M", { x: "false" }),
  "bytes32 short": doc({ M: [{ name: "h", type: "bytes32" }] }, "M", { h: "0x01" }),
  "missing primitive field": doc({ M: [{ name: "u", type: "uint256" }, { name: "s", type: "string" }] }, "M", { u: 1 }),
  "nested fixed array of arrays": doc({ M: [{ name: "a", type: "uint8[2][]" }] }, "M", {
    a: [[1, 2], [3, 4]],
  }),
  "recursive struct": doc(
    { Node: [{ name: "v", type: "uint256" }, { name: "next", type: "Node[]" }] },
    "Node",
    { v: 1, next: [{ v: 2, next: [] }] },
  ),
  "struct named like an array": doc(
    { M: [{ name: "a", type: "S[]" }], "S[]": [{ name: "x", type: "uint256" }], S: [{ name: "x", type: "uint256" }] },
    "M",
    { a: [{ x: 1 }] },
  ),
  "unreferenced extra type": doc(
    { M: [{ name: "x", type: "uint256" }], Z: [{ name: "y", type: "uint256" }] },
    "M",
    { x: 1 },
  ),
  "field name __proto__": doc({ M: [{ name: "__proto__", type: "uint256" }] }, "M", JSON.parse('{"__proto__": 5}')),
  "type name with dot": doc({ "M.N": [{ name: "x", type: "uint256" }] }, "M.N", { x: 1 }),
  "address lowercase": doc({ M: [{ name: "a", type: "address" }] }, "M", {
    a: "0x" + "ab".repeat(20),
  }),
};

const hashOx = (d: unknown): string => TypedData.getSignPayload(d as never);
const hashMm = (d: unknown): string =>
  `0x${bytesToHex(TypedDataUtils.eip712Hash(d as never, SignTypedDataVersion.V4))}`;
const attempt = (f: () => string): string => {
  try {
    return f();
  } catch (e) {
    return `throws: ${(e as Error).message.split("\n")[0]?.slice(0, 80)}`;
  }
};

describe("CS-712: ox vs eth-sig-util on documents parseTypedData accepts", () => {
  const rows = Object.entries(CASES).map(([name, d]) => {
    const json = JSON.stringify(d);
    let accepted = true;
    try {
      parseTypedData(json);
    } catch {
      accepted = false;
    }
    const parsed = JSON.parse(json);
    return { name, accepted, ox: attempt(() => hashOx(parsed)), mm: attempt(() => hashMm(parsed)) };
  });
  it("records the table", () => {
    for (const r of rows) process.stdout.write(`ROW ${r.name} | accepted=${r.accepted} | same=${r.ox === r.mm} | ox=${r.ox.slice(0,70)} | mm=${r.mm.slice(0,70)}\n`);
    const row = (name: string) => rows.find((r) => r.name === name);
    // Accepted by parseTypedData (so prompted and verified), then refused by the signer itself.
    for (const name of ["bytes as non-hex string", "bool as string", "bytes32 short"]) {
      expect(row(name)?.accepted).toBe(true);
      expect(row(name)?.ox.startsWith("throws")).toBe(true);
    }
    // Accepted and signed, but MetaMask's reference refuses or hashes differently.
    expect(row("missing primitive field")?.accepted).toBe(true);
    expect(row("missing primitive field")?.ox.startsWith("0x")).toBe(true);
    expect(row("missing primitive field")?.mm.startsWith("throws")).toBe(true);
    expect(row("string as number")?.accepted).toBe(true);
    expect(row("string as number")?.ox).not.toBe(row("string as number")?.mm);
    // Everything else agrees byte for byte.
    for (const name of ["odd-length bytes", "recursive struct", "nested fixed array of arrays", "field name __proto__", "type name with dot"]) {
      expect(row(name)?.ox).toBe(row(name)?.mm);
    }
  });
});
