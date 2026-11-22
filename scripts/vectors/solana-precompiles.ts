/// <reference types="node" />
// oxlint-disable eslint/no-await-in-loop -- requests are sequential and throttled by design
/**
 * Regenerates vectors/chains/solana-precompiles.json: real mainnet transactions that invoke the
 * signature-verification precompiles (ed25519, secp256k1, secp256r1), whose declared signatures the
 * transaction fee pays for on top of the signers.
 *
 * The oracle is the public RPC https://api.mainnet-beta.solana.com: each signature is re-fetched
 * with getTransaction (encoding base64, maxSupportedTransactionVersion 1), the message is the wire
 * bytes after the signature vector, and the lookup tables are reconstructed by fetching each ALT
 * account — the reconstruction must equal meta.loadedAddresses exactly. `meta.fee` is what the
 * cluster actually charged; `precompileSignatures` and `priorityFeeBound` are computed here from
 * the RPC's instruction data, not by the wallet's decoder. When a signature can no longer be
 * fetched or fails verification, the entry already in the output file is kept.
 *
 * FIXTURES pins the discovered signatures. Running with it empty re-discovers candidates through
 * getSignaturesForAddress on each precompile program id (three per precompile, preferring a mix of
 * legacy/v0 — and v1 if any appear) and prints them for pinning.
 *
 * Run from the repo root: bun scripts/vectors/solana-precompiles.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../packages/wallet-chains/package.json", import.meta.url),
);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { getCompiledTransactionMessageDecoder } = require("@solana/transaction-messages") as {
  getCompiledTransactionMessageDecoder: () => {
    decode: (b: Uint8Array) => {
      version: "legacy" | 0 | 1;
      staticAccounts: ReadonlyArray<string>;
      instructions?: ReadonlyArray<{
        programAddressIndex: number;
        accountIndices?: ReadonlyArray<number>;
        data?: Uint8Array;
      }>;
      instructionHeaders?: ReadonlyArray<{ programAccountIndex: number }>;
      instructionPayloads?: ReadonlyArray<{ instructionData?: Uint8Array }>;
      addressTableLookups?: ReadonlyArray<{
        lookupTableAddress: string;
        writableIndexes: ReadonlyArray<number>;
        readonlyIndexes: ReadonlyArray<number>;
      }>;
    };
  };
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the CJS require is untyped
const { getAddressDecoder } = require("@solana/addresses") as {
  getAddressDecoder: () => { decode: (b: Uint8Array) => string };
};

const RPC = "https://api.mainnet-beta.solana.com";
const OUT = "vectors/chains/solana-precompiles.json";

/* anza-xyz/solana-sdk sdk-ids/src/lib.rs — the signature-verification precompiles. */
const PRECOMPILES = {
  ed25519: "Ed25519SigVerify111111111111111111111111111",
  secp256k1: "KeccakSecp256k11111111111111111111111111111",
  secp256r1: "Secp256r1SigVerify1111111111111111111111111",
} as const;
const PRECOMPILE_IDS = new Set<string>(Object.values(PRECOMPILES));

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

const PER_PRECOMPILE = 3;

