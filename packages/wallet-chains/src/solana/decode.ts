import { getU32Decoder, getU64Decoder } from "@solana/codecs";

import type {
  ApprovalChange,
  AssetFlow,
  DisplayIntent,
  IntentWarning,
  SignRequest,
  StakeAction,
  Verifiability,
} from "../index.ts";
import { SOLANA_NATIVE_ASSET } from "./assets.ts";
import { associatedTokenAddress } from "./ata.ts";
import { PROGRAM_IDS } from "./ids.ts";
import { JUPITER_PROGRAM, WSOL_MINT, decodeJupiterIx } from "./jupiter.ts";
import type { JupiterSwap } from "./jupiter.ts";
import { parseCompiledMessage, resolveAccountIndex } from "./message.ts";
import type { ParsedSolanaMessage } from "./message.ts";
import { decodeStakeCreate, decodeStakeIx } from "./stake.ts";
import type { StakeCreate, StakeIx } from "./stake.ts";
import { lookupSolanaToken, solanaTokenTable } from "./tokens.ts";
import type { SolanaTokenTable } from "./tokens.ts";

const u32 = getU32Decoder();
const u64 = getU64Decoder();
const u32le = (data: Uint8Array, offset: number): number => u32.decode(data, offset);
const u64le = (data: Uint8Array, offset: number): bigint => u64.decode(data, offset);

type IxCall = {
  readonly kind:
    | "system-transfer"
    | "system-create"
    | "cu-limit"
    | "cu-price"
    | "ata-create"
    | "ata-create-idempotent"
    | "token-transfer-checked"
    | "token-approve"
    | "stake"
    | "token-sync-native"
    | "token-close-account"
    | "jupiter"
    | "other";
  readonly to?: string | undefined;
  readonly amount?: bigint | undefined;
  readonly decimals?: number | undefined;
  readonly mint?: string | undefined;
  readonly units?: number | undefined;
  readonly microLamports?: bigint | undefined;
  /** The instruction's source account — the transfer/create funder, not the fee payer. */
  readonly from?: string | undefined;
  /** A recognized staking instruction: a system create-account or a stake-program op. */
  readonly stake?: StakeIx | StakeCreate | undefined;
  /** A recognised Jupiter swap instruction. */
  readonly jupiter?: JupiterSwap | undefined;
};

/**
 * Classifies one instruction by program + discriminator/layout. Exact-length checks keep
 * non-canonical encodings out of the `full` class.
 */
const classifyIx = (
  parsed: ParsedSolanaMessage,
  ix: { programAddressIndex: number; accountIndices: ReadonlyArray<number>; data: Uint8Array },
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
  signer: string,
): IxCall => {
  const program = resolveAccountIndex(parsed, ix.programAddressIndex, lookups);
  const { data } = ix;
  if (program === PROGRAM_IDS.system) {
    if (data.length === 12 && u32le(data, 0) === 2) {
      return {
        kind: "system-transfer",
        from: resolveAccountIndex(parsed, ix.accountIndices[0] ?? 0, lookups),
        to: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
        amount: u64le(data, 4),
      };
    }
    const create = decodeStakeCreate(parsed, ix, lookups);
    if (create !== undefined && create !== "other") {
      return { kind: "system-create", stake: create };
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
        to: resolveAccountIndex(parsed, ix.accountIndices[2] ?? 0, lookups),
        mint: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
      };
    }
    if (data.length === 9 && data[0] === 4) {
      return {
        kind: "token-approve",
        amount: u64le(data, 1),
        to: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
      };
    }
    if (data.length === 1 && data[0] === 17) {
      /* SyncNative refreshes a wrapped-SOL balance — the wrap itself is the transfer. */
      return { kind: "token-sync-native" };
    }
    if (data.length === 1 && data[0] === 9) {
      /* CloseAccount [account, destination, owner] — rent to a foreign address is an outflow the
         amount cannot be read from; a close back to the signer is plumbing. */
      const destination = resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups);
      return destination === signer ? { kind: "token-close-account" } : { kind: "other" };
    }
    return { kind: "other" };
  }
  if (program === JUPITER_PROGRAM) {
    const jupiter = decodeJupiterIx(parsed, ix, lookups);
    return jupiter !== undefined && jupiter.authority === signer
      ? { kind: "jupiter", jupiter }
      : { kind: "other" };
  }
  if (program === PROGRAM_IDS.stake) {
    const stake = decodeStakeIx(parsed, ix, lookups);
    return stake === undefined ? { kind: "other" } : { kind: "stake", stake };
  }
  return { kind: "other" };
};

const FULL_KINDS = new Set([
  "system-transfer",
  "system-create",
  "cu-limit",
  "cu-price",
  "ata-create",
  "ata-create-idempotent",
  "stake",
  "token-sync-native",
  "token-close-account",
]);

