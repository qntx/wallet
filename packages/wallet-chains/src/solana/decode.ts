import { getU32Decoder, getU64Decoder } from "@solana/codecs";

import { RECOGNISED_FAMILIES } from "../families.ts";
import type {
  ApprovalChange,
  AssetFlow,
  BlindReason,
  DisplayIntent,
  IntentWarning,
  SignRequest,
  StakeAction,
  Verifiability,
} from "../index.ts";
import { ChainError } from "../index.ts";
import { withNativeAmountMeta } from "../networks.ts";
import {
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  WHIRLPOOL_PROGRAM,
  decodeAmmSwapIx,
  METEORA_DLMM_PROGRAM,
} from "./amm.ts";
import type { AmmSwap } from "./amm.ts";
import { SOLANA_NATIVE_ASSET } from "./assets.ts";
import { associatedTokenAddress } from "./ata.ts";
import { MPL_CORE_PROGRAM, decodeCoreIx } from "./core.ts";
import { PROGRAM_IDS } from "./ids.ts";
import { JUPITER_PROGRAM, WSOL_MINT, decodeJupiterIx } from "./jupiter.ts";
import type { JupiterSwap } from "./jupiter.ts";
import { isWritableIndex, parseCompiledMessage, resolveAccountIndex } from "./message.ts";
import type { ParsedSolanaMessage } from "./message.ts";
import { decodeStakeIx, decodeSystemCreate } from "./stake.ts";
import type { StakeCreate, StakeIx, SystemCreate } from "./stake.ts";
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
    | "system-create-account"
    | "system-advance-nonce"
    | "cu-limit"
    | "cu-price"
    | "ata-create"
    | "ata-create-idempotent"
    | "token-transfer-checked"
    | "token-transfer"
    | "token-burn"
    | "token-approve"
    | "token-initialize-account"
    | "token-revoke"
    | "stake"
    | "token-sync-native"
    | "token-close-account"
    | "jupiter"
    | "amm-swap"
    | "core-transfer"
    | "other";
  readonly to?: string | undefined;
  readonly amount?: bigint | undefined;
  readonly decimals?: number | undefined;
  readonly mint?: string | undefined;
  /** An unchecked Transfer's source token account — the instruction names no mint. */
  readonly tokenAccount?: string | undefined;
  readonly units?: number | undefined;
  readonly microLamports?: bigint | undefined;
  /** The instruction's source account — the transfer/create funder, not the fee payer. */
  readonly from?: string | undefined;
  /** A recognized staking instruction: a system create-account or a stake-program op. */
  readonly stake?: StakeIx | StakeCreate | undefined;
  /** A system-program creation of an account owned by a program other than Stake. */
  readonly create?: SystemCreate | undefined;
  /** A recognised Jupiter swap instruction. */
  readonly jupiter?: JupiterSwap | undefined;
  /** A recognised AMM swap instruction (Raydium v4/CLMM/CPMM, Orca Whirlpool). */
  readonly amm?: AmmSwap | undefined;
  /** A recognised Metaplex Core transfer: the asset leaves for `newOwner`. */
  readonly core?: { readonly asset: string; readonly newOwner: string } | undefined;
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
    const create = decodeSystemCreate(parsed, ix, lookups);
    if (create !== undefined && create !== "other") {
      return create.owner === PROGRAM_IDS.stake
        ? {
            kind: "system-create",
            stake: {
              kind: "create",
              account: create.account,
              from: create.from,
              lamports: create.lamports,
            },
          }
        : { kind: "system-create-account", create };
    }
    if (data.length === 4 && u32le(data, 0) === 4 && ix.accountIndices.length === 3) {
      /* AdvanceNonceAccount [nonce, RecentBlockhashes, authority] — plumbing, nothing moves. */
      return { kind: "system-advance-nonce" };
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
    if (data.length === 9 && data[0] === 3 && ix.accountIndices.length === 3) {
      /* Transfer [source, destination, authority] — names no mint; the source account's contents
         move, so the shown asset is the account itself. Only the signer's own authority decodes. */
      const authority = resolveAccountIndex(parsed, ix.accountIndices[2] ?? 0, lookups);
      return authority === signer
        ? {
            kind: "token-transfer",
            amount: u64le(data, 1),
            tokenAccount: resolveAccountIndex(parsed, ix.accountIndices[0] ?? 0, lookups),
            to: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
          }
        : { kind: "other" };
    }
    if (
      ((data.length === 9 && data[0] === 8) || (data.length === 10 && data[0] === 15)) &&
      ix.accountIndices.length === 3
    ) {
      /* Burn [account, mint, owner] / BurnChecked — the checked decimals byte is not proof, so a
         listed mint alone carries symbol/decimals. */
      const owner = resolveAccountIndex(parsed, ix.accountIndices[2] ?? 0, lookups);
      return owner === signer
        ? {
            kind: "token-burn",
            amount: u64le(data, 1),
            mint: resolveAccountIndex(parsed, ix.accountIndices[1] ?? 0, lookups),
            to: resolveAccountIndex(parsed, ix.accountIndices[0] ?? 0, lookups),
          }
        : { kind: "other" };
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
    if (data.length === 1 && data[0] === 1 && ix.accountIndices.length === 4) {
      /* InitializeAccount [account, mint, owner, rent] — plumbing, nothing moves. */
      return { kind: "token-initialize-account" };
    }
    if (data.length === 1 && data[0] === 5 && ix.accountIndices.length === 2) {
      /* Revoke [account, owner] — drops a delegate; plumbing, nothing moves. */
      return { kind: "token-revoke" };
    }
    return { kind: "other" };
  }
  if (program === JUPITER_PROGRAM) {
    const jupiter = decodeJupiterIx(parsed, ix, lookups);
    return jupiter !== undefined && jupiter.authority === signer
      ? { kind: "jupiter", jupiter }
      : { kind: "other" };
  }
  if (
    program === RAYDIUM_AMM_PROGRAM ||
    program === RAYDIUM_CLMM_PROGRAM ||
    program === RAYDIUM_CPMM_PROGRAM ||
    program === WHIRLPOOL_PROGRAM ||
    program === METEORA_DLMM_PROGRAM
  ) {
    const amm = decodeAmmSwapIx(parsed, ix, lookups, program);
    return amm !== undefined && amm.authority === signer
      ? { kind: "amm-swap", amm }
      : { kind: "other" };
  }
  if (program === MPL_CORE_PROGRAM) {
    const core = decodeCoreIx(parsed, ix, lookups);
    return core !== undefined && core.authority === signer
      ? { kind: "core-transfer", core }
      : { kind: "other" };
  }
  if (program === PROGRAM_IDS.stake) {
    const stake = decodeStakeIx(parsed, ix, lookups);
    /* A Split whose staker is not the signer stays "other" — the core-instruction rule applies. */
    return stake === undefined || (stake.kind === "split" && stake.staker !== signer)
      ? { kind: "other" }
      : { kind: "stake", stake };
  }
  return { kind: "other" };
};

