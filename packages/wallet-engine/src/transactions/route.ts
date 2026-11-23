/**
 * Per-chain route interface: each family module owns build → sign → broadcast and its status poll;
 * the controller owns lifecycle, persistence and the polling timer.
 */
import type { SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { ChainError } from "@qntx/wallet-chains";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import type { decodeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import type { EvmFeeTier } from "../chains/evm.ts";
import type { SolanaFeeTier } from "../chains/solana.ts";
import type { TronFeeQuote } from "../chains/tron.ts";
import { errorMessage } from "../errors.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { NetworkInfo } from "../networks/registry.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { RiskFinding } from "../requests/risk.ts";
import type { SimulationOutcome } from "../requests/simulation.ts";
import type { DappOrigin } from "../requests/types.ts";
import type { EngineStore } from "../store/port.ts";
import type { AcrossBridgeQuote } from "../swaps/bridge.ts";
import type { JupiterSwapQuote, ZeroExSwapQuote } from "../swaps/index.ts";

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

/** Where an on-chain transaction sits, as its tracker last saw it. */
export type TxBlock = {
  /** Block hash; absent on Solana, whose status answer names only the slot. */
  readonly hash?: string;
  /** Block number (EVM), height (Bitcoin) or slot (Solana). */
  readonly height: number;
};

/**
 * What one status poll established; a poll returning `undefined` changes nothing. `included` is a
 * transaction in a block — kept tracked until `final`; `reorged` is its block leaving the chain;
 * `ended` is a terminal answer the tracker stops on. `waiting` is still live: its `error` says why
 * the transaction cannot land yet, `undefined` clears an earlier note; `stuck` marks a row no
 * endpoint has known for `STUCK_AFTER_MS` — a live mark, never terminal.
 */
export type TxPoll =
  | {
      readonly kind: "included";
      readonly state: "confirmed" | "failed";
      readonly block: TxBlock;
      readonly final: boolean;
      /** An on-chain failure's reason (receipt result plus burned fee), persisted on the row. */
      readonly error?: string;
    }
  | { readonly kind: "reorged" }
  | { readonly kind: "ended"; readonly state: "failed" | "dropped" | "replaced" }
  | {
      readonly kind: "waiting";
      readonly error: string | undefined;
      /** Set only when the mark is on; an absent `stuck` clears it — see `TrackedTransaction.stuck`. */
      readonly stuck?: boolean;
    };

/** In a block but not final yet: tracked at the finality interval. */
export const awaitingFinality = (tx: TrackedTransaction): boolean =>
  tx.block !== undefined &&
  tx.final !== true &&
  (tx.state === "confirmed" || tx.state === "failed");

/**
 * The recheck answer for a transaction already in `tx.block`: `undefined` when state, block and
 * finality are unchanged. Hashes compare lowercase.
 */
export const includedPoll = (
  tx: TrackedTransaction,
  state: "confirmed" | "failed",
  block: TxBlock,
  final: boolean,
  error?: string,
): TxPoll | undefined =>
  tx.state === state &&
  tx.final === final &&
  tx.block?.height === block.height &&
  tx.block.hash?.toLowerCase() === block.hash?.toLowerCase()
    ? undefined
    : { kind: "included", state, block, final, ...(error === undefined ? {} : { error }) };

/** A bitcoin transaction that funds the wallet's own Spark account; it is claimed once confirmed. */
export type SparkDepositTag = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly network: SparkNetwork;
  readonly claimed?: boolean;
};

export type TrackedTransaction = {
  readonly id: string;
  readonly family: "evm" | "solana" | "bitcoin" | "tron";
  readonly network: string;
  /** The signer's identity label — `walletId` for HD accounts, `keyId` for imported keys. */
  readonly account: string;
  readonly hash: string | undefined;
  readonly state: TxState;
  readonly intent: DisplayIntent | undefined;
  readonly nonce: number;
  /**
   * The block a `confirmed` or on-chain `failed` transaction is in; cleared when a reorg returns it
   * to `submitted`.
   */
  readonly block?: TxBlock | undefined;
  /**
   * Past the network's finality rule (EVM `finalized` tag, 6 Bitcoin confirmations, Solana
   * `finalized`): never changes again, no longer polled.
   */
  readonly final?: boolean | undefined;
  /** Solana only — the blockhash expiry that turns an unconfirmed tx `dropped`. */
  readonly lastValidBlockHeight?: number;
  /**
   * Solana only — a durable-nonce transaction has no block-height expiry: `account` is the nonce
   * account and `value` the nonce its first instruction advances, read back on each poll. `account`
   * is undefined when the message loads it from a lookup table: nothing to read on it, so the
   * transaction is never dropped — only resolved by landing.
   */
  readonly durableNonce?: { readonly account: string | undefined; readonly value: string };
  /**
   * TRON build record — `raw_data.expiration` bounds drop proofs (past it the network can never
   * include the transaction); `from` is the sender, for group membership like `evm.from`.
   * `dappSignature` is set on a dApp-observed entry: the wallet-signed signature (lowercase hex)
   * `submitDappTron` later matches against the bytes the dApp broadcasts.
   */
  readonly tron?: {
    readonly expiration: number;
    readonly from: string;
    readonly dappSignature?: string;
  };
  /** EVM replacement — the earlier transaction this one bumps or cancels. */
  readonly replaces?: string;
  /** CPFP — the unconfirmed parent this child pushes. */
  readonly parentId?: string;
  /** Set on a Spark deposit; `claimed` flips once the deposit is credited on Spark. */
  readonly sparkDeposit?: SparkDepositTag;
  /**
   * Absent: the tracker may rebroadcast the persisted bytes while the network does not know them.
   * `false`: recovered from a broadcast whose outcome never settled — it may have been refused — so
   * the bytes are watched but never resent; a speed-up or cancel is the remedy.
   */
  readonly rebroadcast?: false;
  /**
   * EVM and Bitcoin: neither endpoint has known this transaction for `STUCK_AFTER_MS`. It stays
   * `submitted`, still holds its nonce or inputs and is polled at the finality interval; offer
   * speed-up or cancel.
   */
  readonly stuck?: boolean | undefined;
  /**
   * The signed transaction exactly as broadcast — EVM and Bitcoin hex, Solana base64 wire —
   * persisted with `hash` before it leaves, so an unknown outcome is rebroadcast, even after a
   * restart. Cleared when the node refuses it.
   */
  readonly raw?: string | undefined;
  /** EVM build record persisted with `raw`, for drop detection and replacement. */
  readonly evm?: { readonly from: string; readonly account: AccountRef };
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
    /** The account shape the transaction was built from — needed to rebuild it after a restart. */
    readonly template: BitcoinAccountTemplate;
    readonly groupIndex: number;
    readonly tier: "fast" | "normal" | "slow";
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
  /**
   * Bitcoin only — the exact outpoints (`txid:vout`) this send spends; omit for automatic
   * selection. Naming an inscription-protected output opts into spending it.
   */
  readonly inputs?: ReadonlyArray<string>;
  /** TRON only — the `raw_data.data` memo; refused on every other family. */
  readonly memo?: string;
  readonly verify: SignParams["verify"];
};

export type PrepareParams = Omit<SendParams, "verify">;

export type { ChainRequestMethod } from "../requests/types.ts";

/** What a request asks for; replacements and CPFP name the original transaction. */
export type ChainRequestInput =
  | ({ readonly method: "send"; readonly origin?: DappOrigin } & PrepareParams)
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
      readonly origin?: DappOrigin;
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
      /** The Hyperliquid CCTP deposit — `depositForBurnWithHook` on the route's messenger. */
      readonly method: "evm-cctp";
      readonly account: AccountRef;
      readonly network: string;
      readonly amount: bigint;
      readonly dex: "perps" | "spot";
      /** The Circle forward fee bound — strictly below `amount`. */
      readonly maxFee: bigint;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "evm-swap";
      readonly account: AccountRef;
      readonly network: string;
      readonly quote: ZeroExSwapQuote;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "evm-bridge";
      readonly account: AccountRef;
      readonly network: string;
      readonly quote: AcrossBridgeQuote;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "evm-nft-send";
      readonly account: AccountRef;
      readonly network: string;
      /** The ERC-721 or ERC-1155 contract. */
      readonly contract: string;
      /** The ids sent — one for ERC-721, up to `EVM_BATCH_LIMIT` for ERC-1155. */
      readonly items: ReadonlyArray<{ readonly tokenId: bigint; readonly amount?: bigint }>;
      readonly to: string;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "solana-core-send";
      readonly account: AccountRef;
      readonly network: string;
      /** The Core asset account. */
      readonly asset: string;
      readonly to: string;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "solana-swap";
      readonly account: AccountRef;
      readonly network: string;
      readonly quote: JupiterSwapQuote;
      readonly fee: PrepareParams["fee"];
    }
  | {
      readonly method: "evm-lido";
      readonly account: AccountRef;
      readonly network: string;
      readonly action:
        | { readonly kind: "stake"; readonly amount: bigint }
        | { readonly kind: "request"; readonly amount: bigint }
        | { readonly kind: "claim"; readonly requestIds: ReadonlyArray<bigint> };
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
    }
  | {
      readonly method: "tron-stake";
      readonly account: AccountRef;
      readonly network: string;
      readonly action:
        | {
            readonly kind: "freeze" | "unfreeze";
            readonly amount: bigint;
            readonly resource: "bandwidth" | "energy";
          }
        | { readonly kind: "withdraw-expired" }
        | { readonly kind: "cancel-unfreeze" }
        | {
            readonly kind: "delegate";
            readonly receiver: string;
            readonly amount: bigint;
            readonly resource: "bandwidth" | "energy";
            /** Lock the delegation for this many blocks (1..getMaxDelegateLockPeriod). */
            readonly lockBlocks?: number;
          }
        | {
            readonly kind: "undelegate";
            readonly receiver: string;
            readonly amount: bigint;
            readonly resource: "bandwidth" | "energy";
          }
        | {
            readonly kind: "vote";
            readonly votes: ReadonlyArray<{ readonly witness: string; readonly count: bigint }>;
          }
        | { readonly kind: "claim-rewards" };
    }
  | {
      readonly method: "tron-approve";
      readonly account: AccountRef;
      readonly network: string;
      readonly token: string;
      readonly spender: string;
      /** The new allowance in token units; 0 revokes. */
      readonly amount: bigint;
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
  /** The address the route resolved for `account` — what recipient risk calls self. */
  readonly signer?: string;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  /** Findings a route can only see on-chain (contract recipient, empty token balance). */
  readonly risk?: ReadonlyArray<RiskFinding>;
  /** The TRON fee quote — the intent's fee field carries only `fee_limit`. */
  readonly tronFee?: TronFeeQuote;
  /** Absent when the request is not simulated (replacements, Bitcoin). */
  readonly simulation?: SimulationOutcome;
  /** Re-runs the same simulated call at approval; absent when there is nothing to re-run. */
  readonly resimulate?: () => Promise<SimulationOutcome>;
  /** Why the build can no longer be signed (nonce taken, blockhash expired), if so. */
  readonly staleReason: () => string | undefined | Promise<string | undefined>;
  /**
   * Signs, finalizes, broadcasts and hands the transaction to tracking. `commit` must run
   * immediately (no await in between) before the network send; a throw there means nothing may be
   * sent.
   */
  readonly submit: (
    verify: SendParams["verify"],
    commit: () => void,
  ) => Promise<TrackedTransaction>;
  /** Frees what `prepare` reserved; safe to call more than once. */
  readonly release: () => void;
};