/** [label, precompile, signature] — discovered by running with this list empty. */
const FIXTURES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "ed25519 legacy",
    "Ed25519SigVerify111111111111111111111111111",
    "2pA8bHReFSDEPGtDHqieUEr3B9tr1cDdwsMVGmC5FgX5FqVqYVPwU5vA8UJxbinkkqthiPkYgvAWRdCygVE5xUN1",
  ],
  [
    "ed25519 v0",
    "Ed25519SigVerify111111111111111111111111111",
    "ZPrmZdNpfowzBm4Vm9WBKNpeSrpmdzKEEmQi9smychtMaVHRBbF4kwwvNDtuwGXoAnDqESyQciz15B9RSBzgU5i",
  ],
  [
    "ed25519 v0",
    "Ed25519SigVerify111111111111111111111111111",
    "22y9W3GoTrVhB96zdymzPezcLdP8TVbGp4akmki59ZfYpDbN64tWbVxj2VzGPKT44N1AghRtyVBHYWBEdq1mbfCd",
  ],
  [
    "secp256k1 v0",
    "KeccakSecp256k11111111111111111111111111111",
    "Eggy4ud4gsixkyY4GyYXBoSdVKeLLKtXzYz9ZmbMXJ5nz6NqSnSdV5hNUmaqNtX1Gy4KmRRpRtvcNpS2M7GCBMs",
  ],
  [
    "secp256k1 v0",
    "KeccakSecp256k11111111111111111111111111111",
    "24b6pUp4r9P7GmnLJJfmeyn2e3hd6TCNRMNJQhf9xuMvtqQKAp4AftZ1gkzJ9eL22ZAWhSGNU2A7PxiZfm1NJLFz",
  ],
  [
    "secp256k1 v0",
    "KeccakSecp256k11111111111111111111111111111",
    "5rWMZBR7HfkqRPmTaK729fkAi36ufna7NR8dwwdkb9x1NU4n1TCpBQ1APnxeedchadd8LNXhPjrfWGjMMSvediqT",
  ],
  [
    "secp256r1 legacy",
    "Secp256r1SigVerify1111111111111111111111111",
    "56tFtoVqZ7eaXguz6ADigBZaw3WfhnLqYKGeZm8Yu24vhqNfFt2J2d9sUT8BLzWUtUVJiEy75mJhYL4aXg96j8eD",
  ],
  [
    "secp256r1 v0",
    "Secp256r1SigVerify1111111111111111111111111",
    "czW68pC8BkRk9ZfQX1Pse9fz69y9Y1RGNCZg2337LTXFdsFWCnyuNxw4oH6s1TS7TR2LKb8YvNeinMvu2S23h1n",
  ],
  [
    "secp256r1 v0",
    "Secp256r1SigVerify1111111111111111111111111",
    "3bH9PPUHgoY5jXVrLjNSkX2BanwFG85mrufp9SyjdjqNqqZbKNLsDXMtf45L9EWrZWHYdETo7fpVyLJZx7Dx7muu",
  ],
];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const rpc = async (method: string, params: unknown): Promise<unknown> => {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (r.status === 429) {
      await sleep(2000 * (i + 1));
      continue;
    }
    const j: unknown = await r.json();
    if (j !== null && typeof j === "object" && "error" in j && j.error !== undefined) {
      if (i < 5) {
        await sleep(1500);
        continue;
      }
      throw new Error(JSON.stringify(j.error));
    }
    return j !== null && typeof j === "object" && "result" in j ? j.result : undefined;
  }
  throw new Error("rate limited");
};

const dec = getCompiledTransactionMessageDecoder();
const addr = getAddressDecoder();
const shortvec = (b: Uint8Array, o: number): [number, number] => {
  let v = 0;
  let s = 0;
  let i = 0;
  for (;;) {
    const x = b.at(o + i);
    if (x === undefined) {
      throw new Error("truncated shortvec");
    }
    // oxlint-disable-next-line eslint/no-bitwise -- shortvec LEB128 decoding
    v |= (x & 0x7f) << s;
    i++;
    // oxlint-disable-next-line eslint/no-bitwise -- shortvec LEB128 continuation bit
    if (!(x & 0x80)) {
      break;
    }
    s += 7;
  }
  return [v, i];
};

const u32le = (data: Uint8Array, offset: number): number => {
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, true);
};
const u64le = (data: Uint8Array, offset: number): bigint => {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
};

type DecodedMessage = ReturnType<typeof dec.decode>;

/** [programIndex, data] per instruction, across all three message versions. */
const instructionsOf = (
  m: DecodedMessage,
): ReadonlyArray<{ programIndex: number; data: Uint8Array }> => {
  if (m.version === 1) {
    return (m.instructionHeaders ?? []).map((h, i) => ({
      programIndex: h.programAccountIndex,
      data: m.instructionPayloads?.[i]?.instructionData ?? new Uint8Array(0),
    }));
  }
  return (m.instructions ?? []).map((ix) => ({
    programIndex: ix.programAddressIndex,
    data: ix.data ?? new Uint8Array(0),
  }));
};

/** The version the wire declares: 0x80 → v0, 0x81 → v1, anything else is a legacy header. */
const wireVersion = (message: Uint8Array): "legacy" | 0 | 1 =>
  message[0] === 0x80 ? 0 : message[0] === 0x81 ? 1 : "legacy";

/* Agave signature_details.rs: an instruction to a signature-verification precompile adds
   data[0] (0 for empty data) to the signatures the fee pays for. */
const countPrecompileSignatures = (m: DecodedMessage): number => {
  let count = 0;
  for (const ix of instructionsOf(m)) {
    const program = m.staticAccounts[ix.programIndex];
    if (program !== undefined && PRECOMPILE_IDS.has(program)) {
      count += ix.data[0] ?? 0;
    }
  }
  return count;
};