const FULL_KINDS = new Set([
  "system-transfer",
  "system-create",
  "system-create-account",
  "system-advance-nonce",
  "cu-limit",
  "cu-price",
  "ata-create",
  "ata-create-idempotent",
  "stake",
  "token-sync-native",
  "token-close-account",
  "token-initialize-account",
  "token-revoke",
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
    if (
      call.kind === "token-approve" ||
      call.kind === "jupiter" ||
      call.kind === "amm-swap" ||
      call.kind === "core-transfer" ||
      call.kind === "token-transfer" ||
      call.kind === "token-burn"
    ) {
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
      call.kind !== "token-transfer" &&
      call.kind !== "token-burn" &&
      call.kind !== "token-approve" &&
      call.kind !== "jupiter" &&
      call.kind !== "amm-swap" &&
      call.kind !== "core-transfer"
    ) {
      return "opaque";
    }
  }
  if (parsed.lookups.length > 0) {
    return "partial";
  }
  return allFull ? "full" : "partial";
};

/** The most writable accounts a signer-taking unknown program may reach before it is blind. */
export const PROGRAM_AUTHORITY_ACCOUNTS = 12;

const DEFAULT_INSTRUCTION_CU = 200_000n;
const BUILTIN_INSTRUCTION_CU = 3000n;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;

