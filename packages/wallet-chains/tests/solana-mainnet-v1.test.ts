/**
 * Solana mainnet v1 fixtures: real SIMD-0385 transactions re-fetched from the public RPC by
 * scripts/vectors/solana-mainnet-v1.ts — every signature verified against the fetched wire at
 * generation time. Here each wire must round-trip through kit byte-for-byte, parse into the same
 * model kit's decoder produces, re-apply its own signatures identically, and decode to its pinned
 * class — a `blind` reason, or `undefined` with the count of programAuthority entries — so a parser
 * or decoder change that silently re-classes a real v1 transaction fails here.
 */
// oxlint-disable vitest/no-conditional-in-test -- per-fixture narrowing guards and oracle-field iteration are inherent to the fixture matrix
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { BlindReason } from "../src/index.ts";
import { decodeSolana } from "../src/solana/index.ts";
import { parseCompiledMessage } from "../src/solana/message.ts";
import { addSolanaSignature, decodeSolanaTransaction } from "../src/solana/transaction.ts";
import { verifySolanaSignature } from "../src/solana/verify.ts";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;

type Fixture = {
  readonly label: string;
  readonly program: string;
  readonly signature: string;
  readonly signer: string;
  readonly wire: string;
};

const fixtures = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/solana-mainnet-v1.json"),
    "utf8",
  ),
) as Fixture[];

/* signature prefix → [expected blind (undefined = described), programAuthority entry count] */
const expected: Record<string, readonly [BlindReason | undefined, number]> = {
  "3X5euhSmPCxS": ["core-instruction", 0], // Jupiter v6
  "3wgXzK72FxzX": [undefined, 0], // Jupiter v6
  "62kKB7BgofdN": [undefined, 0], // Jupiter v6
  "5f1Dbr21TR3F": [undefined, 1], // Jupiter v6
  "53Nq8oaVJUcv": [undefined, 0], // Jupiter v6
  "2Wnu3P1gfqCh": ["program-authority", 1], // Jupiter v6
  "2oF5vevN8b5g": ["program-authority", 1], // Jupiter v6
  "3sVTumCTiqPm": [undefined, 0], // Jupiter v6
  "2RNo96BfYs5Q": ["program-authority", 3], // Kamino Lend
  "2jJuqFuVViAy": ["program-authority", 3], // Kamino Lend
  "4MjTrBc8fdkk": ["program-authority", 3], // Kamino Lend
  "4q15K1b8EBDa": ["program-authority", 3], // Kamino Lend
  rmVsH2VDYgUW: ["program-authority", 3], // Kamino Lend
  J2DjHQz8jJwR: [undefined, 0], // Kamino Lend
  "5rU6C5WKuRAg": ["program-authority", 2], // Kamino Lend
  j5cFikxdptMJ: ["program-authority", 2], // Kamino Lend
  "4zzuLeMzkWcq": [undefined, 1], // Meteora DAMM v2
  "55gF1T1Hz7ju": [undefined, 1], // Meteora DAMM v2
  bPqejmqAVAq8: [undefined, 1], // Meteora DAMM v2
  "2X2xZX1H312k": ["core-instruction", 2], // Meteora DLMM
  "5wCdMtdgkyzK": ["core-instruction", 2], // Meteora DLMM
  "51vNNCZ67Eju": ["program-authority", 1], // Meteora DLMM
  "4Y3LKDtTgPt2": [undefined, 1], // Meteora DLMM
  "55y5mJhkmXUQ": [undefined, 1], // Meteora DLMM
  "49j71Ahiy7Qv": [undefined, 2], // Meteora DLMM
  "5a9fTyMeBs6X": [undefined, 1], // Meteora DLMM
  "2EEJLYSnx9CW": [undefined, 2], // Meteora DLMM
  "4HBYwnrLESMJ": [undefined, 2], // Orca Whirlpool
  "2KmXabZeZyak": ["program-authority", 1], // Orca Whirlpool
  ofUrFSwLWzie: [undefined, 1], // Orca Whirlpool
  "2Dqi3M1jtjoe": [undefined, 1], // Phoenix
  "2EGtis4RkHdX": [undefined, 1], // Phoenix
  "4y6xE2p9Ymag": ["program-authority", 1], // Pump.fun
  "28uyToH6FaQB": ["program-authority", 1], // Pump.fun
  "5DDqX6uJBLzM": [undefined, 1], // Pump.fun
  "3rfwnRSJwJ8e": [undefined, 1], // Pump.fun
  "5ScAJqkKaLHg": [undefined, 1], // Pump.fun
  hTGRasDpt9wM: [undefined, 1], // Pump.fun
  "2sWxMuUXAZdg": [undefined, 1], // Pump.fun
  "2tdbtvkTajtJ": [undefined, 1], // Pump.fun
  "2hQTkCe7vFv3": [undefined, 2], // PumpSwap
  "2iY4kvAe6hST": ["core-instruction", 2], // PumpSwap
  "2wnmUc62VdAq": ["core-instruction", 2], // PumpSwap
  Bvp3wQAPtG6R: [undefined, 1], // PumpSwap
  "5hZAA6Y6RXja": ["core-instruction", 2], // PumpSwap
  "3KkxDQX7nueY": ["program-authority", 1], // Raydium AMM v4
  "3JZ5oW7ca5RJ": [undefined, 1], // SPL TransferChecked
  "5QnyCGPuYFDN": [undefined, 1], // SPL TransferChecked
  "4xP6N63wAbcQ": [undefined, 0], // SPL TransferChecked
  "5hbuYGwLzkn2": ["program-authority", 1], // SPL TransferChecked
  "5EVqGFKArX91": ["program-authority", 1], // SPL TransferChecked
  "5fARW4U8Uji2": ["program-authority", 1], // SPL TransferChecked
  "3L8tikddUG7d": [undefined, 0], // SPL TransferChecked
  "317KNqAbQqWu": [undefined, 0], // SPL TransferChecked
  zJjDPifKFhvq: ["program-authority", 1], // Tensor Marketplace
  "5DmAHbQVwG3X": [undefined, 1], // Tensor Marketplace
  tRvy6EXT8Bph: [undefined, 1], // Tensor Marketplace
  NoP7PF3ZgHqa: [undefined, 0], // marginfi v2
  "5HTDTkMYKhQ9": [undefined, 0], // marginfi v2
  "2awcc9C23WX1": [undefined, 0], // marginfi v2
  "4pSKeFqdQTqC": [undefined, 0], // marginfi v2
  "3SZ2kfpKKErk": [undefined, 0], // marginfi v2
  fLKcrZU4GpPM: [undefined, 0], // marginfi v2
  pezvE8uqgvJv: [undefined, 0], // marginfi v2
  "2s9YdjoTJcGc": [undefined, 0], // marginfi v2
};