/* Agave compute_budget_instruction_details.rs + fee/src/lib.rs: the non-signature part of the
   fee bound — ceil(price × limit / 1e6) for legacy/v0, the config's priority fee for v1. */
const priorityFeeBound = (m: DecodedMessage, message: Uint8Array): bigint => {
  if (m.version === 1) {
    // SIMD-0385: config values sit at 42 + 32×numStaticAccounts; bits 0+1 carry a u64 fee.
    const mask = u32le(message, 4);
    // oxlint-disable-next-line eslint/no-bitwise -- the SIMD-0385 config mask is a bit field
    return (mask & 0b11) === 0b11 ? u64le(message, 42 + 32 * m.staticAccounts.length) : 0n;
  }
  let builtin = 0n;
  let other = 0n;
  let price = 0n;
  let requested: bigint | undefined;
  for (const ix of instructionsOf(m)) {
    const program = m.staticAccounts[ix.programIndex];
    if (program === SYSTEM || program === COMPUTE_BUDGET) {
      builtin += 1n;
    } else {
      other += 1n;
    }
    if (program === COMPUTE_BUDGET && ix.data[0] === 3 && ix.data.length === 9) {
      price = u64le(ix.data, 1);
    }
    if (program === COMPUTE_BUDGET && ix.data[0] === 2 && ix.data.length === 5) {
      requested = BigInt(u32le(ix.data, 1));
    }
  }
  if (price === 0n) {
    return 0n;
  }
  const defaultLimit = 3000n * builtin + 200_000n * other;
  const limit = requested ?? defaultLimit;
  const capped = limit < 1_400_000n ? limit : 1_400_000n;
  return (price * capped + 999_999n) / 1_000_000n;
};

type TxResponse = {
  readonly meta:
    | {
        readonly err: unknown;
        readonly fee?: number;
        readonly loadedAddresses?: {
          readonly writable: ReadonlyArray<string>;
          readonly readonly: ReadonlyArray<string>;
        };
      }
    | undefined;
  readonly transaction: readonly [string, string];
  readonly slot: number;
  readonly blockTime: unknown;
};

type AccountResponse = {
  readonly value: { readonly data: readonly [string, string] } | undefined;
};

type Entry = {
  label: string;
  precompile: string;
  signature: string;
  slot: number;
  version: "legacy" | 0 | 1;
  feePayer: string;
  fee: number;
  precompileSignatures: number;
  priorityFeeBound: string;
  message: string;
  lookupTables: Array<{ address: string; addresses: string[] }>;
};

/** Fetches one transaction and builds its fixture entry; throws on any inconsistency. */
const buildEntry = async (label: string, precompile: string, signature: string): Promise<Entry> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON-RPC response shape
  const tx = (await rpc("getTransaction", [
    signature,
    { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ])) as TxResponse | undefined;
  const meta = tx?.meta;
  if (
    tx === undefined ||
    meta === undefined ||
    Object.is(meta, null) ||
    !Object.is(meta.err, null) ||
    typeof meta.fee !== "number"
  ) {
    throw new Error("not found");
  }
  const raw = Buffer.from(tx.transaction[0], "base64");
  const [n, len] = shortvec(raw, 0);
  const message = raw.subarray(len + 64 * n);
  const m = dec.decode(message);
  const accounts = [...m.staticAccounts];
  const ixs = instructionsOf(m);
  if (!ixs.some((ix) => accounts[ix.programIndex] === precompile)) {
    throw new Error("does not invoke the precompile");
  }
  const lookupTables: Array<{ address: string; addresses: string[] }> = [];
  const loadedW: string[] = [];
  const loadedR: string[] = [];
  for (const l of m.addressTableLookups ?? []) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON-RPC response shape
    const acc = (await rpc("getAccountInfo", [l.lookupTableAddress, { encoding: "base64" }])) as
      | AccountResponse
      | undefined;
    if (acc === undefined || acc.value === undefined || Object.is(acc.value, null)) {
      throw new Error("ALT account missing");
    }
    const data = Buffer.from(acc.value.data[0], "base64");
    const addresses: string[] = [];
    for (let o = 56; o + 32 <= data.length; o += 32) {
      addresses.push(addr.decode(data.subarray(o, o + 32)));
    }
    lookupTables.push({ address: l.lookupTableAddress, addresses });
    for (const i of l.writableIndexes) {
      const a = addresses.at(i);
      if (a === undefined) {
        throw new Error("ALT index out of range");
      }
      loadedW.push(a);
    }
    for (const i of l.readonlyIndexes) {
      const a = addresses.at(i);
      if (a === undefined) {
        throw new Error("ALT index out of range");
      }
      loadedR.push(a);
    }
  }
  const la = meta.loadedAddresses ?? { writable: [], readonly: [] };
  if (
    JSON.stringify(la.writable) !== JSON.stringify(loadedW) ||
    JSON.stringify(la.readonly) !== JSON.stringify(loadedR)
  ) {
    throw new Error("ALT reconstruction mismatch");
  }
  const [feePayer] = accounts;
  if (feePayer === undefined) {
    throw new Error("no fee payer");
  }
  return {
    label,
    precompile,
    signature,
    slot: tx.slot,
    version: wireVersion(message),
    feePayer,
    fee: meta.fee,
    precompileSignatures: countPrecompileSignatures(m),
    priorityFeeBound: priorityFeeBound(m, message).toString(10),
    message: Buffer.from(message).toString("base64"),
    lookupTables,
  };
};