export type SignatureResult = {
  readonly kind: "evm.personal-message" | "evm.typed-data" | "tron.message" | "tron.typed-data";
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
  /** The session EngineStore — the engine opens it once per unlock and closes it on lock. */
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
  /**
   * Applies `next` to `tx` and persists the row. A locked vault keeps the row out of state but
   * retains it for replay at the next unlock — unless `durable`, which throws instead: signed bytes
   * must be on disk before they leave. Only a durable call may throw on a store failure: a failed
   * non-durable write is retained and landed by the controller's own retry loop, since the bytes it
   * describes may already be out. The context belongs to the session that created it: after a
   * lock→unlock its calls are ignored (`durable` still throws), so a stale async result never
   * writes into the new session.
   */
  readonly transition: (
    tx: TrackedTransaction,
    next: Partial<TrackedTransaction>,
    durable?: boolean,
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

/**
 * The chain binding of signed bytes (a TRON reference block, a Solana recent blockhash) is the only
 * thing keeping a transaction off the wrong chain. On a mainnet the binding needs no second source:
 * a binding from another chain makes the signature invalid on the mainnet, so nothing of more value
 * than the user chose can move — the build goes ahead flagged `reads-unverified`. On a testnet the
 * same attack inverts: a binding taken from the mainnet produces a signature valid on the mainnet
 * and moves real value, so a gateway-only testnet build is refused and a host endpoint must be
 * configured.
 */
export const assertGatewayOnlyBinding = (info: NetworkInfo, binding: string): void => {
  if (info.testnet) {
    throw new ChainError("invalid-request", gatewayOnlyBindingMessage(info, binding));
  }
};

/** The refusal {@link assertGatewayOnlyBinding} throws — shared by typed binding errors. */
export const gatewayOnlyBindingMessage = (info: NetworkInfo, binding: string): string =>
  `only the gateway vouches for the ${binding} on ${info.id}; on a testnet a signature over another network's ${binding} could be valid there — configure a host endpoint in EngineOptions.rpc["${info.id}"]`;

const TEMPLATE_FAMILY = {
  "evm.bip44": "evm",
  "solana.bip44-change": "solana",
  "tron.bip44": "tron",
} as const;

/**
 * The signer address for a send/sign account ref: HD refs derive through the chains proxy; an
 * imported ref resolves its stored address from `wallet.keys` — the ref's family and the key's
 * listed family must both match the network's family or the request is refused.
 */
export const accountAddressOf = async (
  ctx: RouteContext,
  account: AccountRef,
  template: keyof typeof TEMPLATE_FAMILY,
  network: string,
): Promise<string> => {
  const family = TEMPLATE_FAMILY[template];
  if (account.kind === "imported") {
    if (account.family !== family) {
      throw new ChainError(
        "invalid-request",
        `an imported ${account.family} key cannot sign on a ${family} network`,
      );
    }
    const keys = await ctx.options.wallet.keys.list();
    const key = keys.find((entry) => entry.keyId === account.keyId);
    if (key === undefined) {
      throw new ChainError("invalid-request", "the imported key is not in the vault");
    }
    if (key.family !== family) {
      throw new ChainError(
        "invalid-request",
        `the imported key is a ${key.family} key, not ${family}`,
      );
    }
    return key.address;
  }
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  return accountAddress(
    await apis.account({
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template,
      network,
    }),
  );
};

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