const want = (signature: string): readonly [BlindReason | undefined, number] =>
  expected[signature.slice(0, 12)] ?? [undefined, -1];

const authorityCount = (intent: ReturnType<typeof decodeSolana>): number =>
  intent.programAuthority?.length ?? 0;

/** A v1 wire is the message followed by `64 × wire[1]` signature bytes (no count prefix). */
const splitWire = (wire: Uint8Array) => {
  const message = wire.subarray(0, wire.length - 64 * (wire[1] ?? 0));
  return { message, signatures: wire.subarray(wire.length - 64 * (wire[1] ?? 0)) };
};

/** The config the decoded mask+values declare, in `SolanaTransactionConfig` terms. */
const kitConfig = (decoded: Record<string, unknown>) => {
  const config: Record<string, bigint | number> = {};
  const mask = typeof decoded["configMask"] === "number" ? decoded["configMask"] : 0;
  const values = Array.isArray(decoded["configValues"])
    ? (decoded["configValues"] as Array<{ kind: string; value: bigint | number }>)
    : [];
  let i = 0;
  const next = (): bigint | number => {
    const value = values[i]?.value;
    i += 1;
    return value ?? 0;
  };
  // oxlint-disable eslint/no-bitwise -- the SIMD-0385 config mask is a bit field
  if ((mask & 0b11) === 0b11) {
    config["priorityFeeLamports"] = next();
  }
  if ((mask & 0b100) !== 0) {
    config["computeUnitLimit"] = next();
  }
  if ((mask & 0b1000) !== 0) {
    config["loadedAccountsDataSizeLimit"] = next();
  }
  if ((mask & 0b10000) !== 0) {
    config["heapSize"] = next();
  }
  // oxlint-enable eslint/no-bitwise
  return config;
};

