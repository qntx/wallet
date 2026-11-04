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
  getAddressDecoder,
  getCompiledTransactionMessageEncoder,
  getU64Decoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";

import {
  PROGRAM_IDS,
  SOLANA_NATIVE_ASSET,
  parseCompiledMessage,
  solanaTokenTable,
} from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../networks/controller.ts";
import { boundedSimulation } from "../requests/simulation.ts";
import type { AssetChange, SimulationOutcome } from "../requests/simulation.ts";

/** Token-2022 program id — the mint's owner for extension mints. */
export const TOKEN_2022_PROGRAM: string = PROGRAM_IDS.token2022;

const MAX_MESSAGE_BYTES = 1232;
const LOOKUP_TABLE_HEADER_BYTES = 56;
const ADDRESS_BYTES = 32;
const TOKEN_ACCOUNT_MIN_BYTES = 72;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

const addressDecoder = getAddressDecoder();

type RawAccount = {
  readonly lamports: bigint;
  readonly owner: string;
  readonly data: Uint8Array;
};

const parseAccount = (value: unknown): RawAccount | undefined => {
  const record = obj(value);
  const data = record?.["data"];
  if (
    record === undefined ||
    !Array.isArray(data) ||
    typeof data[0] !== "string" ||
    typeof record["owner"] !== "string"
  ) {
    return undefined;
  }
  return {
    lamports: BigInt(str(record["lamports"])),
    owner: record["owner"],
    data: base64.decode(data[0]),
  };
};

const accountList = (value: unknown): ReadonlyArray<RawAccount | undefined> => {
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  return list.map(parseAccount);
};

const u64Decoder = getU64Decoder();
const readU64 = (data: Uint8Array, offset: number): bigint => u64Decoder.decode(data, offset);

/** Token and Token-2022 accounts owned by `owner`: balance per mint. */
const tokenBalances = (
  watch: ReadonlyArray<string>,
  accounts: ReadonlyArray<RawAccount | undefined>,
  owner: string,
): Map<string, bigint> => {
  const balances = new Map<string, bigint>();
  for (const [index, account] of accounts.entries()) {
    if (
      watch[index] === undefined ||
      account === undefined ||
      (account.owner !== PROGRAM_IDS.token && account.owner !== PROGRAM_IDS.token2022) ||
      account.data.length < TOKEN_ACCOUNT_MIN_BYTES ||
      addressDecoder.decode(
        account.data.slice(TOKEN_ACCOUNT_OWNER_OFFSET, TOKEN_ACCOUNT_OWNER_OFFSET + ADDRESS_BYTES),
      ) !== owner
    ) {
      continue;
    }
    const mint = addressDecoder.decode(account.data.slice(0, ADDRESS_BYTES));
    balances.set(
      mint,
      (balances.get(mint) ?? 0n) + readU64(account.data, TOKEN_ACCOUNT_AMOUNT_OFFSET),
    );
  }
  return balances;
};

const CU_SIMULATE_LIMIT = 1_400_000;

