import { getU32Decoder, getU64Decoder } from "@solana/codecs";

import type {
  ApprovalChange,
  AssetFlow,
  DisplayIntent,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { PROGRAM_IDS } from "./ids.ts";
import { parseCompiledMessage, resolveAccountIndex } from "./message.ts";
import type { ParsedSolanaMessage } from "./message.ts";
import { lookupSolanaToken, solanaTokenTable } from "./tokens.ts";
import type { SolanaTokenTable } from "./tokens.ts";

const LAMPORTS_ASSET = "lamports";

const u32 = getU32Decoder();
const u64 = getU64Decoder();
const u32le = (data: Uint8Array, offset: number): number => u32.decode(data, offset);
const u64le = (data: Uint8Array, offset: number): bigint => u64.decode(data, offset);

type IxCall = {
  readonly kind:
    | "system-transfer"
    | "cu-limit"
    | "cu-price"
    | "ata-create"
    | "ata-create-idempotent"
    | "token-transfer-checked"
    | "token-approve"
    | "stake"
    | "other";
  readonly to?: string | undefined;
  readonly amount?: bigint | undefined;
  readonly decimals?: number | undefined;
  readonly mint?: string | undefined;
  readonly units?: number | undefined;
  readonly microLamports?: bigint | undefined;
};

/**
 * Classifies one instruction by program + discriminator/layout. Exact-length checks keep
 * non-canonical encodings out of the `full` class.
 */
const classifyIx = (
  parsed: ParsedSolanaMessage,
  ix: { programAddressIndex: number; accountIndices: ReadonlyArray<number>; data: Uint8Array },
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
): IxCall => {
  const program = resolveAccountIndex(parsed, ix.programAddressIndex, lookups);
  const { data } = ix;
  if (program === PROGRAM_IDS.system) {
    if (data.length === 12 && u32le(data, 0) === 2) {
      return {
        kind: "system-transfer",
        to: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
        amount: u64le(data, 4),
      };
    }
    return { kind: "other" };
  }
  if (program === PROGRAM_IDS.computeBudget) {
    if (data.length === 5 && data[0] === 2) {
      return { kind: "cu-limit", units: u32le(data, 1) };
    }
    if (data.length === 9 && data[0] === 3) {
      return { kind: "cu-price", microLamports: u64le(data, 1) };
    }
    return { kind: "other" };
  }
  if (program === PROGRAM_IDS.associatedToken) {
    if (data.length === 1 && data[0] === 0) {
      return { kind: "ata-create" };
    }
    if (data.length === 1 && data[0] === 1) {
      return { kind: "ata-create-idempotent" };
    }
    return { kind: "other" };
  }
  if (program === PROGRAM_IDS.token || program === PROGRAM_IDS.token2022) {
    if (data.length === 10 && data[0] === 12) {
      return {
        kind: "token-transfer-checked",
        amount: u64le(data, 1),
        decimals: data[9],
        to: resolveAccountIndex(parsed, ix.accountIndices[3] ?? 0, lookups),
        mint: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
      };
    }
    if (data.length === 9 && data[0] === 4) {
      return { kind: "token-approve", amount: u64le(data, 1) };
    }
    return { kind: "other" };
  }
  if (program === PROGRAM_IDS.stake) {
    return { kind: "stake" };
  }
  return { kind: "other" };
};

const FULL_KINDS = new Set([
  "system-transfer",
  "cu-limit",
  "cu-price",
  "ata-create",
  "ata-create-idempotent",
]);

const classify = (
  parsed: ParsedSolanaMessage,
  calls: ReadonlyArray<IxCall>,
  network: string,
  table: SolanaTokenTable,
): Verifiability => {
  if (parsed.lookupCount > 0) {
    return "partial";
  }
  let allFull = true;
  for (const call of calls) {
    if (call.kind === "other") {
      return "opaque";
    }
    if (call.kind === "token-approve" || call.kind === "stake") {
      allFull = false;
    }
    if (
      call.kind === "token-transfer-checked" &&
      lookupSolanaToken(table, network, call.mint ?? "") === undefined
    ) {
      allFull = false;
    }
    if (
      !FULL_KINDS.has(call.kind) &&
      call.kind !== "token-transfer-checked" &&
      call.kind !== "token-approve" &&
      call.kind !== "stake"
    ) {
      return "opaque";
    }
  }
  return allFull ? "full" : "partial";
};

const feeLamports = (
  parsed: ParsedSolanaMessage,
  calls: ReadonlyArray<IxCall>,
): bigint | undefined => {
  const limit = calls.find((c) => c.kind === "cu-limit")?.units;
  const price = calls.find((c) => c.kind === "cu-price")?.microLamports;
  if (limit === undefined || price === undefined) {
    return undefined;
  }
  const signatures = BigInt(parsed.numRequiredSignatures);
  return 5000n * signatures + (price * BigInt(limit) + 999_999n) / 1_000_000n;
};

const decodeTransaction = (
  request: Extract<SignRequest, { kind: "solana.transaction" }>,
  signer: string,
  table: SolanaTokenTable,
): DisplayIntent => {
  const parsed = parseCompiledMessage(request.message);
  const lookups = request.lookupTables?.map((t) => ({
    address: t.address,
    addresses: t.addresses,
  }));
  const calls = parsed.instructions.map((ix) => classifyIx(parsed, ix, lookups));
  const verifiability = classify(parsed, calls, request.network, table);
  const outflows: AssetFlow[] = [];
  const approvals: ApprovalChange[] = [];
  for (const call of calls) {
    if (call.kind === "system-transfer" && call.to !== undefined) {
      const [source] = parsed.staticAccounts;
      if (source === signer) {
        outflows.push({
          to: call.to,
          amount: { asset: LAMPORTS_ASSET, amount: (call.amount ?? 0n).toString(10) },
          verified: true,
        });
      }
    }
    if (call.kind === "token-transfer-checked") {
      const token = lookupSolanaToken(table, request.network, call.mint ?? "");
      outflows.push({
        to: call.to ?? "",
        amount: {
          asset: call.mint ?? "",
          amount: (call.amount ?? 0n).toString(10),
          ...(token === undefined ? {} : { symbol: token.symbol, decimals: token.decimals }),
        },
        verified: token !== undefined,
      });
    }
    if (call.kind === "token-approve") {
      approvals.push({
        asset: call.mint ?? "",
        spender: "",
        amount: (call.amount ?? 0n).toString(10),
        unlimited: false,
        verified: false,
      });
    }
  }
  const fee = feeLamports(parsed, calls);
  return {
    family: "solana",
    network: request.network,
    summary: outflows.length > 0 ? "transfer" : "contract-call",
    outflows,
    approvals,
    fee:
      fee === undefined ? undefined : { max: { asset: LAMPORTS_ASSET, amount: fee.toString(10) } },
    warnings: [],
    verifiability,
  };
};

/** What the signer can guarantee about this request (WD-065). */
export const verifiabilitySolana = (
  request: Extract<SignRequest, { kind: "solana.transaction" }>,
  signer: string,
  table: SolanaTokenTable = solanaTokenTable,
): Verifiability => decodeSolana(request, signer, table).verifiability;

export const decodeSolana = (
  request: Extract<SignRequest, { kind: "solana.transaction" }>,
  signer: string,
  table: SolanaTokenTable = solanaTokenTable,
): DisplayIntent => decodeTransaction(request, signer, table);