const classify = (
  parsed: ParsedSolanaMessage,
  calls: ReadonlyArray<IxCall>,
  network: string,
  table: SolanaTokenTable,
): Verifiability => {
  let allFull = true;
  for (const call of calls) {
    if (call.kind === "other") {
      return "opaque";
    }
    if (call.kind === "token-approve" || call.kind === "jupiter") {
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
      call.kind !== "jupiter"
    ) {
      return "opaque";
    }
  }
  if (parsed.lookups.length > 0) {
    return "partial";
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
  const calls = parsed.instructions.map((ix) => classifyIx(parsed, ix, lookups, signer));
  const verifiability = classify(parsed, calls, request.network, table);
  const outflows: AssetFlow[] = [];
  const approvals: ApprovalChange[] = [];
  const staking: StakeAction[] = [];
  const warnings: IntentWarning[] = [];
  const minimumReceived: Array<{ to: string; amount: AssetFlow["amount"] }> = [];
  const wsolAtas = new Set([
    associatedTokenAddress(signer, WSOL_MINT, PROGRAM_IDS.token),
    associatedTokenAddress(signer, WSOL_MINT, PROGRAM_IDS.token2022),
  ]);
  let otherTransfer = false;
  let hasJupiter = false;
  for (const call of calls) {
    if (call.kind === "system-transfer" && call.to !== undefined && call.from === signer) {
      /* The source is the instruction's first account — a second signer funds its own transfer. */
      if (wsolAtas.has(call.to)) {
        /* Funding the signer's own wSOL ATA is wrapping, not an outflow — the swap shows the SOL. */
        continue;
      }
      otherTransfer = true;
      outflows.push({
        to: call.to,
        amount: { asset: SOLANA_NATIVE_ASSET, amount: (call.amount ?? 0n).toString(10) },
        verified: true,
      });
    }
    if (call.kind === "jupiter" && call.jupiter !== undefined) {
      const swap = call.jupiter;
      hasJupiter = true;
      otherTransfer = true;
      const sell = lookupSolanaToken(table, request.network, swap.sourceMint);
      outflows.push({
        to: JUPITER_PROGRAM,
        amount:
          swap.sourceMint === WSOL_MINT
            ? { asset: SOLANA_NATIVE_ASSET, amount: swap.inAmount.toString(10) }
            : {
                asset: swap.sourceMint,
                amount: swap.inAmount.toString(10),
                ...(sell === undefined ? {} : { symbol: sell.symbol, decimals: sell.decimals }),
              },
        verified: swap.sourceMint === WSOL_MINT || sell !== undefined,
      });
      const minimum = (swap.quotedOut * BigInt(10_000 - swap.slippageBps) + 9999n) / 10_000n;
      const buy = lookupSolanaToken(table, request.network, swap.destinationMint);
      const destAta = associatedTokenAddress(
        signer,
        swap.destinationMint,
        swap.destinationTokenProgram,
      );
      minimumReceived.push({
        to: swap.destinationAccount === destAta ? signer : swap.destinationAccount,
        amount:
          swap.destinationMint === WSOL_MINT
            ? { asset: SOLANA_NATIVE_ASSET, amount: minimum.toString(10) }
            : {
                asset: swap.destinationMint,
                amount: minimum.toString(10),
                ...(buy === undefined ? {} : { symbol: buy.symbol, decimals: buy.decimals }),
              },
      });
      if (swap.platformFeeBps > 0) {
        warnings.push({ kind: "platform-fee", message: `${swap.platformFeeBps} bps` });
      }
    }
    if (call.kind === "token-transfer-checked") {
      otherTransfer = true;
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
      const token = lookupSolanaToken(table, request.network, call.mint ?? "");
      approvals.push({
        kind: "allowance",
        spender: call.to ?? "",
        amount: {
          asset: call.mint ?? "",
          amount: (call.amount ?? 0n).toString(10),
          ...(token === undefined ? {} : { symbol: token.symbol, decimals: token.decimals }),
        },
        change: "set",
        unlimited: false,
        verified: token !== undefined,
      });
    }
    const { stake } = call;
    if (stake !== undefined) {
      switch (stake.kind) {
        case "create":
          staking.push({
            kind: "create",
            account: stake.account,
            lamports: stake.lamports.toString(10),
          });
          if (stake.from === signer) {
            outflows.push({
              to: stake.account,
              amount: { asset: SOLANA_NATIVE_ASSET, amount: stake.lamports.toString(10) },
              verified: true,
            });
          }
          break;
        case "initialize":
        case "initialize-checked":
          if (stake.staker !== signer) {
            approvals.push({
              kind: "stake-authority",
              account: stake.account,
              role: "staker",
              authority: stake.staker,
              verified: false,
            });
          }
          if (stake.withdrawer !== signer) {
            approvals.push({
              kind: "stake-authority",
              account: stake.account,
              role: "withdrawer",
              authority: stake.withdrawer,
              verified: false,
            });
          }
          if (stake.kind === "initialize" && stake.lockup) {
            warnings.push({
              kind: "stake-lockup",
              message: "the stake account is locked — funds cannot move until the lockup expires",
            });
          }
          break;
        case "delegate":
          staking.push({ kind: "delegate", account: stake.account, validator: stake.validator });
          break;
        case "deactivate":
          staking.push({ kind: "deactivate", account: stake.account });
          break;
        case "withdraw":
          staking.push({
            kind: "withdraw",
            account: stake.account,
            to: stake.to,
            lamports: stake.lamports.toString(10),
          });
          if (stake.to !== signer) {
            outflows.push({
              to: stake.to,
              amount: {
                asset: SOLANA_NATIVE_ASSET,
                amount: stake.lamports.toString(10),
              },
              verified: true,
            });
          }
          break;
        case "authorize":
          if (stake.authority !== signer) {
            approvals.push({
              kind: "stake-authority",
              account: stake.account,
              role: stake.role,
              authority: stake.authority,
              verified: false,
            });
          }
          break;
      }
    }
  }
  const fee = feeLamports(parsed, calls);
  const summary = hasJupiter
    ? "swap"
    : otherTransfer
      ? "transfer"
      : staking.length > 0
        ? "stake"
        : outflows.length > 0
          ? "transfer"
          : "contract-call";
  return {
    family: "solana",
    network: request.network,
    summary,
    outflows,
    approvals,
    fee:
      fee === undefined
        ? undefined
        : { max: { asset: SOLANA_NATIVE_ASSET, amount: fee.toString(10) } },
    ...(staking.length === 0 ? {} : { staking }),
    ...(minimumReceived.length === 0 ? {} : { minimumReceived }),
    warnings,
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
