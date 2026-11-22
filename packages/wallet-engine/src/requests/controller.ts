import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Request pipeline for internal sends, speed-ups, cancellations and CPFP: `prepare` builds,
 * estimates and cross-checks without signing; `approve(id, method, options)` is the only way to
 * sign, and only for a live, unexpired request of the right method; locking invalidates everything
 * that has not finished. The unsigned content stays in a private table, never in the state
 * snapshot, and cannot change after prepare.
 */
import type { Event, UnsignedEvent } from "@qntx/nostr";
import { WalletError } from "@qntx/wallet";
import type { NostrKeyRef } from "@qntx/wallet";
import { isBlindIntent, messageBlindReason, parseSignIn } from "@qntx/wallet-chains";
import type { MessageContent, SignInParse, SignRequest } from "@qntx/wallet-chains";
import { decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { checksumEvmAddress, evmTokenTable, lookupEvmToken } from "@qntx/wallet-chains/evm";
import {
  decodeSolana,
  decodeSolanaTransaction,
  normalizeSolana,
  SOLANA_NATIVE_ASSET,
} from "@qntx/wallet-chains/solana";
import { isTronAddress, lookupTronToken, tronTokenTable } from "@qntx/wallet-chains/tron";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { AddressBookController } from "../addresses/controller.ts";
import { normalizeAddress } from "../addresses/normalize.ts";
import type { TronFeeQuote } from "../chains/tron.ts";
import type { SignInFields } from "../connect/siws.ts";
import { utf8Text } from "../connect/text.ts";
import { Controller } from "../controller.ts";
import { TOKEN_SYMBOL_MAX, isAscii, safeDecimals, safeDisplayText } from "../display.ts";
import { errorMessage } from "../errors.ts";
import type { EngineLogger } from "../events.ts";
import { networkById } from "../networks/registry.ts";
import type { PreparedSparkAction, SparkDisplay, SparkResult } from "../payments/action.ts";
import { preparePay } from "../payments/pay.ts";
import type { PayParams } from "../payments/pay.ts";
import { prepareZapAction } from "../payments/zap.ts";
import type { PreparedZap } from "../payments/zap.ts";
import type { PhishingController } from "../phishing/controller.ts";
import { PHISHING_BLOCKED_MESSAGE } from "../phishing/status.ts";
import type { SparkController } from "../spark/controller.ts";
import { SPARK_L1_NETWORK } from "../spark/l1.ts";
import type { EngineStore } from "../store/port.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  DisplayIntent,
  PrepareParams,
  SendParams,
  SignatureResult,
  TrackedTransaction,
} from "../transactions/route.ts";
import { newRequestId } from "../transactions/route.ts";
import { collectChecks, feeReachesAmount } from "./checks.ts";
import type { RequestCheckCode } from "./checks.ts";
import {
  assessApprovals,
  assessBitcoinPsbts,
  assessPermits,
  assessSafe,
  assessSeaport,
  assessSignIn,
  assessRecipients,
  assessSimulation,
  impersonatesBuiltIn,
  impersonatesTronToken,
  mergeRisk,
  originRisk,
  recipientOf,
  verifyRisk,
} from "./risk.ts";
import type { RiskFinding } from "./risk.ts";
import { createSignLog } from "./sign-log.ts";
import type { SignLog, SignLogEntry, SignLogOutcome } from "./sign-log.ts";
import { simulationChanged } from "./simulation.ts";
import type { SimulationOutcome } from "./simulation.ts";
import { nextStage } from "./stage.ts";
import type { RequestEvent, RequestStage } from "./stage.ts";
import {
  InvalidTokenError,
  OriginBusyError,
  RequestEndedError,
  SignInOriginError,
  dappOf,
  dappUrl,
  isAppOrigin,
} from "./types.ts";
import type {
  AppOrigin,
  BitcoinAccount,
  BitcoinGroup,
  BitcoinPsbtInput,
  ChainRequestMethod,
  DappOrigin,
  PreparedBitcoinPsbt,
  RequestMethod,
  RequestOrigin,
  SolanaAccount,
} from "./types.ts";

export {
  InvalidTokenError,
  OriginBusyError,
  RequestEndedError,
  SignInOriginError,
} from "./types.ts";
export type {
  AppOrigin,
  BitcoinAccount,
  BitcoinGroup,
  BrowserOrigin,
  DappOrigin,
  RequestMethod,
  RequestOrigin,
  SolanaAccount,
  WalletConnectOrigin,
  WalletConnectVerify,
} from "./types.ts";

export type { RequestCheckCode } from "./checks.ts";
export type { RiskFinding } from "./risk.ts";
export type { SignLogEntry, SignLogOutcome } from "./sign-log.ts";
export type { SignatureResult } from "../transactions/route.ts";
export type { SparkDisplay, SparkResult } from "../payments/action.ts";

/** A Spark, Lightning (including LNURL-pay and lightning addresses) or cooperative-exit payment. */
export type PayInput = { readonly method: "pay"; readonly origin?: DappOrigin } & PayParams;

/** A prepared zap; its invoice was fetched by `engine.zaps.prepare` and is paid as-is. */
export type ZapInput = {
  readonly method: "zap";
  readonly account: SparkAccountRef;
  readonly zap: PreparedZap;
  readonly maxFeeSats: number;
};

/**
 * A dApp's EVM request: a transaction (rebuilt here with fresh nonce and fees), a personal message
 * or EIP-712 typed data.
 */
export type EvmSignInput = {
  readonly method: "evm-sign";
  /** A page asking for the signature; absent means the wallet itself. */
  readonly origin?: DappOrigin;
  readonly account: AccountRef;
  readonly network: string;
  readonly request: SignRequest;
};

/**
 * A dApp's TRON request: a transaction whose exact `raw_data` bytes are validated and signed
 * unchanged, a TIP-191 message or TIP-712 typed data.
 */
export type TronSignInput = {
  readonly method: "tron-sign";
  /** A page asking for the signature; absent means the wallet itself. */
  readonly origin?: DappOrigin;
  readonly account: AccountRef;
  readonly network: string;
  readonly request: SignRequest;
};

/**
 * Funds the wallet's own Spark account from a bitcoin account of the same wallet; the transaction
 * is an ordinary bitcoin send to a fresh Spark deposit address and is claimed once confirmed.
 */
export type SparkDepositInput = {
  readonly method: "spark-deposit";
  readonly account: SparkAccountRef;
  readonly from: AccountRef;
  readonly amountSats: number;
  readonly fee: PrepareParams["fee"];
};

/** A cooperative exit to the group's own next unused `btc.bip84` receive address. */
export type SparkExitInput = {
  readonly method: "spark-exit";
  readonly account: SparkAccountRef;
  readonly amountSats: number;
  readonly maxFeeSats: number;
  readonly speed?: "FAST" | "MEDIUM" | "SLOW";
};

/**
 * A NIP-07 `signEvent` that the policy sends through the pipeline: no factor on approval (Nostr
 * events are not per-event verifiable, WD-065); the display is the kind, a short content preview
 * and the tag count — the sign log records kind and event id only.
 */
export type NostrSignInput = {
  readonly method: "nostr-sign";
  readonly origin: DappOrigin;
  /** The active identity — the signer the page's pubkey must match. */
  readonly ref: NostrKeyRef;
  readonly event: UnsignedEvent;
};

/**
 * A WebLN `makeInvoice` confirmation: no factor (it only asks the user to confirm generating an
 * invoice — WD-065 does not apply; the factor-free rule mirrors `nostr-sign`), `display` carries
 * the requested amount and memo.
 */
export type WeblnInvoiceInput = {
  readonly method: "webln-invoice";
  readonly origin: DappOrigin;
  readonly ref: SparkAccountRef;
  readonly amountSats: number;
  readonly memo?: string;
};

/**
 * A dApp's `wallet_watchAsset`: confirm adding an ERC-20 token to the tracked list. No factor;
 * `symbol` and `decimals` are read on-chain by the pipeline, never taken from the page.
 */