const feeLamports = (
  parsed: ParsedSolanaMessage,
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
  calls: ReadonlyArray<IxCall>,
): bigint => {
  const price = calls.find((c) => c.kind === "cu-price")?.microLamports ?? 0n;
  // Agave compute_budget_instruction_details.rs: the default limit is 3,000 CU per
  // non-migrating builtin instruction (System and ComputeBudget here; migrating builtins count
  // as regular instructions, so this stays an upper bound) plus 200,000 per other instruction,
  // capped at MAX_COMPUTE_UNIT_LIMIT.
  let builtin = 0n;
  let other = 0n;
  for (const ix of parsed.instructions) {
    const program = resolveAccountIndex(parsed, ix.programAddressIndex, lookups);
    if (program === PROGRAM_IDS.system || program === PROGRAM_IDS.computeBudget) {
      builtin += 1n;
    } else {
      other += 1n;
    }
  }
  const defaultLimit = BUILTIN_INSTRUCTION_CU * builtin + DEFAULT_INSTRUCTION_CU * other;
  const requested = calls.find((c) => c.kind === "cu-limit")?.units;
  const limit = requested === undefined ? defaultLimit : BigInt(requested);
  const capped = limit < MAX_COMPUTE_UNIT_LIMIT ? limit : MAX_COMPUTE_UNIT_LIMIT;
  const signatures = BigInt(parsed.numRequiredSignatures);
  return 5000n * signatures + (price * capped + 999_999n) / 1_000_000n;
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
  if (
    calls.filter((c) => c.kind === "cu-limit").length > 1 ||
    calls.filter((c) => c.kind === "cu-price").length > 1
  ) {
    throw new ChainError("invalid-request", "duplicate compute-budget instruction");
  }
  const verifiability = classify(parsed, calls, request.network, table);
  const outflows: AssetFlow[] = [];
  const approvals: ApprovalChange[] = [];
  const staking: StakeAction[] = [];
  const warnings: IntentWarning[] = [];
  const minimumReceived: Array<{
    to: string;
    amount: AssetFlow["amount"];
    tokenAccount?: string;
  }> = [];
  const wsolAtas = new Set([
    associatedTokenAddress(signer, WSOL_MINT, PROGRAM_IDS.token),
    associatedTokenAddress(signer, WSOL_MINT, PROGRAM_IDS.token2022),
  ]);
  const atas = new Map<string, { mint: string; symbol: string }>();
  for (const [mint, token] of Object.entries(table[request.network] ?? {})) {
    for (const tokenProgram of [PROGRAM_IDS.token, PROGRAM_IDS.token2022]) {
      atas.set(associatedTokenAddress(signer, mint, tokenProgram), {
        mint,
        symbol: token.symbol,
      });
    }
  }
  let otherTransfer = false;
  let hasSwap = false;
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
    if (
      call.kind === "system-create-account" &&
      call.create !== undefined &&
      call.create.from === signer
    ) {
      /* A CreateAccount funded by the signer sends the new account's lamports to it. */
      otherTransfer = true;
      outflows.push({
        to: call.create.account,
        amount: { asset: SOLANA_NATIVE_ASSET, amount: call.create.lamports.toString(10) },
        verified: true,
      });
    }
    if (call.kind === "jupiter" && call.jupiter !== undefined) {
      const swap = call.jupiter;
      hasSwap = true;
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
    if (call.kind === "amm-swap" && call.amm !== undefined) {
      const swap = call.amm;
      hasSwap = true;
      otherTransfer = true;
      /* Mints the instruction does not name (AMM v4) resolve through the signer's ATA table —
         a source/destination that is the signer's ATA of a table mint shows that mint. */
      const sourceMint = swap.sourceMint ?? atas.get(swap.sourceAccount)?.mint;
      const sourceToken =
        sourceMint === undefined
          ? undefined
          : lookupSolanaToken(table, request.network, sourceMint);
      outflows.push(
        sourceMint === undefined
          ? {
              to: swap.program,
              amount: { asset: swap.sourceAccount, amount: swap.maxIn.toString(10) },
              verified: false,
              tokenAccount: swap.sourceAccount,
            }
          : {
              to: swap.program,
              amount:
                sourceMint === WSOL_MINT
                  ? { asset: SOLANA_NATIVE_ASSET, amount: swap.maxIn.toString(10) }
                  : {
                      asset: sourceMint,
                      amount: swap.maxIn.toString(10),
                      ...(sourceToken === undefined
                        ? {}
                        : { symbol: sourceToken.symbol, decimals: sourceToken.decimals }),
                    },
              verified: sourceMint === WSOL_MINT || sourceToken !== undefined,
            },
      );
      const destinationMint = swap.destinationMint ?? atas.get(swap.destinationAccount)?.mint;
      const destinationToken =
        destinationMint === undefined
          ? undefined
          : lookupSolanaToken(table, request.network, destinationMint);
      /* `to` is the signer only when the destination is the signer's own ATA of the destination
         mint — the instruction's explicit token program when it names one, else either. */
      const destinationAtas =
        swap.destinationTokenProgram === undefined
          ? [PROGRAM_IDS.token, PROGRAM_IDS.token2022].map((p) =>
              destinationMint === undefined
                ? ""
                : associatedTokenAddress(signer, destinationMint, p),
            )
          : [
              destinationMint === undefined
                ? ""
                : associatedTokenAddress(signer, destinationMint, swap.destinationTokenProgram),
            ];
      const ownAta = destinationAtas.includes(swap.destinationAccount);
      minimumReceived.push(
        destinationMint === undefined
          ? {
              to: swap.destinationAccount,
              amount: { asset: swap.destinationAccount, amount: swap.minOut.toString(10) },
              tokenAccount: swap.destinationAccount,
            }
          : {
              to: ownAta ? signer : swap.destinationAccount,
              amount:
                destinationMint === WSOL_MINT
                  ? { asset: SOLANA_NATIVE_ASSET, amount: swap.minOut.toString(10) }
                  : {
                      asset: destinationMint,
                      amount: swap.minOut.toString(10),
                      ...(destinationToken === undefined
                        ? {}
                        : { symbol: destinationToken.symbol, decimals: destinationToken.decimals }),
                    },
            },
      );
    }
    if (call.kind === "core-transfer" && call.core !== undefined) {
      otherTransfer = true;
      outflows.push({
        to: call.core.newOwner,
        amount: { asset: call.core.asset, amount: "1" },
        verified: false,
      });
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
    if (call.kind === "token-transfer" && call.tokenAccount !== undefined) {
      otherTransfer = true;
      outflows.push({
        to: call.to ?? "",
        amount: {
          asset: call.tokenAccount,
          amount: (call.amount ?? 0n).toString(10),
        },
        verified: false,
        tokenAccount: call.tokenAccount,
      });
    }
    if (call.kind === "token-burn") {
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
        burn: true,
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
        case "split":
          staking.push({
            kind: "split",
            account: stake.account,
            to: stake.to,
            lamports: stake.lamports.toString(10),
          });
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
  // The fee is charged to the fee payer only — a sponsored signer pays nothing.
  const fee = parsed.staticAccounts[0] === signer ? feeLamports(parsed, lookups, calls) : 0n;
  const programs: string[] = [];
  /* The writable non-signer accounts each signer-taking unknown program can reach, and whether it
     can move the signer's SOL. */
  const authority = new Map<string, { sol: boolean; accounts: string[] }>();
  const signerIndex = parsed.staticAccounts.indexOf(signer);
  const signerWritable = signerIndex !== -1 && isWritableIndex(parsed, signerIndex);
  const altWritable = parsed.lookups.some((l) => l.writableIndexes.length > 0);
  let blind: BlindReason | undefined;
  for (const [index, ix] of parsed.instructions.entries()) {
    const program =
      calls[index]?.kind === "other"
        ? resolveAccountIndex(parsed, ix.programAddressIndex, lookups)
        : undefined;
    if (program === undefined) {
      continue;
    }
    if (!programs.includes(program)) {
      programs.push(program);
    }
    /* The core programs act on an account's value only with its owner's signature, so an
       undecoded instruction the signer does not sign cannot spend the signer's assets and stays
       opaque. One the signer does sign is blind: nothing shown bounds what it authorises. An
       unknown program is never blind — the prompt names it like any contract the owner trusts. */
    const row = RECOGNISED_FAMILIES.find(
      (family) =>
        family.claim.surface === "solana.instruction" &&
        PROGRAM_IDS[family.claim.program] === program,
    );
    const takesSigner = ix.accountIndices.some(
      (i) => i < parsed.numRequiredSignatures && parsed.staticAccounts[i] === signer,
    );
    if (row !== undefined) {
      if (blind === undefined && takesSigner) {
        blind = row.nearMiss;
      }
      continue;
    }
    if (!takesSigner) {
      continue;
    }
    /* An unknown program the signature is handed to can act with this account's full authority —
       name what it can reach; a reach the wallet cannot list (writable ALT entries, or a union
       past the prompt's account budget) is blind. */
    const entry = authority.get(program) ?? { sol: signerWritable, accounts: [] };
    for (const i of ix.accountIndices) {
      const account = resolveAccountIndex(parsed, i, lookups);
      if (
        account === undefined ||
        account === signer ||
        !isWritableIndex(parsed, i) ||
        entry.accounts.includes(account)
      ) {
        continue;
      }
      entry.accounts.push(account);
    }
    authority.set(program, entry);
    if (
      blind === undefined &&
      (altWritable || entry.accounts.length > PROGRAM_AUTHORITY_ACCOUNTS)
    ) {
      blind = "program-authority";
    }
  }
  const summary = hasSwap
    ? "swap"
    : otherTransfer
      ? "transfer"
      : staking.length > 0
        ? "stake"
        : outflows.length > 0
          ? "transfer"
          : "contract-call";
  const programAuthority = [...authority.entries()].map(([program, entry]) => ({
    program,
    sol: entry.sol,
    accounts: entry.accounts.map((a) => {
      const token = atas.get(a);
      return token === undefined ? { address: a } : { address: a, token };
    }),
  }));
  return {
    family: "solana",
    network: request.network,
    summary,
    outflows,
    approvals,
    fee: { max: { asset: SOLANA_NATIVE_ASSET, amount: fee.toString(10) } },
    ...(staking.length === 0 ? {} : { staking }),
    ...(minimumReceived.length === 0 ? {} : { minimumReceived }),
    ...(programs.length === 0 ? {} : { programs }),
    ...(programAuthority.length === 0 ? {} : { programAuthority }),
    warnings,
    verifiability,
    ...(blind === undefined ? {} : { blind }),
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
): DisplayIntent =>
  withNativeAmountMeta(
    decodeTransaction(request, signer, table),
    request.network,
    SOLANA_NATIVE_ASSET,
    9,
  );