describe("solana mainnet v1 fixtures", () => {
  it("the expectation table covers every fixture", () => {
    expect(Object.keys(expected)).toHaveLength(fixtures.length);
  });

  it.each(fixtures)("$label $signature", (fixture) => {
    const wire = Uint8Array.from(Buffer.from(fixture.wire, "base64"));
    expect(wire[0]).toBe(0x81);

    // (a) kit round-trips both the envelope and the message byte-for-byte.
    const tx = getTransactionDecoder().decode(wire);
    expect(new Uint8Array(getTransactionEncoder().encode(tx))).toStrictEqual(wire);
    const { message, signatures } = splitWire(wire);
    const decoded = getCompiledTransactionMessageDecoder().decode(message);
    const dyn: Record<string, unknown> = decoded;
    expect(new Uint8Array(getCompiledTransactionMessageEncoder().encode(decoded))).toStrictEqual(
      message,
    );

    // (b) the wallet's parse agrees with kit's decoded model, field by field.
    const parsed = parseCompiledMessage(message);
    if (parsed.version !== 1) {
      throw new Error("fixture did not parse as v1");
    }
    const header = dyn["header"] as Record<string, number>;
    expect(parsed.version).toBe(dyn["version"]);
    expect(parsed.numRequiredSignatures).toBe(header["numSignerAccounts"]);
    expect(parsed.numReadonlySignerAccounts).toBe(header["numReadonlySignerAccounts"]);
    expect(parsed.numReadonlyNonSignerAccounts).toBe(header["numReadonlyNonSignerAccounts"]);
    expect(parsed.staticAccounts).toStrictEqual(dyn["staticAccounts"]);
    expect(parsed.lifetimeToken).toBe(dyn["lifetimeToken"]);
    const headers = dyn["instructionHeaders"] as Array<{
      programAccountIndex: number;
      numInstructionAccounts: number;
      numInstructionDataBytes: number;
    }>;
    const payloads = dyn["instructionPayloads"] as Array<{
      instructionAccountIndices: ArrayLike<number>;
      instructionData: Uint8Array;
    }>;
    expect(parsed.instructions).toHaveLength(headers.length);
    for (const [i, ix] of parsed.instructions.entries()) {
      expect(ix.programAddressIndex).toBe(headers[i]?.programAccountIndex);
      const kitAccounts = Uint8Array.from(payloads[i]?.instructionAccountIndices ?? []);
      expect([...ix.accountIndices]).toStrictEqual([...kitAccounts]);
      expect(ix.data).toStrictEqual(payloads[i]?.instructionData);
    }
    expect(parsed.config).toStrictEqual(kitConfig(dyn));

    // (c) a fully signed wire has no unsigned signer left, and re-applying the
    //     wallet's own signature slot is a no-op byte-for-byte.
    const { unsigned } = decodeSolanaTransaction(wire, fixture.signer);
    expect(unsigned).toStrictEqual([]);
    const signerIndex = parsed.staticAccounts.indexOf(fixture.signer);
    const own = signatures.subarray(64 * signerIndex, 64 * (signerIndex + 1));
    expect(addSolanaSignature(wire, fixture.signer, own)).toStrictEqual(wire);

    // (d) every required signature verifies over the message.
    for (let i = 0; i < parsed.numRequiredSignatures; i++) {
      const account = parsed.staticAccounts[i];
      const sig = signatures.subarray(64 * i, 64 * (i + 1));
      expect(account === undefined || !verifySolanaSignature(message, sig, account)).toBe(false);
    }

    // (e) the pinned class: a blind reason, or described with an authority count.
    const intent = decodeSolana(
      {
        kind: "solana.transaction",
        network: MAINNET,
        account: ACCOUNT,
        message,
      },
      fixture.signer,
    );
    expect(intent.blind).toBe(want(fixture.signature)[0]);
    expect(authorityCount(intent)).toBe(want(fixture.signature)[1]);
  });
});
