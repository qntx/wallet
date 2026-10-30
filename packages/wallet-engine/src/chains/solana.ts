import { base64 } from "@scure/base";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
/**
 * Solana chain adapter — native SOL and SPL-token transfers as v0 messages without lookup tables.
 * Compute-unit headroom is simulated-units x 1.1; the priority fee comes from
 * getRecentPrioritizationFees percentiles (p50/p75/p90) over the writable accounts. Broadcast is
 * sendTransaction(skipPreflight:false, maxRetries:0) re-sent every 2 s while the blockhash is live;
 * an expired lastValidBlockHeight without confirmation is `dropped`. A 1232-byte compiled message
 * is rejected before signing.
 */
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";

import type { SolanaRpc } from "../networks/controller.ts";

const MAX_MESSAGE_BYTES = 1232;
const CU_SIMULATE_LIMIT = 1_400_000;

export type SolanaIntent =
  | { readonly kind: "sol"; readonly to: string; readonly lamports: bigint }
  | {
      readonly kind: "spl";
      readonly mint: string;
      readonly to: string;
      readonly amount: bigint;
      readonly decimals: number;
    };

export type SolanaFeeTier = "slow" | "normal" | "fast";

export type SolanaFeeQuote = {
  readonly tier: SolanaFeeTier;
  /** Micro-lamports per compute unit. */
  readonly microLamportsPerCu: bigint;
};

export type SolanaUnsignedTransaction = {
  readonly family: "solana";
  readonly network: string;
  readonly from: string;
  readonly instructions: ReadonlyArray<Instruction>;
  readonly writable: ReadonlyArray<string>;
  readonly unitsConsumed: number;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
};

type Compiled = {
  readonly messageBytes: Uint8Array;
  readonly instructions: ReadonlyArray<Instruction>;
};

const b64 = (bytes: Uint8Array): string => base64.encode(bytes);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);

const str = (v: unknown, fallback = "0"): string => {
  if (typeof v === "string") {
    return v;
  }
  return typeof v === "number" || typeof v === "bigint" ? String(v) : fallback;
};

export class SolanaChainAdapter {
  private async rpc(rpc: SolanaRpc, method: string, params: unknown[]): Promise<unknown> {
    return rpc.call(method, params);
  }

