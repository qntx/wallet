/**
 * V1 (SIMD-0385) transaction messages: the fixed vectors in vectors/chains/solana-v1.json drive
 * parse/class/code assertions, byte-built frames cover the sanitize boundaries no kit-built message
 * reaches, and a property re-encodes every lookup-free legacy/v0 vector as v1 to prove the wallet's
 * decode rules apply unchanged — only the fee formula differs.
 */
// oxlint-disable vitest/no-conditional-in-test -- narrowing guards and boundary loops are inherent to the vector matrix
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from "@solana/transaction-messages";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "../src/index.ts";
import type { SignRequest } from "../src/index.ts";
import { decodeSolana, parseCompiledMessage } from "../src/solana/index.ts";
import type { ParsedSolanaMessage } from "../src/solana/index.ts";
import type { CompiledIx } from "../src/solana/message.ts";
import { addSolanaSignature, decodeSolanaTransaction } from "../src/solana/transaction.ts";
import { verifySolanaSignature } from "../src/solana/verify.ts";

const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;

type Valid = {
  readonly name: string;
  readonly message: string;
  readonly wire: string;
  readonly signature: string;
  readonly signer: string;
  readonly verifiability: string;
  readonly blind: string | null;
  readonly prompt: { readonly en: { title: string; description: string } };
};
type Malformed = {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly rule: string;
};
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana-v1.json"), "utf8"),
) as { cases: Valid[]; malformed: Malformed[] };

const v1Request = (message: Uint8Array): SignRequest & { kind: "solana.transaction" } => ({
  kind: "solana.transaction",
  network: MAINNET,
  account: ACCOUNT,
  message,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ChainError ? error.code : `other:${String(error)}`;
  }
  return "none";
};

const decoder = getCompiledTransactionMessageDecoder();
const encoder = getCompiledTransactionMessageEncoder();

describe("solana-v1 vectors", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "%s parses, decodes to its pinned class, and re-encodes byte-identically",
    (_name, c) => {
      const message = unhex(c.message);
      const parsed = parseCompiledMessage(message);
      expect(parsed.version).toBe(1);
      expect(parsed.lookups).toStrictEqual([]);
      expect(parsed.lifetimeToken).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      if (parsed.version !== 1) {
        throw new Error("unreachable");
      }
      expect(parsed.numRequiredSignatures).toBeGreaterThanOrEqual(1);
      // kit re-encodes the same bytes — the parse consumed the exact frame.
      const [decoded, end] = decoder.read(message, 0);
      expect(end).toBe(message.length);
      expect(new Uint8Array(encoder.encode(decoded))).toStrictEqual(message);

      const intent = decodeSolana(v1Request(message), c.signer);
      expect(intent.verifiability).toBe(c.verifiability);
      expect(intent.blind ?? null).toBe(c.blind);
      // The signature in the vector verifies over the message the signer signs.
      expect(verifySolanaSignature(message, unhex(c.signature), c.signer)).toBe(true);
      // The unsigned wire is the message followed by zeroed signature slots; the wire decoder
      // reads it back (v1-large proves the 4096 bound, not 1232, governs the wire).
      const wire = unhex(c.wire);
      expect(wire.subarray(0, message.length)).toStrictEqual(message);
      expect(wire).toHaveLength(message.length + 64 * parsed.numRequiredSignatures);
      expect(wire.subarray(message.length)).toStrictEqual(
        new Uint8Array(64 * parsed.numRequiredSignatures),
      );
      const read = decodeSolanaTransaction(wire, c.signer);
      expect(read.message).toStrictEqual(message);
      // The signature lands at message.length + 64·index — the message-first slot order.
      const index = parsed.staticAccounts.indexOf(c.signer);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(parsed.numRequiredSignatures);
      const expected = new Uint8Array(wire);
      expected.set(unhex(c.signature), message.length + 64 * index);
      expect(addSolanaSignature(wire, c.signer, unhex(c.signature))).toStrictEqual(expected);
    },
  );

  it("v1-transfer-full-config surfaces every config field", () => {
    const c = vectors.cases.find((x) => x.name === "v1-transfer-full-config");
    const parsed = parseCompiledMessage(unhex(c?.message ?? ""));
    if (parsed.version !== 1) {
      throw new Error("unreachable");
    }
    expect(parsed.config).toStrictEqual({
      priorityFeeLamports: 123456789n,
      computeUnitLimit: 200000,
      loadedAccountsDataSizeLimit: 65536,
      heapSize: 65536,
    });
  });

  it("config fields are absent exactly when their mask bits are unset", () => {
    const c = vectors.cases.find((x) => x.name === "v1-sol-transfer");
    const parsed = parseCompiledMessage(unhex(c?.message ?? ""));
    if (parsed.version !== 1) {
      throw new Error("unreachable");
    }
    expect(parsed.config).toStrictEqual({});
    expect("priorityFeeLamports" in parsed.config).toBe(false);
  });

  it("v1 fee is the signature cost plus the config priority fee — ComputeBudget is ignored", () => {
    const base = vectors.cases.find((x) => x.name === "v1-sol-transfer");
    const intent = decodeSolana(v1Request(unhex(base?.message ?? "")), base?.signer ?? "");
    expect(intent.fee?.max.amount).toBe("5000");
    const full = vectors.cases.find((x) => x.name === "v1-transfer-full-config");
    const configured = decodeSolana(v1Request(unhex(full?.message ?? "")), full?.signer ?? "");
    expect(configured.fee?.max.amount).toBe(String(5000n + 123456789n));
    /* The vector carries SetComputeUnitLimit/SetComputeUnitPrice instructions with a config
       priority fee of 10,000: v1 ignores the instructions entirely (SIMD-0385). */
    const cb = vectors.cases.find((x) => x.name === "v1-compute-budget-ignored");
    const ignored = decodeSolana(v1Request(unhex(cb?.message ?? "")), cb?.signer ?? "");
    expect(ignored.fee?.max.amount).toBe("15000");
    const sponsored = vectors.cases.find((x) => x.name === "v1-sponsored");
    const zero = decodeSolana(v1Request(unhex(sponsored?.message ?? "")), sponsored?.signer ?? "");
    expect(zero.fee?.max.amount).toBe("0");
  });

  it.each(vectors.malformed.map((m) => [m.name, m] as const))(
    "malformed %s is refused with its pinned code",
    (_name, m) => {
      expect(codeOf(() => parseCompiledMessage(unhex(m.message)))).toBe(m.code);
    },
  );

  it("a half-set priority-fee bit pair is refused before decoding, with its own message", () => {
    /* kit's decoder refuses a half pair too — but only after reading it as a decode failure;
       the wallet names the mask rule it breaks. */
    for (const name of ["v1-mask-priority-bit0-only", "v1-mask-priority-bit1-only"]) {
      const m = vectors.malformed.find((x) => x.name === name);
      expect(() => parseCompiledMessage(unhex(m?.message ?? ""))).toThrow(/priority-fee/);
    }
  });
});

