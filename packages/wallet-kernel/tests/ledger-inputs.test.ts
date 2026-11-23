/**
 * Host-side input validation for the app clients: malformed transactions, out-of-range EIP-712
 * values, bad paths and oversized messages are rejected with LedgerError("invalid-input") before
 * any APDU leaves the host — a fake exchange that records nothing must stay silent.
 */

import { describe, expect, it } from "vite-plus/test";

import type { TypedDataInput } from "@qntx/wallet-chains/evm";

import type { Exchange } from "../src/modules/ledger/protocol/apdu.ts";
import { LedgerError } from "../src/modules/ledger/protocol/errors.ts";
import {
  ethSignPersonalMessage,
  ethSignTransaction,
  ethSignTypedData,
} from "../src/modules/ledger/protocol/ethereum.ts";
import { solanaSignTransaction } from "../src/modules/ledger/protocol/solana.ts";
import { tronSignTypedDataHash } from "../src/modules/ledger/protocol/tron.ts";

const PATH = [0x80_00_00_2c, 0x80_00_00_3c, 0x80_00_00_00, 0, 0];

/** An exchange that fails if it is ever called — validation must happen first. */
const silent: Exchange = async () => Promise.reject(new Error("exchange must not be called"));

const invalid = async (job: Promise<unknown>): Promise<void> => {
  try {
    await job;
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe("invalid-input");
    return;
  }
  throw new Error("expected invalid-input");
};

const TYPED: TypedDataInput = {
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [
      { name: "who", type: "address" },
      { name: "note", type: "string" },
    ],
  },
  primaryType: "Mail",
  domain: { name: "x" },
  message: { who: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC", note: "hi" },
};

const withField = (field: { name: string; type: string }, value: unknown): TypedDataInput => ({
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [field],
  },
  primaryType: "Mail",
  domain: { name: "x" },
  message: { [field.name]: value },
});

describe("ledger input validation", () => {
  it("rejects transactions that are neither typed nor a legacy RLP list", async () => {
    expect.hasAssertions();
    await invalid(ethSignTransaction(silent, PATH, new Uint8Array(0)));
    await invalid(ethSignTransaction(silent, PATH, Uint8Array.of(0x80)));
    await invalid(ethSignTransaction(silent, PATH, Uint8Array.of(0xbf)));
  });

  it("rejects oversized legacy transactions whose RLP is malformed", async () => {
    expect.hasAssertions();
    // f9 0100 claims a 256-byte list payload but only 232 bytes follow — the walker only runs
    // for payloads that need chunking, so the transaction must be > 234 bytes
    const badLength = Uint8Array.from([0xf9, 0x01, 0x00, ...new Uint8Array(232)]);
    await invalid(ethSignTransaction(silent, PATH, badLength));
    // well-formed list wrapper whose last item's payload overruns the buffer
    const items = new Uint8Array(300).fill(0x80);
    items[298] = 0xb8; // string with one length byte
    items[299] = 0xff; // claiming 255 payload bytes, none present
    const badItem = Uint8Array.from([0xf9, 0x01, 0x2c, ...items]);
    await invalid(ethSignTransaction(silent, PATH, badItem));
    // a legacy list shorter than three top-level items has no v,r,s tail
    const oneItem = Uint8Array.from([0xf9, 0x01, 0x2c, 0xb9, 0x01, 0x29, ...new Uint8Array(297)]);
    await invalid(ethSignTransaction(silent, PATH, oneItem));
  });

  it("rejects malformed EIP-712 type declarations", async () => {
    expect.hasAssertions();
    const missingPrimary: TypedDataInput = { ...TYPED, primaryType: "NoSuchType" };
    await invalid(ethSignTypedData(silent, PATH, missingPrimary));
    const noDomain: TypedDataInput = {
      ...TYPED,
      types: { Mail: [{ name: "note", type: "string" }] },
    };
    await invalid(ethSignTypedData(silent, PATH, noDomain));
    await Promise.all(
      ["uint7", "uint264", "bytes0", "bytes33", "uint256["].map(async (type) =>
        invalid(ethSignTypedData(silent, PATH, withField({ name: "f", type }, 1))),
      ),
    );
  });

  it("rejects EIP-712 values outside their declared ranges", async () => {
    expect.hasAssertions();
    const cases: Array<[string, unknown]> = [
      ["uint8", 300],
      ["uint8", -1],
      ["uint8", "not-a-number"],
      ["uint8", 1.5],
      ["int8", 200],
      ["int8", -200],
      ["address", "0x1234"],
      ["address", "not-hex"],
      ["bool", "maybe"],
      ["bool", "true"],
      ["bool", 1],
      ["bytes2", "0xaabbcc"],
      ["bytes2", "0xaa"],
      ["bytes", "not-hex"],
    ];
    await Promise.all(
      cases.map(async ([type, value]) =>
        invalid(ethSignTypedData(silent, PATH, withField({ name: "f", type }, value))),
      ),
    );
  });

  it("rejects EIP-712 fields with no value", async () => {
    expect.hasAssertions();
    // a declared field absent from the message must not fall back to a zero value
    const missing: TypedDataInput = {
      ...TYPED,
      message: { who: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
    };
    await invalid(ethSignTypedData(silent, PATH, missing));
    await invalid(
      ethSignTypedData(silent, PATH, withField({ name: "f", type: "uint8" }, undefined)),
    );
  });

  it("rejects malformed EIP-712 containers", async () => {
    expect.hasAssertions();
    const arrayOf = (type: string, value: unknown): TypedDataInput =>
      withField({ name: "f", type }, value);
    await invalid(ethSignTypedData(silent, PATH, arrayOf("uint256[]", "not-an-array")));
    await invalid(ethSignTypedData(silent, PATH, arrayOf("uint256[2]", [1, 2, 3])));
    await invalid(
      ethSignTypedData(
        silent,
        PATH,
        arrayOf(
          "uint256[]",
          Array.from({ length: 256 }, () => 0),
        ),
      ),
    );
    await invalid(ethSignTypedData(silent, PATH, withField({ name: "f", type: "Missing" }, {})));
    await invalid(
      ethSignTypedData(silent, PATH, withField({ name: "f", type: "Mail" }, "not-an-object")),
    );
  });

  it("rejects bad solana paths and oversized messages", async () => {
    expect.hasAssertions();
    const message = new Uint8Array(100);
    await invalid(solanaSignTransaction(silent, [0x80_00_00_2c, 0x80_00_01_f5, 0], message));
    await invalid(solanaSignTransaction(silent, PATH, new Uint8Array(0)));
    await invalid(solanaSignTransaction(silent, PATH, new Uint8Array(1233)));
  });

  it("rejects wrong-length TIP-712 hashes and too-deep paths", async () => {
    expect.hasAssertions();
    const hash = new Uint8Array(32);
    await invalid(tronSignTypedDataHash(silent, PATH, new Uint8Array(31), hash));
    await invalid(tronSignTypedDataHash(silent, PATH, hash, new Uint8Array(33)));
    await invalid(
      ethSignPersonalMessage(
        silent,
        Array.from({ length: 11 }, () => 0),
        new Uint8Array(1),
      ),
    );
  });
});