  private async instructions(
    rpc: SolanaRpc,
    from: string,
    intent: SolanaIntent,
  ): Promise<ReadonlyArray<Instruction>> {
    if (intent.kind === "sol") {
      return [
        getTransferSolInstruction({
          source: createNoopSigner(address(from)),
          destination: address(intent.to),
          amount: intent.lamports,
        }),
      ];
    }
    const [sourceAta] = await findAssociatedTokenPda({
      mint: address(intent.mint),
      owner: address(from),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint: address(intent.mint),
      owner: address(intent.to),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const ixs: Instruction[] = [];
    const destInfo = await this.rpc(rpc, "getAccountInfo", [
      destAta,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (obj(obj(destInfo)?.["value"]) === undefined) {
      ixs.push(
        getCreateAssociatedTokenIdempotentInstruction({
          ata: destAta,
          mint: address(intent.mint),
          owner: address(intent.to),
          payer: createNoopSigner(address(from)),
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        }),
      );
    }
    ixs.push(
      getTransferCheckedInstruction({
        source: sourceAta,
        mint: address(intent.mint),
        destination: destAta,
        authority: address(from),
        amount: intent.amount,
        decimals: intent.decimals,
      }),
    );
    return ixs;
  }

  /** Instruction set, simulated compute units, and a fresh blockhash — fee fields come later. */
  async build(
    rpc: SolanaRpc,
    network: string,
    from: string,
    intent: SolanaIntent,
  ): Promise<SolanaUnsignedTransaction> {
    const instructions = await this.instructions(rpc, from, intent);
    const hashResult = obj(
      await this.rpc(rpc, "getLatestBlockhash", [{ commitment: "confirmed" }]),
    );
    const value = obj(hashResult?.["value"]);
    const blockhashValue = typeof value?.["blockhash"] === "string" ? value["blockhash"] : "";
    const lastValidBlockHeight = BigInt(str(value?.["lastValidBlockHeight"], "0"));
    const compiled = this.compile(from, instructions, blockhashValue, lastValidBlockHeight);
    const units = await this.simulate(rpc, compiled.messageBytes);
    return {
      family: "solana",
      network,
      from,
      instructions,
      writable: this.writableAccounts(instructions),
      unitsConsumed: units,
      blockhash: blockhashValue,
      lastValidBlockHeight,
    };
  }

  private writableAccounts(instructions: ReadonlyArray<Instruction>): ReadonlyArray<string> {
    const out = new Set<string>();
    for (const ix of instructions) {
      const accounts = obj(ix)?.["accounts"];
      if (!Array.isArray(accounts)) {
        continue;
      }
      for (const a of accounts) {
        const record = obj(a);
        const role = Number(record?.["role"] ?? 0);
        if (typeof record?.["address"] === "string" && role >= 2) {
          out.add(record["address"]);
        }
      }
    }
    return [...out];
  }

  /** Unsigned wire bytes: shortvec(1) sig count + 64-byte zero sig + message (for simulate). */
  private wireBytes(messageBytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(1 + 64 + messageBytes.length);
    out[0] = 1;
    out.set(messageBytes, 65);
    return out;
  }

  private async simulate(rpc: SolanaRpc, messageBytes: Uint8Array): Promise<number> {
    const result = obj(
      await this.rpc(rpc, "simulateTransaction", [
        b64(this.wireBytes(messageBytes)),
        { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false },
      ]),
    );
    const value = obj(result?.["value"]);
    const units = Number(value?.["unitsConsumed"] ?? 0);
    return units > 0 ? units : CU_SIMULATE_LIMIT;
  }

  private compile(
    from: string,
    instructions: ReadonlyArray<Instruction>,
    blockhashValue: string,
    lastValidBlockHeight: bigint,
  ): Compiled {
    const message = createTransactionMessage({ version: 0 });
    const withPayer = setTransactionMessageFeePayer(address(from), message);
    const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(blockhashValue), lastValidBlockHeight },
      withPayer,
    );
    const withIxs = appendTransactionMessageInstructions([...instructions], withLifetime);
    const compiled = compileTransactionMessage(withIxs);
    const messageBytes = new Uint8Array(getCompiledTransactionMessageEncoder().encode(compiled));
    if (messageBytes.length > MAX_MESSAGE_BYTES) {
      throw new Error(
        `compiled message is ${messageBytes.length} bytes (max ${MAX_MESSAGE_BYTES})`,
      );
    }
    return { messageBytes, instructions };
  }

  /** Percentile-tiered prioritization fees over the writable accounts of this transaction. */
  async estimateFee(
    rpc: SolanaRpc,
    writable: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<SolanaFeeQuote>> {
    const result = await this.rpc(rpc, "getRecentPrioritizationFees", [[...writable]]);
    const fees = (Array.isArray(result) ? result : [])
      .flatMap((r: unknown) => {
        const fee = obj(r)?.["prioritizationFee"];
        return fee === undefined ? [] : [Number(fee)];
      })
      .sort((a, b) => a - b);
    const pick = (p: number): bigint =>
      BigInt(fees[Math.min(fees.length - 1, Math.floor((fees.length * p) / 100))] ?? 0);
    return [
      { tier: "slow", microLamportsPerCu: pick(50) },
      { tier: "normal", microLamportsPerCu: pick(75) },
      { tier: "fast", microLamportsPerCu: pick(90) },
    ];
  }

  /** Prepend CU-limit + CU-price budget instructions; returns message bytes for the sign request. */
  applyFee(tx: SolanaUnsignedTransaction, fee: SolanaFeeQuote): Uint8Array {
    const units = Math.ceil((tx.unitsConsumed === 0 ? CU_SIMULATE_LIMIT : tx.unitsConsumed) * 1.1);
    const compiled = this.compile(
      tx.from,
      [
        getSetComputeUnitLimitInstruction({ units }),
        getSetComputeUnitPriceInstruction({ microLamports: fee.microLamportsPerCu }),
        ...tx.instructions,
      ],
      tx.blockhash,
      tx.lastValidBlockHeight,
    );
    return compiled.messageBytes;
  }

  /** Wire transaction bytes from the kernel signature — broadcastable via sendTransaction. */
  finalize(messageBytes: Uint8Array, signature: Uint8Array): Uint8Array {
    const out = new Uint8Array(1 + signature.length + messageBytes.length);
    out[0] = 1;
    out.set(signature, 1);
    out.set(messageBytes, 1 + signature.length);
    return out;
  }

  async broadcast(rpc: SolanaRpc, wireBytes: Uint8Array): Promise<string> {
    const result = await this.rpc(rpc, "sendTransaction", [
      b64(wireBytes),
      { encoding: "base64", skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" },
    ]);
    if (typeof result !== "string") {
      throw new TypeError("sendTransaction returned a malformed signature");
    }
    return result;
  }

  /** Processed → confirmed → finalized; an error on the status means the tx failed on-chain. */
  async status(
    rpc: SolanaRpc,
    signature: string,
  ): Promise<"pending" | "confirmed" | "finalized" | "failed"> {
    const result = obj(
      await this.rpc(rpc, "getSignatureStatuses", [
        [signature],
        { searchTransactionHistory: true },
      ]),
    );
    const entry = Array.isArray(result?.["value"]) ? obj(result["value"][0]) : undefined;
    if (entry === undefined) {
      return "pending";
    }
    if (entry["err"] !== null && entry["err"] !== undefined) {
      return "failed";
    }
    const c = entry["confirmationStatus"];
    return c === "finalized" ? "finalized" : c === "confirmed" ? "confirmed" : "pending";
  }

  async blockHeight(rpc: SolanaRpc): Promise<bigint> {
    const result = await this.rpc(rpc, "getBlockHeight", [{ commitment: "confirmed" }]);
    return BigInt(str(result, "0"));
  }
}