/* Byte-built v1 frame (as in scripts/solana-v1-vectors.ts): 0x81 ‖ header ‖ mask(u32 LE) ‖
   lifetime ‖ numInstructions ‖ numAddresses ‖ addresses ‖ configValues ‖ headers ‖ payloads. */
const frame = (parts: {
  header?: readonly [number, number, number];
  mask?: number;
  numInstructions?: number;
  accounts: ReadonlyArray<Uint8Array>;
  configValues?: Uint8Array;
  headers?: Uint8Array;
  payloads?: Uint8Array;
}): Uint8Array => {
  const cat = (...chunks: ReadonlyArray<Uint8Array>): Uint8Array =>
    Uint8Array.from(chunks.flatMap((c) => [...c]));
  const mask = new Uint8Array(4);
  new DataView(mask.buffer).setUint32(0, parts.mask ?? 0, true);
  return cat(
    new Uint8Array([0x81]),
    new Uint8Array(parts.header ?? [1, 0, 0]),
    mask,
    new Uint8Array(32).fill(0x0d),
    new Uint8Array([parts.numInstructions ?? 0, parts.accounts.length]),
    ...parts.accounts,
    parts.configValues ?? new Uint8Array(0),
    parts.headers ?? new Uint8Array(0),
    parts.payloads ?? new Uint8Array(0),
  );
};
const distinct = (count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, i) => new Uint8Array(32).fill(i + 1));
const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

describe("v1 sanitize boundaries", () => {
  it("accepts exactly 12 required signatures", () => {
    const parsed = parseCompiledMessage(frame({ header: [12, 0, 0], accounts: distinct(12) }));
    expect(parsed.numRequiredSignatures).toBe(12);
  });

  it("accepts exactly 64 accounts and exactly 64 instructions", () => {
    expect(parseCompiledMessage(frame({ accounts: distinct(64) })).staticAccounts).toHaveLength(64);
    const headers = new Uint8Array(64 * 4);
    for (let i = 0; i < 64; i += 1) {
      headers[i * 4] = 1;
    }
    const parsed = parseCompiledMessage(
      frame({ numInstructions: 64, accounts: distinct(2), headers }),
    );
    expect(parsed.instructions).toHaveLength(64);
  });

  it("accepts the heap bounds 32768 and 262144", () => {
    for (const heap of [32768, 262144]) {
      const parsed = parseCompiledMessage(
        frame({ mask: 0b10000, accounts: distinct(1), configValues: u32le(heap) }),
      );
      if (parsed.version !== 1) {
        throw new Error("unreachable");
      }
      expect(parsed.config.heapSize).toBe(heap);
    }
  });

  it("accepts a transaction of exactly 4096 bytes (message + one signature)", () => {
    const big = vectors.cases.find((x) => x.name === "v1-large");
    const message = unhex(big?.message ?? "");
    expect(message.length + 64).toBe(4096);
    const parsed = parseCompiledMessage(message);
    expect(parsed.version).toBe(1);
    expect(unhex(big?.wire ?? "")).toHaveLength(4096);
  });
});