export type WatchAssetInput = {
  readonly method: "watch-asset";
  readonly origin: DappOrigin;
  readonly account: AccountRef;
  readonly network: string;
  readonly address: string;
};

/**
 * A dApp's Solana request: one `solana-sign` covers a batch of transactions (signed sequentially —
 * each prompts) or a `solana.message` raw-message signature.
 */
export type SolanaSignInput = {
  readonly method: "solana-sign";
  readonly origin: DappOrigin;
  readonly account: SolanaAccount;
  readonly network: string;
  readonly request:
    | {
        readonly kind: "transactions";
        /** Serialized transactions as the Wallet Standard passes them. */
        readonly transactions: ReadonlyArray<Uint8Array>;
        readonly send: boolean;
      }
    | {
        readonly kind: "message";
        readonly message: Uint8Array;
        /** Set for a Sign In With Solana request; `message` is its text. */
        readonly signIn?: SignInFields;
      };
};

/**
 * A dApp's Bitcoin request: a BIP-322 simple message signature, or a batch of PSBTs signed one
 * after another under one approval (`send` also finalizes and broadcasts each).
 */
export type BitcoinSignInput =
  | {
      readonly method: "bitcoin-sign";
      readonly origin: DappOrigin;
      readonly account: BitcoinAccount;
      readonly network: string;
      readonly request: { readonly kind: "message"; readonly message: string };
    }
  | {
      readonly method: "bitcoin-sign";
      readonly origin: DappOrigin;
      readonly account: BitcoinGroup;
      readonly network: string;
      readonly request: {
        readonly kind: "psbt";
        readonly psbts: ReadonlyArray<BitcoinPsbtInput>;
        readonly send: boolean;
      };
    };

export type RequestInput =
  | ChainRequestInput
  | PayInput
  | ZapInput
  | EvmSignInput
  | TronSignInput
  | NostrSignInput
  | WeblnInvoiceInput
  | WatchAssetInput
  | SolanaSignInput
  | BitcoinSignInput
  | SparkDepositInput
  | SparkExitInput;

/** `approve` of a `nostr-sign` request: the signed event. */
export type NostrSignResult = {
  readonly kind: "nostr.event";
  readonly event: Event;
};

/** `nostr-sign` display: the kind, a content preview and the tag count — nothing else is shown. */
export type NostrDisplay = {
  readonly kind: "nostr.event";
  readonly eventKind: number;
  readonly preview: string;
  readonly tagCount: number;
};

/** `approve` of a `webln-invoice` request: the created invoice's BOLT11 payment request. */
export type WeblnInvoiceResult = {
  readonly kind: "lightning.invoice";
  readonly paymentRequest: string;
};

/** `solana-sign` display: each transaction's decode (fee payer + transfers) or the raw message. */
export type SolanaDisplay = {
  readonly kind: "solana.sign";
  readonly send: boolean;
  readonly count: number;
  readonly transactions: ReadonlyArray<unknown>;
  /** A message request's content — text, or raw bytes when it is not UTF-8. */
  readonly message?: MessageContent;
  readonly signIn?: SignInFields;
};

/** `approve` of a `solana-sign` request: the signatures (or signed transactions) per input. */
export type SolanaSignResult =
  | {
      readonly kind: "solana.transactions";
      readonly send: boolean;
      readonly signatures?: ReadonlyArray<string>;
      readonly signedTransactions?: ReadonlyArray<Uint8Array>;
      /** Where the batch stopped; `signatures` holds exactly the ids that went out. */
      readonly stopped?: {
        readonly index: number;
        readonly reason: "refused" | "not-sent";
        readonly error: string;
      };
    }
  | { readonly kind: "solana.message"; readonly signature: Uint8Array };

/** `bitcoin-sign` display: the message text, or each PSBT's decode. */
export type BitcoinDisplay = {
  readonly kind: "bitcoin.sign";
  readonly message?: MessageContent;
  readonly psbts?: ReadonlyArray<DisplayIntent>;
  readonly send?: boolean;
};

/**
 * `approve` of a `bitcoin-sign` request: the BIP-322 simple signature (base64 of the witness), or
 * the signed PSBTs and, when sent, their txids.
 */
export type BitcoinSignResult =
  | { readonly kind: "bitcoin.message"; readonly signature: string }
  | {
      readonly kind: "bitcoin.psbts";
      readonly signedPsbts: ReadonlyArray<Uint8Array>;
      readonly txids: ReadonlyArray<string>;
      /** Where the batch stopped; `txids` holds exactly the ids that went out. */
      readonly stopped?: {
        readonly index: number;
        readonly reason: "refused" | "not-sent";
        readonly error: string;
      };
    };

/** `approve` of a `watch-asset` request: the token was added. */
export type TokenWatchResult = { readonly kind: "token.watch" };

/** `watch-asset` display: the token as read on-chain; `verified` means it is in the built-in table. */
export type TokenWatchDisplay = {
  readonly kind: "token.watch";
  readonly network: string;
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly verified: boolean;
};

/** `webln-invoice` display: the requested amount and memo. */
export type LightningInvoiceDisplay = {
  readonly kind: "lightning.invoice";
  readonly amountSats: number;
  readonly memo?: string;
};

const BLIND_SIGNING_DISABLED_MESSAGE = "blind signing is turned off for this vault";

/** `approve` refused a blind request for a vault whose owner has not allowed blind signing. */
export class BlindSigningDisabledError extends Error {
  constructor() {
    super(BLIND_SIGNING_DISABLED_MESSAGE);
    this.name = "BlindSigningDisabledError";
  }
}

/**
 * The approval-time re-simulation differs from the prepared outcome; the request went back to
 * `awaiting-approval` with the fresh result and stays approvable.
 */
export class SimulationChangedError extends Error {
  constructor() {
    super("the simulation changed while the request waited — review it again");
    this.name = "SimulationChangedError";
  }
}

/**
 * What the user must have confirmed for a request to be approved: its `danger` findings and every
 * recorded check. The host passes back the codes it showed, so a finding that appeared after the
 * approval screen was drawn is never confirmed unseen.
 */
export type RequestAcknowledgement = {
  readonly risk: ReadonlyArray<RiskFinding["code"]>;
  readonly checks: ReadonlyArray<RequestCheckCode>;
};

export type ApproveOptions = {
  /** The factor for requests that sign with a secret; requests that do not take none. */
  readonly verify?: SendParams["verify"];
  /** Required, and exact, whenever {@link requiredAcknowledgement} is not empty. */
  readonly acknowledged?: RequestAcknowledgement;
};

/** The acknowledgement `approve` requires for the request as it stands now. */
export const requiredAcknowledgement = (
  request: Pick<PendingRequest, "risk" | "checks">,
): RequestAcknowledgement => ({
  risk: request.risk.filter((finding) => finding.level === "danger").map((finding) => finding.code),
  checks: request.checks,
});

const sameCodes = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  const codes = new Set(a);
  return codes.size === new Set(b).size && b.every((code) => codes.has(code));
};

const NOTHING_ACKNOWLEDGED: RequestAcknowledgement = { risk: [], checks: [] };

const acknowledges = (
  request: Pick<PendingRequest, "risk" | "checks">,
  acknowledged: RequestAcknowledgement | undefined,
): boolean => {
  const required = requiredAcknowledgement(request);
  const given = acknowledged ?? NOTHING_ACKNOWLEDGED;
  return sameCodes(required.risk, given.risk) && sameCodes(required.checks, given.checks);
};

/**
 * `approve` was called without confirming exactly the request's current danger findings and checks.
 * The request stays `awaiting-approval`; `required` is what to show and pass back.
 */
export class AcknowledgementRequiredError extends Error {
  readonly required: RequestAcknowledgement;

  constructor(required: RequestAcknowledgement) {
    super("the request has findings the user has not acknowledged");
    this.name = "AcknowledgementRequiredError";
    this.required = required;
  }
}

function assertAcknowledged(
  request: Pick<PendingRequest, "risk" | "checks">,
  acknowledged: RequestAcknowledgement | undefined,
): void {
  if (!acknowledges(request, acknowledged)) {
    throw new AcknowledgementRequiredError(requiredAcknowledgement(request));
  }
}

