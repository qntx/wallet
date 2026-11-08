/**
 * Per-chain route interface: each family module owns build → sign → broadcast and its status poll;
 * the controller owns lifecycle, persistence and the polling timer.
 */
import type { SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import type { decodeEvm } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import type { EvmFeeTier } from "../chains/evm.ts";
import type { SolanaFeeTier } from "../chains/solana.ts";
import { errorMessage } from "../errors.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { SimulationOutcome } from "../requests/simulation.ts";
import type { EngineStore } from "../store/port.ts";
import type { SwapQuote } from "../swaps/index.ts";

export type ChainApis = ReturnType<typeof chains>;
export type SignParams = Parameters<ChainApis["sign"]>[0];
export type SignResult = Awaited<ReturnType<ChainApis["sign"]>>;
export type AccountRef = Exclude<SignParams["request"], { kind: "bitcoin.psbt" }>["account"];
export type DisplayIntent = ReturnType<typeof decodeEvm>;

export type TxState =
  | "draft"
  | "signed"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "rejected"
  | "dropped"
  | "replaced";

/** A bitcoin transaction that funds the wallet's own Spark account; it is claimed once confirmed. */
export type SparkDepositTag = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly network: SparkNetwork;
  readonly claimed?: boolean;
};

export type TrackedTransaction = {
  readonly id: string;
  readonly family: "evm" | "solana" | "bitcoin";
  readonly network: string;
  readonly account: string;
  readonly hash: string | undefined;
  readonly state: TxState;
  readonly intent: DisplayIntent | undefined;
  readonly nonce: number;
  /** Solana only — the blockhash expiry that turns an unconfirmed tx `dropped`. */
  readonly lastValidBlockHeight?: number;
  /** EVM replacement — the earlier transaction this one bumps or cancels. */
  readonly replaces?: string;
  /** CPFP — the unconfirmed parent this child pushes. */
  readonly parentId?: string;
  /** Set on a Spark deposit; `claimed` flips once the deposit is credited on Spark. */
  readonly sparkDeposit?: SparkDepositTag;
  /** EVM build record persisted at broadcast for rebroadcast, drop detection and replacement. */
  readonly evm?: { readonly from: string; readonly groupIndex: number; readonly raw: string };
  /** Bitcoin build record persisted at send for RBF/CPFP rebuilds. */
  readonly btc?: {
    readonly inputs: ReadonlyArray<{
      readonly txid: string;
      readonly vout: number;
      readonly value: number;
      readonly address: string;
    }>;
    readonly outputs: ReadonlyArray<{
      readonly address: string;
      readonly value: number;
      readonly own: boolean;
    }>;
    readonly vsize: number;
    readonly fee: number;
    readonly feeRate: number;
  };
  readonly submittedAt: number;
  readonly error: string | undefined;
};

export type SendParams = {
  readonly account: AccountRef;
  readonly network: string;
  readonly to: string;
  readonly amount: bigint;
  /** ERC-20 contract — when set, `to`/`amount` are the transfer recipient/units and value is 0. */
  readonly token?: string;
  readonly fee: EvmFeeTier | SolanaFeeTier;
  /** SPL mint decimals — required when `token` is a Solana mint. */
  readonly decimals?: number;
  readonly verify: SignParams["verify"];
};

export type PrepareParams = Omit<SendParams, "verify">;

export type ChainRequestMethod =
  | "send"
  | "speed-up"
  | "cancel"
  | "cpfp"
  | "evm-delegation"
  | "evm-batch"
  | "evm-approve"
  | "evm-swap"
  | "solana-stake";

/** What a request asks for; replacements and CPFP name the original transaction. */
export type ChainRequestInput =
  | ({ readonly method: "send" } & PrepareParams)
  | { readonly method: "speed-up" | "cancel"; readonly txId: string }
  | { readonly method: "cpfp"; readonly txId: string; readonly feeRate: number }
  | {
      readonly method: "evm-delegation";
      readonly account: AccountRef;
      readonly network: string;
      readonly action: "upgrade" | "revoke";
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "evm-batch";
      readonly account: AccountRef;
      readonly network: string;
      readonly calls: ReadonlyArray<{
        readonly to: string;
        readonly value: bigint;
        readonly data: string;
      }>;
      readonly fee: PrepareParams["fee"];
      /** A page asking for the batch (`wallet_sendCalls`); absent means the wallet itself. */
      readonly origin?: { readonly kind: "browser"; readonly origin: string };
    }
  | {
      readonly method: "evm-approve";
      readonly account: AccountRef;
      readonly network: string;
      readonly token: string;
      readonly spender: string;
      readonly amount: bigint;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "evm-swap";
      readonly account: AccountRef;
      readonly network: string;
      readonly quote: SwapQuote;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "solana-stake";
      readonly account: AccountRef;
      readonly network: string;
      readonly action:
        | { readonly kind: "delegate"; readonly lamports: bigint; readonly vote: string }
        | { readonly kind: "deactivate"; readonly stakeAccount: string }
        | {
            readonly kind: "withdraw";
            readonly stakeAccount: string;
            readonly lamports: bigint;
          };
      readonly fee: PrepareParams["fee"];
    };