type SignaturesResponse = ReadonlyArray<{
  readonly signature: string;
  readonly err: unknown;
  readonly slot: number;
}>;

/* getSignaturesForAddress on the program id lists transactions that invoke it; scan the recent
   ones (newest first) until PER_PRECOMPILE successes are pinned, preferring a mix of versions. */
const discover = async (): Promise<Array<readonly [string, string, string]>> => {
  const found: Array<readonly [string, string, string]> = [];
  for (const [name, program] of Object.entries(PRECOMPILES)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON-RPC response shape
    const sigs = (await rpc("getSignaturesForAddress", [
      program,
      { limit: 30, commitment: "confirmed" },
    ])) as SignaturesResponse | undefined;
    const candidates: Entry[] = [];
    for (const s of sigs ?? []) {
      if (candidates.length >= 8 || !Object.is(s.err, null)) {
        continue;
      }
      try {
        candidates.push(await buildEntry(name, program, s.signature));
      } catch (error) {
        process.stderr.write(`skip ${s.signature}: ${String(error)}\n`);
      }
      await sleep(300);
    }
    /* Prefer one fixture per version, then fill up to PER_PRECOMPILE newest-first. */
    const picked: Entry[] = [];
    for (const version of ["legacy", 0, 1] as const) {
      const c = candidates.find((x) => x.version === version);
      if (c !== undefined) {
        picked.push(c);
      }
    }
    for (const c of candidates) {
      if (picked.length >= PER_PRECOMPILE) {
        break;
      }
      if (!picked.includes(c)) {
        picked.push(c);
      }
    }
    if (picked.length < PER_PRECOMPILE) {
      throw new Error(`${name}: only ${picked.length} successful transactions found`);
    }
    for (const p of picked) {
      const label = `${name} ${p.version === "legacy" ? "legacy" : `v${p.version}`}`;
      found.push([label, program, p.signature]);
      process.stderr.write(`  ["${label}", "${program}", "${p.signature}"],\n`);
    }
  }
  return found;
};

const fixtures =
  FIXTURES.length > 0
    ? FIXTURES
    : await (async () => {
        process.stderr.write("FIXTURES is empty — discovering candidates:\n");
        const discovered = await discover();
        process.stderr.write("pin the signatures above in FIXTURES, then rerun\n");
        return discovered;
      })();

let previousEntries: Array<{ signature: string }> = [];
try {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the file's own output shape
  previousEntries = JSON.parse(readFileSync(OUT, "utf8")) as Array<{ signature: string }>;
} catch {
  /* first run — no previous entries to keep */
}
const previous = new Map(previousEntries.map((e) => [e.signature, e]));
const out: unknown[] = [];
let kept = 0;
for (const [label, precompile, signature] of fixtures) {
  let entry;
  try {
    entry = await buildEntry(label, precompile, signature);
    kept++;
  } catch {
    entry = previous.get(signature);
    if (entry === undefined) {
      throw new Error(`${label} ${signature}: fetch failed and no previous entry`);
    }
    process.stderr.write(`${label} ${signature}: kept previous entry\n`);
  }
  out.push(entry);
  await sleep(150);
}
process.stderr.write(`re-fetched ${kept}/${fixtures.length}\n`);
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
