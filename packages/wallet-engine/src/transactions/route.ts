/**
 * Per-chain route interface: each family module owns build → sign → broadcast and its status poll;
 * the controller owns lifecycle, persistence and the polling timer.
 */
import type { Wallet } from "@qntx/wallet";
import type { decodeEvm } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import type { EvmFeeTier } from "../chains/evm.ts";
import type { SolanaFeeTier } from "../chains/solana.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { EngineStore } from "../store/port.ts";

export type SignParams = Parameters<ReturnType<typeof chains>["sign"]>[0];
export type AccountRef = SignParams["request"]["account"];
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

export type ChainRequestMethod = "send" | "speed-up" | "cancel" | "cpfp";

/** What a request asks for; replacements and CPFP name the original transaction. */
export type ChainRequestInput =
  | ({ readonly method: "send" } & PrepareParams)
  | { readonly method: "speed-up" | "cancel"; readonly txId: string }
  | { readonly method: "cpfp"; readonly txId: string; readonly feeRate: number };

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

export const newRequestId = (random: (n: number) => Uint8Array): string => hexId("req", random);

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