/** At most this many calls per batch — one approval stays reviewable. */
export const EVM_BATCH_LIMIT = 10;

/**
 * One `wallet_sendCalls` bundle: the tracked transactions it produced so `wallet_getCallsStatus`
 * can aggregate them, retained alongside those transactions.
 */
export type BatchRecord = {
  readonly origin: string;
  readonly id: string;
  readonly network: string;
  readonly atomic: boolean;
  readonly txIds: ReadonlyArray<string>;
  readonly expected: number;
  readonly createdAt: number;
};

/** The account's EIP-7702 delegation state: `supported` follows the registry hash entry. */
export type DelegationStatus = {
  readonly supported: boolean;
  readonly state: "none" | "ours" | "other";
  readonly address?: string;
};

/**
 * A fully built, estimated and cross-checked send that has not been signed. The unsigned content
 * lives in the closures and cannot change after `prepare` returns.
 */
export type PreparedRequest = {
  /** Id of the tracked transaction `submit` creates. */
  readonly txId: string;
  readonly account: AccountRef;
  readonly network: string;
  /** The transaction being replaced or accelerated; absent for a plain send. */
  readonly target?: string;
  readonly intent: DisplayIntent;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  /** Absent when the request is not simulated (replacements, Bitcoin). */
  readonly simulation?: SimulationOutcome;
  /** Re-runs the same simulated call at approval; absent when there is nothing to re-run. */
  readonly resimulate?: () => Promise<SimulationOutcome>;
  /** Why the build can no longer be signed (nonce taken, blockhash expired), if so. */
  readonly staleReason: () => string | undefined | Promise<string | undefined>;
  /** Signs, finalizes, broadcasts and hands the transaction to tracking. */
  readonly submit: (verify: SendParams["verify"]) => Promise<TrackedTransaction>;
  /** Frees what `prepare` reserved; safe to call more than once. */
  readonly release: () => void;
};

export type SignatureResult = {
  readonly kind: "evm.personal-message" | "evm.typed-data";
  readonly signature: Uint8Array;
};

/** A prepared message signature: nothing is broadcast or tracked, `submit` returns the signature. */
export type PreparedMessage = Omit<PreparedRequest, "submit" | "txId"> & {
  /** The address that will sign. */
  readonly signer: string;
  readonly submit: (verify: SendParams["verify"]) => Promise<SignatureResult>;
};

export type Options = {
  readonly wallet: Wallet;
  readonly networks: NetworkController;
  readonly openStore: () => Promise<EngineStore>;
  readonly random: (n: number) => Uint8Array;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly pollMs?: number;
  /** Test seam — defaults to the wallet's real chains proxy. */
  readonly chains?: ReturnType<typeof chains>;
};

export type RouteContext = {
  readonly options: Options;
  readonly transition: (
    tx: TrackedTransaction,
    next: Partial<TrackedTransaction>,
  ) => Promise<TrackedTransaction>;
  readonly track: (id: string, hash: string) => void;
  /** Every tracked transaction, for approval-time checks on a replacement's original. */
  readonly txs: () => Readonly<Record<string, TrackedTransaction>>;
  readonly newId: () => string;
};

const hexId = (prefix: string, random: (n: number) => Uint8Array): string =>
  `${prefix}-${[...random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

export const newId = (random: (n: number) => Uint8Array): string => hexId("tx", random);

/** The account's address; signer-dependent checks fail closed when an account carries none. */
export const accountAddress = (account: Readonly<Record<string, unknown>>): string => {
  const { address } = account;
  if (typeof address !== "string" || address === "") {
    throw new Error("account carries no address");
  }
  return address;
};

export const newRequestId = (random: (n: number) => Uint8Array): string => hexId("req", random);

export { errorMessage } from "../errors.ts";

const LIVE_REPLACEMENT_STATES: ReadonlySet<TxState> = new Set([
  "draft",
  "signed",
  "submitted",
  "pending",
]);

/**
 * Approval-time check for a replacement: the original must still be unconfirmed and no other
 * replacement of it may already be on its way.
 */
export const replacementStaleReason = (
  ctx: RouteContext,
  originalId: string,
): string | undefined => {
  const txs = ctx.txs();
  const original = txs[originalId];
  if (original?.state !== "submitted" && original?.state !== "pending") {
    return "original transaction already finished — nothing to replace";
  }
  const replaced = Object.values(txs).some(
    (t) => t.replaces === originalId && LIVE_REPLACEMENT_STATES.has(t.state),
  );
  return replaced ? "original transaction was already replaced — start over" : undefined;
};

export const submitTx = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  hash: string,
): Promise<TrackedTransaction> => {
  const tracked = await ctx.transition(tx, {
    state: "submitted",
    hash,
    submittedAt: ctx.options.now(),
  });
  ctx.track(tracked.id, hash);
  return tracked;
};

export const failTx = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  error: unknown,
): Promise<void> => {
  const failed = tx.state === "signed" ? "failed" : "rejected";
  await ctx.transition(tx, { state: failed, error: errorMessage(error) });
};