export type SolanaIntent =
  | { readonly kind: "sol"; readonly to: string; readonly lamports: bigint }
  | {
      readonly kind: "spl";
      readonly mint: string;
      readonly to: string;
      readonly amount: bigint;
      readonly decimals: number;
      /** Token-2022 mints carry the TokenzQd owner — defaults to the classic SPL program. */
      readonly tokenProgram?: string;
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
    const tokenProgram =
      intent.tokenProgram === undefined ? TOKEN_PROGRAM_ADDRESS : address(intent.tokenProgram);
    const [sourceAta] = await findAssociatedTokenPda({
      mint: address(intent.mint),
      owner: address(from),
      tokenProgram,
    });
    const [destAta] = await findAssociatedTokenPda({
      mint: address(intent.mint),
      owner: address(intent.to),
      tokenProgram,
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
          tokenProgram,
        }),
      );
    }
    ixs.push(
      getTransferCheckedInstruction(
        {
          source: sourceAta,
          mint: address(intent.mint),
          destination: destAta,
          authority: address(from),
          amount: intent.amount,
          decimals: intent.decimals,
        },
        { programAddress: tokenProgram },
      ),
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
    const units = await this.simulateUnits(rpc, compiled.messageBytes);
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

  /** Unsigned wire bytes: one zeroed signature per required signer, then the message. */
  private wireBytes(messageBytes: Uint8Array): Uint8Array {
    const { numRequiredSignatures } = parseCompiledMessage(messageBytes);
    return this.finalize(
      messageBytes,
      Array.from({ length: numRequiredSignatures }, () => new Uint8Array(64)),
    );
  }

  private async simulateUnits(rpc: SolanaRpc, messageBytes: Uint8Array): Promise<number> {
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

  /**
   * Simulates `message` for `owner`: lamports and Token/Token-2022 balance changes of the owner's
   * accounts from account state read before and returned after `simulateTransaction`. The two reads
   * are not atomic. A node error or the 10 s timeout is `unavailable`.
   */
  async simulate(
    rpc: SolanaRpc,
    network: string,
    owner: string,
    message: Uint8Array,
    setTimer: (ms: number, fn: () => unknown) => () => void,
  ): Promise<SimulationOutcome> {
    return boundedSimulation(
      async () => this.simulateAccounts(rpc, network, owner, message),
      setTimer,
    );
  }

  private async lookupWritable(
    rpc: SolanaRpc,
    lookups: ReturnType<typeof parseCompiledMessage>["lookups"],
  ): Promise<string[]> {
    if (lookups.length === 0) {
      return [];
    }
    const result = obj(
      await this.rpc(rpc, "getMultipleAccounts", [
        lookups.map((lookup) => lookup.address),
        { encoding: "base64", commitment: "confirmed" },
      ]),
    );
    const tables = accountList(result?.["value"]);
    const writable: string[] = [];
    for (const [index, lookup] of lookups.entries()) {
      const data = tables[index]?.data;
      if (data === undefined) {
        throw new Error(`lookup table ${lookup.address} not found`);
      }
      for (const entry of lookup.writableIndexes) {
        const start = LOOKUP_TABLE_HEADER_BYTES + entry * ADDRESS_BYTES;
        if (start + ADDRESS_BYTES > data.length) {
          throw new Error("lookup table index out of range");
        }
        writable.push(addressDecoder.decode(data.slice(start, start + ADDRESS_BYTES)));
      }
    }
    return writable;
  }

  private async simulateAccounts(
    rpc: SolanaRpc,
    network: string,
    owner: string,
    message: Uint8Array,
  ): Promise<SimulationOutcome> {
    const parsed = parseCompiledMessage(message);
    const watch = [
      ...new Set([...parsed.staticAccounts, ...(await this.lookupWritable(rpc, parsed.lookups))]),
    ];
    const before = obj(
      await this.rpc(rpc, "getMultipleAccounts", [
        watch,
        { encoding: "base64", commitment: "confirmed" },
      ]),
    );
    const result = obj(
      await this.rpc(rpc, "simulateTransaction", [
        b64(this.wireBytes(message)),
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
          accounts: { addresses: watch, encoding: "base64" },
        },
      ]),
    );
    const value = obj(result?.["value"]);
    if (value?.["err"] !== null && value?.["err"] !== undefined) {
      const logs = Array.isArray(value["logs"]) ? (value["logs"] as unknown[]) : [];
      const last = logs.at(-1);
      return {
        status: "reverted",
        error: `${JSON.stringify(value["err"])}${typeof last === "string" ? ` (${last})` : ""}`,
      };
    }
    const pre = accountList(before?.["value"]);
    const post = accountList(value?.["accounts"]);
    const changes: AssetChange[] = [];
    const ownerIndex = watch.indexOf(owner);
    if (ownerIndex !== -1) {
      const delta = (post[ownerIndex]?.lamports ?? 0n) - (pre[ownerIndex]?.lamports ?? 0n);
      if (delta !== 0n) {
        changes.push({ asset: SOLANA_NATIVE_ASSET, amount: delta.toString(10), verified: true });
      }
    }
    const was = tokenBalances(watch, pre, owner);
    const now = tokenBalances(watch, post, owner);
    for (const mint of new Set([...was.keys(), ...now.keys()])) {
      const delta = (now.get(mint) ?? 0n) - (was.get(mint) ?? 0n);
      if (delta === 0n) {
        continue;
      }
      const known = solanaTokenTable[network]?.[mint];
      changes.push({
        asset: mint,
        amount: delta.toString(10),
        ...(known === undefined
          ? { verified: false }
          : { decimals: known.decimals, symbol: known.symbol, verified: true }),
      });
    }
    return { status: "success", changes };
  }

  /** Wire transaction bytes — sigCount shortvec + each 64-byte sig + message. */
  finalize(messageBytes: Uint8Array, signatures: ReadonlyArray<Uint8Array>): Uint8Array {
    for (const sig of signatures) {
      if (sig.length !== 64) {
        throw new Error(`solana signature must be 64 bytes, got ${sig.length}`);
      }
    }
    const out = new Uint8Array(1 + 64 * signatures.length + messageBytes.length);
    out[0] = signatures.length;
    for (const [i, sig] of signatures.entries()) {
      out.set(sig, 1 + 64 * i);
    }
    out.set(messageBytes, 1 + 64 * signatures.length);
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