export type { RequestStage } from "./stage.ts";

export type PendingRequest = {
  readonly id: string;
  readonly origin: RequestOrigin;
  readonly method: RequestMethod;
  readonly account:
    | AccountRef
    | SparkAccountRef
    | NostrKeyRef
    | SolanaAccount
    | BitcoinAccount
    | BitcoinGroup;
  readonly network: string;
  readonly stage: RequestStage;
  /** Decoded locally from the exact content that will be signed; `family` tells the shapes apart. */
  readonly display:
    | DisplayIntent
    | SparkDisplay
    | NostrDisplay
    | LightningInvoiceDisplay
    | TokenWatchDisplay
    | SolanaDisplay
    | BitcoinDisplay;
  /** `unverifiable` as soon as any check is recorded; `approve` requires each to be acknowledged. */
  readonly verification: "verified" | "unverifiable";
  readonly checks: ReadonlyArray<RequestCheckCode>;
  /**
   * Recipient risk; independent of `verification`. `approve` requires each `danger` to be
   * acknowledged.
   */
  readonly risk: ReadonlyArray<RiskFinding>;
  /** Present for simulated requests: sends and dApp transactions; absent otherwise. */
  readonly simulation?: SimulationOutcome;
  /** The TRON fee quote a tron send built — bandwidth, activation and energy detail. */
  readonly tronFee?: TronFeeQuote;
  /** When `simulation` was produced (ms); one older than {@link RESIMULATE_AFTER_MS} re-runs. */
  readonly simulatedAt?: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** The transaction being replaced or accelerated; absent for a plain send. */
  readonly target?: string;
  /** The tracked transaction once submitted. */
  readonly txId?: string;
  readonly error?: string;
};

export type RequestControllerState = {
  readonly requests: Record<string, PendingRequest>;
};

export type RequestControllerOptions = {
  readonly transactions: TransactionController;
  /** The full controller: its payment methods are reachable only through this pipeline. */
  readonly spark: SparkController;
  readonly addressBook: AddressBookController;
  /** The session EngineStore — the engine opens it once per unlock and closes it on lock. */
  readonly openStore: () => Promise<EngineStore>;
  readonly fetch: typeof globalThis.fetch;
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly logger: EngineLogger;
  /** Signs a Nostr event for `nostr-sign` — `nostr(wallet).signer(ref).signEvent`. */
  readonly nostrSign: (ref: NostrKeyRef, event: UnsignedEvent) => Promise<Event>;
  readonly phishing: Pick<PhishingController, "check">;
  /** Reads a token's metadata and adds it to the tracked list, for `watch-asset`. */
  readonly tokens: {
    readonly metadata: (
      network: string,
      address: string,
    ) => Promise<{ readonly symbol: string; readonly decimals: number }>;
    readonly add: (network: string, address: string) => Promise<void>;
  };
  /**
   * The vault's blind-signing setting (`WalletSnapshot.blindSigning`); `approve` refuses a blind
   * request while it is off, and the kernel enforces it again.
   */
  readonly blindSigning: () => boolean;
  /** Simulates one `solana-sign` transaction for display; failures are the caller's `unavailable`. */
  readonly simulateSolana: (
    account: SolanaAccount,
    network: string,
    message: Uint8Array,
  ) => Promise<SimulationOutcome>;
  /** Signs/broadcasts a `solana-sign` request — `chains.sign` per tx, then the Solana adapter. */
  readonly solanaSign: (
    account: { readonly walletId: string; readonly groupIndex: number; readonly address: string },
    network: string,
    request: SolanaSignInput["request"],
    verify: SendParams["verify"],
    commit: () => void,
  ) => Promise<SolanaSignResult>;
  /** Signs a `bitcoin-sign` message — `chains.sign` with the account's template. */
  readonly bitcoinSign: (
    account: BitcoinAccount,
    network: string,
    request: { readonly kind: "message"; readonly message: string },
    verify: SendParams["verify"],
  ) => Promise<BitcoinSignResult>;
  /** Adds the group's derivation data to a dApp's PSBTs; refuses inputs that are not its own. */
  readonly bitcoinPrepare: (
    account: BitcoinGroup,
    network: string,
    psbts: ReadonlyArray<BitcoinPsbtInput>,
  ) => Promise<ReadonlyArray<PreparedBitcoinPsbt>>;
  /** Signs (and with `send` broadcasts) the prepared PSBTs. */
  readonly bitcoinSignPsbts: (
    account: BitcoinGroup,
    network: string,
    prepared: ReadonlyArray<PreparedBitcoinPsbt>,
    send: boolean,
    verify: SendParams["verify"],
    commit: () => void,
  ) => Promise<BitcoinSignResult>;
};

/** Requests expire this long after creation. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** A simulation older than this is re-run at approval before any signing. */
export const RESIMULATE_AFTER_MS = 60_000;

/** What approval needs from a prepared request, whichever kind it is. */
type Run =
  | {
      /** A funds or signature request needs the unlock factor at `submit`. */
      readonly factor: "required";
      /** The tracked transaction `submit` creates (chain requests only). */
      readonly txId?: string;
      readonly staleReason: () => string | undefined | Promise<string | undefined>;
      /**
       * `commit` moves the request to `signed` — the point of no return. Call it immediately (no
       * await in between) before anything is broadcast or sent; it throws when the request was
       * invalidated, and then nothing may be sent.
       */
      readonly submit: (
        verify: SendParams["verify"],
        commit: () => void,
      ) => Promise<
        TrackedTransaction | SparkResult | SignatureResult | SolanaSignResult | BitcoinSignResult
      >;
      readonly release: () => void;
    }
  | {
      /** `nostr-sign` is not per-event verifiable (WD-065) — `submit` takes no factor. */
      readonly factor: "none";
      readonly txId?: string;
      readonly staleReason: () => string | undefined | Promise<string | undefined>;
      readonly submit: () => Promise<NostrSignResult | WeblnInvoiceResult | TokenWatchResult>;
      readonly release: () => void;
    };

/**
 * An approval-time re-simulation: the intent the fresh outcome is assessed against, the request's
 * own checks and risk without the last simulation's findings, and the re-run itself.
 */
type Resimulation = {
  readonly intent: Pick<DisplayIntent, "outflows" | "verifiability">;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  readonly risk: ReadonlyArray<RiskFinding>;
  readonly run: () => Promise<SimulationOutcome>;
};

type Built = {
  readonly account:
    | AccountRef
    | SparkAccountRef
    | NostrKeyRef
    | SolanaAccount
    | BitcoinAccount
    | BitcoinGroup;
  readonly network: string;
  readonly display:
    | DisplayIntent
    | SparkDisplay
    | NostrDisplay
    | LightningInvoiceDisplay
    | TokenWatchDisplay
    | SolanaDisplay
    | BitcoinDisplay;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  readonly risk: ReadonlyArray<RiskFinding>;
  readonly simulation?: SimulationOutcome;
  /** The TRON fee quote — set only by a tron send build. */
  readonly tronFee?: TronFeeQuote;
  /** Present when `simulation` can be re-run at approval. */
  readonly resimulation?: Resimulation;
  readonly run: Run;
};

/** What an approved request resolves with, whichever kind it is. */
export type RequestResult =
  | TrackedTransaction
  | SparkResult
  | SignatureResult
  | NostrSignResult
  | WeblnInvoiceResult
  | TokenWatchResult
  | SolanaSignResult
  | BitcoinSignResult;

type Settler = {
  readonly promise: Promise<RequestResult>;
  readonly resolve: (value: RequestResult) => void;
  readonly reject: (error: Error) => void;
};

type Entry = {
  readonly prepared: Run;
  readonly stopTimer: () => void;
  readonly resimulation?: Resimulation;
};

const originKey = (origin: DappOrigin): string => `origin:${origin.origin}`;

/** A message request's content: its UTF-8 text with any sign-in parse, else the raw bytes. */
const messageContent = (message: Uint8Array, signIn: SignInParse | undefined): MessageContent => {
  const text = utf8Text(message);
  if (text === undefined) {
    return { kind: "bytes", hex: `0x${bytesToHex(message)}` };
  }
  return signIn === undefined ? { kind: "text", text } : { kind: "text", text, signIn };
};

