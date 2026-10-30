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
  readonly newId: () => string;
};

export const newId = (random: (n: number) => Uint8Array): string =>
  `tx-${[...random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