/** Re-encodes a parsed legacy/v0 message as a v1 message with an empty config, via kit. */
const asV1 = (parsed: ParsedSolanaMessage): Uint8Array =>
  new Uint8Array(
    encoder.encode({
      version: 1,
      header: {
        numSignerAccounts: parsed.numRequiredSignatures,
        numReadonlySignerAccounts: parsed.numReadonlySignerAccounts,
        numReadonlyNonSignerAccounts: parsed.numReadonlyNonSignerAccounts,
      },
      configMask: 0,
      configValues: [],
      lifetimeToken: parsed.lifetimeToken,
      numInstructions: parsed.instructions.length,
      numStaticAccounts: parsed.staticAccounts.length,
      staticAccounts: parsed.staticAccounts,
      instructionHeaders: parsed.instructions.map((ix: CompiledIx) => ({
        programAccountIndex: ix.programAddressIndex,
        numInstructionAccounts: ix.accountIndices.length,
        numInstructionDataBytes: ix.data.length,
      })),
      instructionPayloads: parsed.instructions.map((ix: CompiledIx) => ({
        instructionAccountIndices: Uint8Array.from(ix.accountIndices),
        instructionData: ix.data,
      })),
    } as never),
  );

/** Whether a parsed message can be expressed in v1 at all (its stricter limits). */
const expressibleAsV1 = (parsed: ParsedSolanaMessage): boolean =>
  parsed.lookups.length === 0 &&
  parsed.numRequiredSignatures <= 12 &&
  parsed.staticAccounts.length <= 64 &&
  parsed.instructions.length <= 64;

type SourceCase = {
  readonly label: string;
  readonly request: SignRequest;
  readonly signer: string;
};

const signingClasses = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
    "utf8",
  ),
) as {
  signers: { solana: string };
  cases: Array<{
    name: string;
    request: { kind: string; message?: { $bytes: string } } & Record<string, unknown>;
  }>;
};

const mainnet = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana-mainnet.json"), "utf8"),
) as Array<{
  label: string;
  signer: string;
  message: string;
  lookupTables?: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }>;
}>;

const sources = (): SourceCase[] => {
  const out: SourceCase[] = [];
  for (const c of signingClasses.cases) {
    if (c.request.kind !== "solana.transaction" || c.request.message === undefined) {
      continue;
    }
    const parsed = parseCompiledMessage(unhex(c.request.message.$bytes));
    if (!expressibleAsV1(parsed)) {
      continue;
    }
    out.push({
      label: `signing-classes ${c.name}`,
      request: { ...c.request, message: unhex(c.request.message.$bytes) } as SignRequest,
      signer: signingClasses.signers.solana,
    });
  }
  for (const f of mainnet) {
    const parsed = parseCompiledMessage(Uint8Array.from(Buffer.from(f.message, "base64")));
    if (!expressibleAsV1(parsed)) {
      continue;
    }
    out.push({
      label: `solana-mainnet ${f.label}`,
      request: {
        kind: "solana.transaction",
        network: MAINNET,
        account: ACCOUNT,
        message: Uint8Array.from(Buffer.from(f.message, "base64")),
      },
      signer: f.signer,
    });
  }
  return out;
};

describe("v1 applies the decode rules unchanged", () => {
  const cases = sources();

  it("found lookup-free legacy/v0 vectors to re-encode", () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [c.label, c] as const))(
    "%s decodes identically as v1 except the fee",
    (_label, c) => {
      if (c.request.kind !== "solana.transaction") {
        throw new Error("unreachable");
      }
      const parsed = parseCompiledMessage(c.request.message);
      const v1 = asV1(parsed);
      const reparsed = parseCompiledMessage(v1);
      expect(reparsed.version).toBe(1);
      // Same message content, different envelope.
      expect(reparsed.staticAccounts).toStrictEqual(parsed.staticAccounts);
      expect(reparsed.instructions).toStrictEqual(parsed.instructions);
      expect(reparsed.lifetimeToken).toBe(parsed.lifetimeToken);

      const legacy = decodeSolana(c.request, c.signer);
      const asOne = decodeSolana({ ...c.request, message: v1 }, c.signer);
      expect({ ...asOne, fee: undefined }).toStrictEqual({ ...legacy, fee: undefined });
      // Empty config: the v1 fee is exactly the signature cost.
      expect(asOne.fee?.max.amount).toBe(String(5000n * BigInt(parsed.numRequiredSignatures)));
    },
  );
});