const solanaIntent = (
  account: SolanaAccount,
  network: string,
  message: Uint8Array,
): DisplayIntent => {
  const request = normalizeSolana(
    {
      kind: "solana.transaction",
      network,
      account: {
        kind: "hd",
        walletId: account.walletId,
        groupIndex: account.groupIndex,
        template: "solana.bip44-change",
      },
      message,
    },
    account.address,
  );
  if (request.kind !== "solana.transaction") {
    throw new Error("not a transaction");
  }
  return decodeSolana(request, account.address, undefined);
};

/** The transaction's declared lamport outflows are swallowed whole by its maximum fee. */
const feeExceedsLamports = (intent: DisplayIntent): boolean => {
  if (intent.fee === undefined) {
    return false;
  }
  const lamports = intent.outflows
    .filter((f) => f.amount.asset === SOLANA_NATIVE_ASSET)
    .reduce((a, f) => a + BigInt(f.amount.amount), 0n);
  return lamports > 0n && feeReachesAmount(BigInt(intent.fee.max.amount), lamports);
};

/** Nothing declared and nothing checkable: what a transaction that did not decode counts as. */
const OPAQUE_INTENT: Pick<DisplayIntent, "outflows" | "verifiability"> = {
  outflows: [],
  verifiability: "opaque",
};

/**
 * Merges a simulation's assessment into a built request and keeps the pre-simulation checks, risk
 * and intent on `resimulation`, so an approval-time re-run assesses the same way.
 */
const withSimulation = (
  built: Built,
  intent: Pick<DisplayIntent, "outflows" | "verifiability">,
  simulation: SimulationOutcome | undefined,
  resimulate?: () => Promise<SimulationOutcome>,
): Built => {
  if (simulation === undefined) {
    return built;
  }
  const assessed = assessSimulation(intent, simulation);
  return {
    ...built,
    checks: collectChecks([...built.checks, ...assessed.checks]),
    risk: mergeRisk(built.risk, assessed.risk),
    simulation,
    ...(resimulate === undefined
      ? {}
      : {
          resimulation: {
            intent,
            checks: built.checks,
            risk: built.risk,
            run: resimulate,
          },
        }),
  };
};

/** The input's dApp origin, when it carries one. */
const dappOriginOf = (input: RequestInput): DappOrigin | undefined =>
  "origin" in input ? input.origin : undefined;

/** Terminal events and the stage and sign-log outcome each maps to. */
const END_OUTCOMES = {
  reject: "rejected",
  fail: "failed",
  expire: "expired",
  invalidate: "invalidated",
} as const satisfies Partial<Record<RequestEvent, SignLogOutcome>>;

type EndEvent = keyof typeof END_OUTCOMES;

/** The `RequestEndedError` stage for a request that can no longer proceed. */
const endedStage = (request: PendingRequest | undefined): RequestEndedError["stage"] => {
  switch (request?.stage) {
    case "rejected":
    case "failed":
    case "expired":
    case "invalidated":
      return request.stage;
    default:
      return "invalidated";
  }
};

/** A `prepare` still building: invalidation voids it so it never reaches the state. */
type Preparing = {
  readonly origin: DappOrigin | undefined;
  voided: boolean;
};

export class RequestController extends Controller<RequestControllerState> {
  private readonly options: RequestControllerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly log: SignLog;
  private readonly settlers = new Map<string, Settler>();
  /** Original transaction id → the unfinished request replacing or accelerating it. */
  private readonly targets = new Map<string, string>();
  /** Requests still being built, request id → the prepare in flight. */
  private readonly preparing = new Map<string, Preparing>();
  private locked = true;

  constructor(options: RequestControllerOptions) {
    super({ name: "requests", defaultState: () => ({ requests: {} }) });
    this.options = options;
    this.log = createSignLog(options.logger);
  }

  async init(): Promise<void> {
    this.locked = false;
    for (const preparing of this.preparing.values()) {
      preparing.voided = true;
    }
    this.preparing.clear();
    this.entries.clear();
    this.targets.clear();
    this.settlers.clear();
    this.update(() => ({ requests: {} }));
    this.log.open(await this.options.openStore());
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Locking is not consent: every unfinished request becomes `invalidated` and frees its resources. */
  lock(): void {
    this.locked = true;
    this.invalidateAll();
    this.log.close();
  }

  /**
   * Locking, unlocking and switching account group void every unfinished request (requests.mdx
   * invariant 1).
   */
  invalidateAll(): void {
    for (const preparing of this.preparing.values()) {
      preparing.voided = true;
    }
    for (const [id, request] of Object.entries(this.getState().requests)) {
      if (nextStage(request.stage, "invalidate") !== undefined) {
        this.end(id, "invalidate");
      }
    }
  }

  /** A page navigated away, was revoked or changed network: its unfinished requests are void. */
  invalidateOrigin(origin: string): void {
    for (const preparing of this.preparing.values()) {
      if (preparing.origin?.origin === origin) {
        preparing.voided = true;
      }
    }
    for (const [id, request] of Object.entries(this.getState().requests)) {
      if (
        nextStage(request.stage, "invalidate") !== undefined &&
        dappOf(request.origin)?.origin === origin
      ) {
        this.end(id, "invalidate");
      }
    }
  }

  /** The signature record, newest first. */
  async signLog(): Promise<ReadonlyArray<SignLogEntry>> {
    return this.log.list();
  }

  async clearSignLog(): Promise<void> {
    await this.log.clear();
  }

  async prepare(input: RequestInput, app?: AppOrigin): Promise<PendingRequest> {
    if (this.locked) {
      throw new Error("requests require an unlocked vault");
    }
    if (app !== undefined && !isAppOrigin(app)) {
      throw new Error("an app request needs a well-formed app id");
    }
    const id = newRequestId(this.options.random);
    // A transaction can have one unfinished replacement at a time; claimed synchronously so two
    // concurrent prepares cannot both pass.
    const target = "txId" in input ? input.txId : undefined;
    const origin = dappOriginOf(input);
    if (app !== undefined && origin !== undefined) {
      throw new Error("an app request cannot carry a dApp origin");
    }
    const originStatus =
      origin === undefined ? "clear" : this.options.phishing.check(dappUrl(origin));
    if (originStatus === "blocked") {
      throw new Error(PHISHING_BLOCKED_MESSAGE);
    }
    if (origin !== undefined) {
      const key = originKey(origin);
      if (this.targets.has(key)) {
        throw new OriginBusyError(origin.origin);
      }
      this.targets.set(key, id);
    }
    if (target !== undefined) {
      if (this.targets.has(target)) {
        throw new Error(`transaction ${target} already has an unfinished replacement request`);
      }
      this.targets.set(target, id);
    }
    const preparing: Preparing = { origin, voided: false };
    this.preparing.set(id, preparing);
    let built: Built;
    try {
      built = await this.build(input, id);
    } catch (error) {
      this.unclaim(id);
      throw error;
    } finally {
      this.preparing.delete(id);
    }
    if (preparing.voided) {
      built.run.release();
      this.unclaim(id);
      throw new RequestEndedError(
        "invalidated",
        "the request was invalidated while it was being prepared",
      );
    }
    const { checks } = built;
    const createdAt = this.options.now();
    const originFindings =
      origin?.kind === "walletconnect"
        ? [...originRisk(originStatus), ...verifyRisk(origin.verify)]
        : originRisk(originStatus);
    const request: PendingRequest = {
      id,
      origin: origin ?? app ?? { kind: "internal" },
      method: input.method,
      account: built.account,
      network: built.network,
      ...(target === undefined ? {} : { target }),
      stage: "awaiting-approval",
      display: built.display,
      verification: checks.length > 0 ? "unverifiable" : "verified",
      checks,
      risk: mergeRisk(built.risk, originFindings),
      ...(built.simulation === undefined
        ? {}
        : { simulation: built.simulation, simulatedAt: createdAt }),
      ...(built.tronFee === undefined ? {} : { tronFee: built.tronFee }),
      createdAt,
      expiresAt: createdAt + REQUEST_TTL_MS,
    };
    const stopTimer = this.options.setTimer(REQUEST_TTL_MS, () => {
      if (this.getState().requests[id]?.stage === "awaiting-approval") {
        this.end(id, "expire");
      }
    });
    const resimulation =
      built.resimulation === undefined
        ? undefined
        : {
            ...built.resimulation,
            risk: mergeRisk(built.resimulation.risk, originFindings),
          };
    this.entries.set(id, {
      prepared: built.run,
      stopTimer,
      ...(resimulation === undefined ? {} : { resimulation }),
    });
    this.put(request);
    this.openSettler(id);
    return request;
  }

  /**
   * Resolves with what `approve` returned, or rejects with `RequestEndedError` when the request
   * ends any other way — how a dApp's pending call learns the outcome.
   */
  async outcome(id: string): Promise<RequestResult> {
    const settler = this.settlers.get(id);
    if (settler === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    return settler.promise;
  }

  private openSettler(id: string): void {
    const holder: { resolve?: Settler["resolve"]; reject?: Settler["reject"] } = {};
    const promise = new Promise<RequestResult>((resolve, reject) => {
      holder.resolve = resolve;
      holder.reject = reject;
    });
    // The caller may never ask; marking it observed keeps a rejection from surfacing.
    void Promise.allSettled([promise]);
    this.settlers.set(id, {
      promise,
      resolve: (value) => holder.resolve?.(value),
      reject: (error) => holder.reject?.(error),
    });
  }

  private settle(id: string, result: RequestResult | Error): void {
    const settler = this.settlers.get(id);
    if (settler === undefined) {
      return;
    }
    if (result instanceof Error) {
      settler.reject(result);
    } else {
      settler.resolve(result);
    }
  }

  /** The bitcoin network `account`'s Spark network settles on; any other pairing is refused. */
  private l1Network(account: SparkAccountRef): string {
    const network = SPARK_L1_NETWORK[account.network] as string | undefined;
    if (network === undefined) {
      throw new Error(`unknown Spark network ${account.network}`);
    }
    return network;
  }

  private sparkBuilt(account: SparkAccountRef, action: PreparedSparkAction): Built {
    return {
      account,
      network: action.display.network,
      display: action.display,
      checks: collectChecks(action.checks),
      risk: this.sparkRisk(action.display),
      run: {
        factor: "required",
        staleReason: () => action.staleReason(this.options.now()),
        submit: async (verify, commit) => action.execute(this.options.spark, verify, commit),
        release: () => undefined,
      },
    };
  }

  private async simulateOne(
    account: SolanaAccount,
    network: string,
    message: Uint8Array,
  ): Promise<SimulationOutcome> {
    try {
      return await this.options.simulateSolana(account, network, message);
    } catch (error) {
      return { status: "unavailable", error: errorMessage(error) };
    }
  }

  private async build(input: RequestInput, id: string): Promise<Built> {
    if (input.method === "pay" || input.method === "zap") {
      const action: PreparedSparkAction =
        input.method === "pay"
          ? await preparePay(
              {
                fetch: this.options.fetch,
                now: this.options.now,
                requestId: id,
                spark: this.options.spark,
              },
              input,
            )
          : prepareZapAction(input.account, input.zap, {
              maxFeeSats: input.maxFeeSats,
              now: this.options.now,
              requestId: id,
            });
      return this.sparkBuilt(input.account, action);
    }
    if (input.method === "spark-deposit") {
      const l1 = this.l1Network(input.account);
      if (input.from.kind !== "hd" || input.from.walletId !== input.account.walletId) {
        throw new Error("a Spark deposit must come from the same wallet");
      }
      const to = await this.options.spark.newDepositAddress(input.account);
      const prepared = await this.options.transactions.prepareSend(
        { account: input.from, network: l1, to, amount: BigInt(input.amountSats), fee: input.fee },
        id,
        {
          walletId: input.account.walletId,
          groupIndex: input.account.groupIndex,
          network: input.account.network,
        },
      );
      return {
        account: prepared.account,
        network: prepared.network,
        display: prepared.intent,
        checks: collectChecks([
          prepared.intent.verifiability === "full" ? undefined : "decode-partial",
          ...prepared.checks,
        ]),
        risk: [],
        run: { ...prepared, factor: "required" },
      };
    }
    if (input.method === "spark-exit") {
      const l1 = this.l1Network(input.account);
      const address = await this.options.transactions.nextReceiveAddress(
        input.account.walletId,
        input.account.groupIndex,
        l1,
      );
      const action = await preparePay(
        {
          fetch: this.options.fetch,
          now: this.options.now,
          requestId: id,
          spark: this.options.spark,
        },
        {
          account: input.account,
          option: { kind: "bitcoin", address },
          amountSats: input.amountSats,
          maxFeeSats: input.maxFeeSats,
          ...(input.speed === undefined ? {} : { speed: input.speed }),
        },
      );
      return this.sparkBuilt(input.account, action);
    }
    if (input.method === "evm-sign") {
      if (input.origin === undefined && input.request.kind !== "evm.typed-data") {
        throw new Error("an internal request can only sign typed data");
      }
      const prepared = await this.options.transactions.prepareDapp(input.account, input.request);
      const isTransaction = input.request.kind === "evm.transaction";
      const signInRisk =
        input.origin !== undefined &&
        "signer" in prepared &&
        prepared.intent.message?.kind === "text"
          ? this.signInRisk(prepared.intent.message.signIn, input.origin, prepared.signer, "evm")
          : [];
      const blindRisk = this.blindRisk(prepared.intent);
      const { message } = prepared.intent;
      const permitRisk =
        message?.kind === "typed-data" ? assessPermits(prepared.intent, this.options.now()) : [];
      const orderRisk =
        message?.kind === "typed-data" && "signer" in prepared
          ? [...assessSeaport(message.seaport, prepared.signer), ...assessSafe(message.safe)]
          : [];
      const recipientRisk = isTransaction
        ? []
        : assessRecipients(
            prepared.intent.family,
            prepared.intent.outflows.map(recipientOf),
            this.knownAddresses(prepared.intent.family),
          );
      const built: Built = {
        account: prepared.account,
        network: prepared.network,
        display: prepared.intent,
        checks: collectChecks([
          isTransaction && prepared.intent.verifiability !== "full" ? "decode-partial" : undefined,
          message?.kind === "typed-data" &&
          (message.fields !== undefined || message.order !== undefined)
            ? "decode-partial"
            : undefined,
          ...prepared.checks,
        ]),
        risk: isTransaction
          ? this.chainRisk(prepared.intent)
          : mergeRisk(
              mergeRisk(mergeRisk(signInRisk, permitRisk), orderRisk),
              mergeRisk(recipientRisk, blindRisk),
            ),
        run: { ...prepared, factor: "required" },
      };
      return isTransaction
        ? withSimulation(built, prepared.intent, prepared.simulation, prepared.resimulate)
        : built;
    }
    if (input.method === "tron-sign") {
      if (input.origin === undefined && input.request.kind !== "tron.typed-data") {
        throw new Error("an internal request can only sign typed data");
      }
      const prepared = await this.options.transactions.prepareDappTron(
        input.account,
        input.request,
      );
      const isTransaction = input.request.kind === "tron.transaction";
      const signInRisk =
        input.origin !== undefined &&
        "signer" in prepared &&
        prepared.intent.message?.kind === "text"
          ? this.signInRisk(prepared.intent.message.signIn, input.origin, prepared.signer, "tron")
          : [];
      const blindRisk = this.blindRisk(prepared.intent);
      const { message } = prepared.intent;
      const permitRisk =
        message?.kind === "typed-data" ? assessPermits(prepared.intent, this.options.now()) : [];
      const recipientRisk = isTransaction
        ? []
        : assessRecipients(
            prepared.intent.family,
            prepared.intent.outflows.map(recipientOf),
            this.knownAddresses(prepared.intent.family),
          );
      const built: Built = {
        account: prepared.account,
        network: prepared.network,
        display: prepared.intent,
        checks: collectChecks([
          isTransaction && prepared.intent.verifiability !== "full" ? "decode-partial" : undefined,
          message?.kind === "typed-data" && message.fields !== undefined
            ? "decode-partial"
            : undefined,
          ...prepared.checks,
        ]),
        risk: isTransaction
          ? mergeRisk(this.chainRisk(prepared.intent), prepared.risk ?? [])
          : mergeRisk(mergeRisk(signInRisk, permitRisk), mergeRisk(recipientRisk, blindRisk)),
        run: { ...prepared, factor: "required" },
        ...(prepared.tronFee === undefined ? {} : { tronFee: prepared.tronFee }),
      };
      return isTransaction
        ? withSimulation(built, prepared.intent, prepared.simulation, prepared.resimulate)
        : built;
    }
    if (input.method === "solana-sign") {
      const txs =
        input.request.kind === "transactions"
          ? input.request.transactions.map(
              (wire) => decodeSolanaTransaction(wire, input.account.address).message,
            )
          : [];
      const [only] = txs;
      const intents = txs.map((tx) => solanaIntent(input.account, input.network, tx));
      const [decoded] = intents;
      const signIn =
        input.request.kind === "message" && input.request.signIn === undefined
          ? parseSignIn(utf8Text(input.request.message) ?? "", "solana")
          : undefined;
      const message =
        input.request.kind === "message"
          ? messageContent(input.request.message, signIn)
          : undefined;
      const messageBlind = message === undefined ? undefined : messageBlindReason(message);
      const built: Built = {
        account: input.account,
        network: input.network,
        display: {
          kind: "solana.sign" as const,
          send: input.request.kind === "transactions" ? input.request.send : false,
          count: txs.length === 0 ? 1 : txs.length,
          transactions: intents,
          ...(message === undefined ? {} : { message }),
          ...(input.request.kind === "message" && input.request.signIn !== undefined
            ? { signIn: input.request.signIn }
            : {}),
        },
        checks: collectChecks([
          intents.some((intent) => intent.verifiability === "opaque")
            ? "decode-partial"
            : undefined,
          ...(intents.some(feeExceedsLamports) ? (["fee-exceeds-amount"] as const) : []),
        ]),
        risk: mergeRisk(
          mergeRisk(
            this.signInRisk(signIn, input.origin, input.account.address, "solana"),
            [
              ...(message === undefined
                ? []
                : [messageBlind === undefined ? {} : { blind: messageBlind }]),
              ...intents,
            ].flatMap((intent) => this.blindRisk(intent)),
          ),
          intents.flatMap((intent) => assessApprovals(intent)),
        ),
        run: {
          factor: "required",
          staleReason: () => undefined,
          submit: async (verify, commit) =>
            this.options.solanaSign(input.account, input.network, input.request, verify, commit),
          release: () => undefined,
        },
      };
      if (only === undefined) {
        return built;
      }
      const single = txs.length === 1;
      const simulation: SimulationOutcome = single
        ? await this.simulateOne(input.account, input.network, only)
        : { status: "unavailable", error: "batch" };
      return withSimulation(
        built,
        decoded ?? OPAQUE_INTENT,
        simulation,
        single ? async () => this.simulateOne(input.account, input.network, only) : undefined,
      );
    }
    if (input.method === "bitcoin-sign" && input.request.kind === "psbt") {
      const { psbts, send } = input.request;
      const prepared = await this.options.bitcoinPrepare(input.account, input.network, psbts);
      const intents = prepared.map(({ request, ownScripts }) =>
        decodeBitcoinPsbt(request, ownScripts),
      );
      return {
        account: input.account,
        network: input.network,
        display: { kind: "bitcoin.sign" as const, psbts: intents, send },
        checks: collectChecks(
          intents.some((i) => i.verifiability !== "full") ? ["decode-partial"] : [],
        ),
        risk: mergeRisk(
          assessBitcoinPsbts(prepared.flatMap((p) => p.inputs)),
          intents.flatMap((intent) => this.blindRisk(intent)),
        ),
        run: {
          factor: "required",
          staleReason: () => undefined,
          submit: async (verify, commit) =>
            this.options.bitcoinSignPsbts(
              input.account,
              input.network,
              prepared,
              send,
              verify,
              commit,
            ),
          release: () => undefined,
        },
      };
    }
    if (input.method === "bitcoin-sign") {
      const { request, account } = input;
      if (request.kind !== "message" || !("address" in account)) {
        throw new Error("unreachable bitcoin-sign request");
      }
      return {
        account,
        network: input.network,
        display: {
          kind: "bitcoin.sign" as const,
          message: { kind: "text" as const, text: request.message },
        },
        checks: [],
        risk: [],
        run: {
          factor: "required",
          staleReason: () => undefined,
          submit: async (verify) =>
            this.options.bitcoinSign(account, input.network, request, verify),
          release: () => undefined,
        },
      };
    }
    if (input.method === "webln-invoice") {
      return {
        account: input.ref,
        network: "",
        display: {
          kind: "lightning.invoice",
          amountSats: input.amountSats,
          ...(input.memo === undefined ? {} : { memo: input.memo }),
        },
        checks: [],
        risk: [],
        run: {
          factor: "none",
          staleReason: () => undefined,
          submit: async () => {
            const invoice = await this.options.spark.createInvoice(input.ref, {
              amountSats: input.amountSats,
              ...(input.memo === undefined ? {} : { memo: input.memo }),
            });
            return { kind: "lightning.invoice" as const, paymentRequest: invoice.invoice };
          },
          release: () => undefined,
        },
      };
    }
    if (input.method === "watch-asset") {
      const tron = networkById(input.network)?.family === "tron";
      if (tron && !isTronAddress(input.address)) {
        throw new InvalidTokenError(`${input.address} is not a TRC-20 address`);
      }
      const address = tron ? input.address : checksumEvmAddress(input.address);
      const metadata = await this.options.tokens.metadata(input.network, address);
      const symbol = safeDisplayText(metadata.symbol, TOKEN_SYMBOL_MAX);
      const decimals = safeDecimals(metadata.decimals);
      if (symbol === undefined) {
        throw new InvalidTokenError("the token symbol cannot be displayed safely");
      }
      if (decimals === undefined) {
        throw new InvalidTokenError("the token decimals are out of range");
      }
      const impersonated = tron
        ? impersonatesTronToken(input.network, address, symbol)
        : impersonatesBuiltIn(Number(input.network.slice("eip155:".length)), address, symbol);
      return {
        account: input.account,
        network: input.network,
        display: {
          kind: "token.watch",
          network: input.network,
          address,
          symbol,
          decimals,
          verified: tron
            ? lookupTronToken(tronTokenTable, input.network, address) !== undefined
            : lookupEvmToken(
                evmTokenTable,
                Number(input.network.slice("eip155:".length)),
                address,
              ) !== undefined,
        },
        checks: [],
        risk: [
          ...(impersonated
            ? [{ code: "token-impersonation" as const, level: "danger" as const }]
            : []),
          ...(isAscii(symbol)
            ? []
            : [{ code: "token-symbol-unicode" as const, level: "warning" as const }]),
        ],
        run: {
          factor: "none",
          staleReason: () => undefined,
          submit: async () => {
            await this.options.tokens.add(input.network, address);
            return { kind: "token.watch" as const };
          },
          release: () => undefined,
        },
      };
    }
    if (input.method === "nostr-sign") {
      return {
        account: input.ref,
        network: "",
        display: {
          kind: "nostr.event",
          eventKind: input.event.kind,
          preview: input.event.content.slice(0, 280),
          tagCount: input.event.tags.length,
        },
        checks: [],
        risk: [],
        run: {
          factor: "none",
          staleReason: () => undefined,
          submit: async () => ({
            kind: "nostr.event" as const,
            event: await this.options.nostrSign(input.ref, input.event),
          }),
          release: () => undefined,
        },
      };
    }
    const internal =
      input.method === "evm-delegation" ||
      input.method === "evm-batch" ||
      input.method === "evm-approve" ||
      input.method === "evm-cctp" ||
      input.method === "evm-swap" ||
      input.method === "evm-nft-send" ||
      input.method === "evm-bridge" ||
      input.method === "evm-lido" ||
      input.method === "solana-stake" ||
      input.method === "solana-swap" ||
      input.method === "solana-core-send" ||
      input.method === "tron-stake" ||
      input.method === "tron-approve";
    const prepared =
      input.method === "send"
        ? await this.options.transactions.prepareSend(input, id)
        : input.method === "solana-stake"
          ? await this.options.transactions.prepareSolanaStake(input, id)
          : input.method === "tron-stake"
            ? await this.options.transactions.prepareTronStake(input, id)
            : input.method === "tron-approve"
              ? await this.options.transactions.prepareTronApprove(input, id)
              : input.method === "solana-swap"
                ? await this.options.transactions.prepareSolanaSwap(input, id)
                : input.method === "solana-core-send"
                  ? await this.options.transactions.prepareSolanaCoreSend(input, id)
                  : internal
                    ? await this.options.transactions.prepareEvmInternal(input, id)
                    : await this.options.transactions.prepareReplacement(input, id);
    const built: Built = {
      account: prepared.account,
      network: prepared.network,
      display: prepared.intent,
      checks: collectChecks([
        prepared.intent.verifiability === "full" ? undefined : "decode-partial",
        ...prepared.checks,
      ]),
      risk:
        input.method === "send" || internal
          ? mergeRisk(this.chainRisk(prepared.intent), prepared.risk ?? [])
          : this.blindRisk(prepared.intent),
      run: { ...prepared, factor: "required" },
      ...(prepared.tronFee === undefined ? {} : { tronFee: prepared.tronFee }),
    };
    return input.method === "send" || internal
      ? withSimulation(built, prepared.intent, prepared.simulation, prepared.resimulate)
      : built;
  }

  /**
   * Signs and submits a request. Anything but a live, unexpired request of this method throws
   * before any signing; a stale build (nonce taken, blockhash expired) fails without signing. So
   * does a request with `danger` findings or checks unless `options.acknowledged` names exactly
   * those — including the ones a re-simulation at approval adds ({@link requiredAcknowledgement}).
   */
  async approve(
    id: string,
    method: ChainRequestMethod | "spark-deposit",
    options?: ApproveOptions,
  ): Promise<TrackedTransaction>;
  async approve(
    id: string,
    method: "pay" | "zap" | "spark-exit",
    options?: ApproveOptions,
  ): Promise<SparkResult>;
  async approve(
    id: string,
    method: "evm-sign" | "tron-sign",
    options?: ApproveOptions,
  ): Promise<TrackedTransaction | SignatureResult>;
  async approve(
    id: string,
    method: "nostr-sign",
    options?: ApproveOptions,
  ): Promise<NostrSignResult>;
  async approve(
    id: string,
    method: "webln-invoice",
    options?: ApproveOptions,
  ): Promise<WeblnInvoiceResult>;
  async approve(
    id: string,
    method: "watch-asset",
    options?: ApproveOptions,
  ): Promise<TokenWatchResult>;
  async approve(
    id: string,
    method: "solana-sign",
    options?: ApproveOptions,
  ): Promise<SolanaSignResult>;
  async approve(
    id: string,
    method: "bitcoin-sign",
    options?: ApproveOptions,
  ): Promise<BitcoinSignResult>;
  async approve(
    id: string,
    method: RequestMethod,
    options: ApproveOptions = {},
  ): Promise<RequestResult> {
    const request = this.getState().requests[id];
    if (request === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    if (request.method !== method) {
      throw new Error(`request ${id} is a ${request.method} request, not ${method}`);
    }
    const entry = this.entries.get(id);
    if (request.stage !== "awaiting-approval" || entry === undefined) {
      throw new Error(`request ${id} is ${request.stage}, not awaiting approval`);
    }
    if (this.options.now() >= request.expiresAt) {
      this.end(id, "expire");
      throw new Error(`request ${id} expired`);
    }
    const dapp = dappOf(request.origin);
    if (dapp !== undefined && this.options.phishing.check(dappUrl(dapp)) === "blocked") {
      this.end(id, "fail", PHISHING_BLOCKED_MESSAGE);
      throw new Error(PHISHING_BLOCKED_MESSAGE);
    }
    if (request.risk.some((f) => f.code === "blind-signing") && !this.options.blindSigning()) {
      throw new BlindSigningDisabledError();
    }
    assertAcknowledged(request, options.acknowledged);
    // Before the first await, so a second `approve` cannot reach the checks below while this one
    // runs.
    this.transition(id, "approve");

    let stale: string | undefined;
    try {
      stale = await entry.prepared.staleReason();
    } catch (error) {
      stale = errorMessage(error);
    }
    this.assertSigning(id);
    if (stale !== undefined) {
      this.end(id, "fail", stale);
      throw new Error(stale);
    }
    const { resimulation } = entry;
    if (
      resimulation !== undefined &&
      request.simulatedAt !== undefined &&
      this.options.now() - request.simulatedAt >= RESIMULATE_AFTER_MS
    ) {
      let outcome: SimulationOutcome;
      try {
        outcome = await resimulation.run();
      } catch (error) {
        outcome = { status: "unavailable", error: errorMessage(error) };
      }
      this.assertSigning(id);
      const assessed = assessSimulation(resimulation.intent, outcome);
      const checks = collectChecks([...resimulation.checks, ...assessed.checks]);
      const risk = mergeRisk(resimulation.risk, assessed.risk);
      const refresh = (): void => {
        this.put({
          ...this.requireRequest(id),
          simulation: outcome,
          simulatedAt: this.options.now(),
          verification: checks.length > 0 ? "unverifiable" : "verified",
          checks,
          risk,
        });
      };
      if (request.simulation !== undefined && simulationChanged(request.simulation, outcome)) {
        this.transition(id, "review");
        refresh();
        throw new SimulationChangedError();
      }
      if (!acknowledges({ checks, risk }, options.acknowledged)) {
        this.transition(id, "review");
        refresh();
        throw new AcknowledgementRequiredError(requiredAcknowledgement({ checks, risk }));
      }
      refresh();
    }
    try {
      const result =
        entry.prepared.factor === "none"
          ? await entry.prepared.submit()
          : await entry.prepared.submit(this.requireVerify(options.verify), () => {
              this.commit(id);
            });
      this.commit(id);
      entry.stopTimer();
      this.entries.delete(id);
      this.unclaim(id);
      const current = this.getState().requests[id];
      if (current !== undefined && nextStage(current.stage, "complete") === "submitted") {
        const done: PendingRequest = {
          ...current,
          stage: "submitted",
          ...("id" in result ? { txId: result.id } : {}),
        };
        this.put(done);
        this.record(done, "submitted", undefined, result);
      }
      this.settle(id, result);
      return result;
    } catch (error) {
      this.end(
        id,
        this.getState().requests[id]?.stage === "signed"
          ? "fail"
          : this.failureEvent(entry.prepared, error),
        errorMessage(error),
      );
      throw error;
    }
  }

  /**
   * A cancelled or refused verification is `reject`; anything after it is `fail`. Chain requests
   * record which step failed on the tracked transaction; for Spark, the approval round is the only
   * source of `WalletError`.
   */
  private failureEvent(run: Run, error: unknown): "reject" | "fail" {
    if (run.txId === undefined) {
      return error instanceof WalletError ? "reject" : "fail";
    }
    return this.options.transactions.getState().txs[run.txId]?.state === "rejected"
      ? "reject"
      : "fail";
  }

  reject(id: string): void {
    const request = this.getState().requests[id];
    if (request === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    if (nextStage(request.stage, "reject") === undefined) {
      throw new Error(`request ${id} is ${request.stage}, not awaiting approval`);
    }
    this.end(id, "reject");
  }

  /** `approve` for a factor-required run: a missing factor is invalid input. */
  private requireVerify(verify: SendParams["verify"] | undefined): SendParams["verify"] {
    if (verify === undefined) {
      throw new WalletError("invalid-input", "a verification factor is required");
    }
    return verify;
  }

  private requireRequest(id: string): PendingRequest {
    const request = this.getState().requests[id];
    if (request === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    return request;
  }

  private put(request: PendingRequest): void {
    this.update((s) => ({ ...s, requests: { ...s.requests, [request.id]: request } }));
  }

  private unclaim(requestId: string): void {
    for (const [target, holder] of this.targets) {
      if (holder === requestId) {
        this.targets.delete(target);
      }
    }
  }

  /**
   * Applies a terminal event: the request ends in the stage `event` maps to and frees what it
   * reserved. A no-op when the event cannot happen in the current stage, so a terminal stage, its
   * sign-log record and its settlement each happen exactly once.
   */
  private end(id: string, event: EndEvent, error?: string): boolean {
    const request = this.getState().requests[id];
    const stage = request === undefined ? undefined : nextStage(request.stage, event);
    if (request === undefined || stage === undefined) {
      return false;
    }
    this.unclaim(id);
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      entry.stopTimer();
      this.entries.delete(id);
      try {
        entry.prepared.release();
      } catch (releaseError) {
        this.options.logger.warn("request release failed", releaseError);
      }
    }
    const ended: PendingRequest = {
      ...request,
      stage,
      ...(error === undefined ? {} : { error }),
    };
    this.put(ended);
    this.record(ended, END_OUTCOMES[event], error);
    this.settle(id, new RequestEndedError(END_OUTCOMES[event], error));
    return true;
  }

  /** Applies `event` to `id`'s stage; returns the new stage, `undefined` when it cannot happen. */
  private transition(id: string, event: RequestEvent): RequestStage | undefined {
    const request = this.getState().requests[id];
    const stage = request === undefined ? undefined : nextStage(request.stage, event);
    if (request === undefined || stage === undefined) {
      return undefined;
    }
    if (stage !== request.stage) {
      this.put({ ...request, stage });
    }
    return stage;
  }

  /** `approve` resumes after each await here: the request must still be `signing`. */
  private assertSigning(id: string): void {
    const request = this.getState().requests[id];
    if (request?.stage === "signing") {
      return;
    }
    throw new RequestEndedError(
      endedStage(request),
      `request ${id} is ${request?.stage ?? "gone"}`,
    );
  }

  /**
   * `signing` → `signed` — the point of no return: the signature exists and is being returned or
   * broadcast, so invalidation no longer applies. Idempotent while `signed`; throws otherwise.
   */
  private commit(id: string): void {
    if (this.transition(id, "commit") === undefined) {
      const request = this.getState().requests[id];
      throw new RequestEndedError(
        endedStage(request),
        `request ${id} is ${request?.stage ?? "gone"}`,
      );
    }
  }

  /** Appends the final stage to the signature record; a failed write is a warning, not an error. */
  private record(
    request: PendingRequest,
    outcome: SignLogOutcome,
    error?: string,
    result?: RequestResult,
  ): void {
    const { display } = request;
    const eventId =
      result !== undefined && "kind" in result && result.kind === "nostr.event"
        ? result.event.id
        : undefined;
    const summary =
      "kind" in display && display.kind === "nostr.event"
        ? `nostr kind ${display.eventKind}${eventId === undefined ? "" : ` ${eventId}`}`
        : "kind" in display && display.kind === "token.watch"
          ? `watch token ${display.symbol}`
          : "kind" in display && display.kind === "lightning.invoice"
            ? `lightning invoice ${display.amountSats} sats`
            : "kind" in display && display.kind === "bitcoin.sign"
              ? display.psbts === undefined
                ? "bitcoin message"
                : display.send === true
                  ? "bitcoin send"
                  : `bitcoin psbt ${String(display.psbts.length)}`
              : "kind" in display && display.kind === "solana.sign"
                ? display.signIn === undefined
                  ? display.transactions.length === 0
                    ? display.message?.kind === "bytes"
                      ? "blind message"
                      : display.message?.kind === "text" &&
                          display.message.signIn?.status === "valid"
                        ? `sign-in ${display.message.signIn.fields.domain}`
                        : "solana message"
                    : `solana ${display.send ? "send" : "sign"} ${String(display.count)} tx`
                  : `solana sign-in ${display.signIn.domain}`
                : "summary" in display
                  ? display.message?.kind === "bytes"
                    ? "blind message"
                    : display.message?.kind === "text" && display.message.signIn?.status === "valid"
                      ? `sign-in ${display.message.signIn.fields.domain}`
                      : display.message?.kind === "typed-data" &&
                          display.message.seaport !== undefined
                        ? "seaport order"
                        : display.message?.kind === "typed-data" &&
                            display.message.safe !== undefined
                          ? `safe tx ${display.message.safe.nonce}`
                          : display.message?.kind === "typed-data" &&
                              display.approvals[0]?.kind === "allowance"
                            ? `permit ${display.approvals[0].amount.symbol ?? display.approvals[0].amount.asset}`
                            : display.summary
                  : "kind" in display && display.kind === "token"
                    ? `token ${display.amount} ${display.tokenIdentifier}`
                    : `${display.kind} ${display.amountSats}`;
    const entry: SignLogEntry = {
      id: request.id,
      at: this.options.now(),
      origin: request.origin,
      method: request.method,
      account: request.account,
      network: request.network,
      summary,
      verification: request.verification,
      checks: request.checks,
      risk: request.risk,
      outcome,
      ...(error === undefined ? {} : { error }),
    };
    void this.appendLog(entry);
  }

  private async appendLog(entry: SignLogEntry): Promise<void> {
    try {
      await this.log.append(entry);
    } catch (error) {
      this.options.logger.warn("sign log write failed", error);
    }
  }

  /**
   * Addresses the wallet already knows for a family: contacts, plus recipients of tracked chain
   * sends (Spark payments are not tracked).
   */
  private knownAddresses(family: string): ReadonlyArray<string> {
    const contacts = Object.values(this.options.addressBook.getState().entries)
      .filter((e) => e.family === family)
      .map((e) => e.address);
    if (family === "spark") {
      return contacts;
    }
    const paid = Object.values(this.options.transactions.getState().txs)
      .filter(
        (tx) =>
          tx.family === family &&
          (tx.state === "submitted" || tx.state === "pending" || tx.state === "confirmed"),
      )
      .flatMap((tx) => tx.intent?.outflows.map(recipientOf) ?? []);
    return [...contacts, ...paid];
  }

  /**
   * A decoder-marked blind request carries one danger; `approve` refuses it while the setting is
   * off.
   */
  private blindRisk(intent: Pick<DisplayIntent, "blind">): ReadonlyArray<RiskFinding> {
    return isBlindIntent(intent) ? [{ code: "blind-signing", level: "danger" }] : [];
  }

  /** Risk of a Sign-In with X message; a message for another domain throws `SignInOriginError`. */
  private signInRisk(
    signIn: SignInParse | undefined,
    origin: DappOrigin,
    signer: string,
    family: "evm" | "solana" | "tron",
  ): ReadonlyArray<RiskFinding> {
    if (signIn === undefined) {
      return [];
    }
    const assessed = assessSignIn({
      signIn,
      origin: dappUrl(origin),
      signer,
      family,
      now: this.options.now(),
    });
    if (assessed.reject !== undefined) {
      throw new SignInOriginError(assessed.reject);
    }
    return assessed.risk;
  }

  private chainRisk(intent: DisplayIntent): ReadonlyArray<RiskFinding> {
    return mergeRisk(
      mergeRisk(
        assessRecipients(
          intent.family,
          intent.outflows.map(recipientOf),
          this.knownAddresses(intent.family),
        ),
        assessApprovals(intent),
      ),
      this.blindRisk(intent),
    );
  }

  /** Only sats and token transfers have a recipient to check; Lightning and exits are not assessed. */
  private sparkRisk(display: SparkDisplay): ReadonlyArray<RiskFinding> {
    if (display.kind !== "transfer" && display.kind !== "token") {
      return [];
    }
    const receiver = normalizeAddress("spark", display.receiver) ?? display.receiver;
    return assessRecipients("spark", [receiver], this.knownAddresses("spark"));
  }
}
