import type { Event, UnsignedEvent } from "@qntx/nostr";
import { WalletError } from "@qntx/wallet";
import type { NostrKeyRef } from "@qntx/wallet";
/**
 * Request pipeline for internal sends, speed-ups, cancellations and CPFP: `prepare` builds,
 * estimates and cross-checks without signing; `approve(id, method, verify)` is the only way to
 * sign, and only for a live, unexpired request of the right method; locking invalidates everything
 * that has not finished. The unsigned content stays in a private table, never in the state
 * snapshot, and cannot change after prepare.
 */
import type { SignRequest } from "@qntx/wallet-chains";
import type { SparkAccountRef } from "@qntx/wallet/protocol";

import type { AddressBookController } from "../addresses/controller.ts";
import { normalizeAddress } from "../addresses/normalize.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { PreparedSparkAction, SparkDisplay, SparkResult } from "../payments/action.ts";
import { preparePay } from "../payments/pay.ts";
import type { PayParams } from "../payments/pay.ts";
import { prepareZapAction } from "../payments/zap.ts";
import type { PreparedZap } from "../payments/zap.ts";
import type { SparkController } from "../spark/controller.ts";
import { SPARK_L1_NETWORK } from "../spark/l1.ts";
import type { EngineStore } from "../store/port.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  ChainRequestMethod,
  DisplayIntent,
  PrepareParams,
  SendParams,
  SignatureResult,
  TrackedTransaction,
} from "../transactions/route.ts";
import { newRequestId } from "../transactions/route.ts";
import { collectChecks } from "./checks.ts";
import type { RequestCheckCode } from "./checks.ts";
import { assessRecipients } from "./risk.ts";
import type { RiskFinding } from "./risk.ts";
import { createSignLog } from "./sign-log.ts";
import type { SignLog, SignLogEntry, SignLogOutcome } from "./sign-log.ts";
import type { BrowserOrigin, RequestMethod, RequestOrigin } from "./types.ts";

export type { BrowserOrigin, RequestMethod, RequestOrigin } from "./types.ts";

export type { RequestCheckCode } from "./checks.ts";
export type { RiskFinding } from "./risk.ts";
export type { SignLogEntry, SignLogOutcome } from "./sign-log.ts";
export type { SignatureResult } from "../transactions/route.ts";
export type { SparkDisplay, SparkResult } from "../payments/action.ts";

/** A Spark, Lightning (including LNURL-pay and lightning addresses) or cooperative-exit payment. */
export type PayInput = { readonly method: "pay"; readonly origin?: BrowserOrigin } & PayParams;

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
  readonly origin: BrowserOrigin;
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
  readonly origin: BrowserOrigin;
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
  readonly origin: BrowserOrigin;
  readonly ref: SparkAccountRef;
  readonly amountSats: number;
  readonly memo?: string;
};

export type RequestInput =
  | ChainRequestInput
  | PayInput
  | ZapInput
  | EvmSignInput
  | NostrSignInput
  | WeblnInvoiceInput
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

/** `webln-invoice` display: the requested amount and memo. */
export type LightningInvoiceDisplay = {
  readonly kind: "lightning.invoice";
  readonly amountSats: number;
  readonly memo?: string;
};

/** A request that ended without a result: `stage` says how, `message` is the failure if any. */
export class RequestEndedError extends Error {
  readonly stage: "rejected" | "failed" | "expired" | "invalidated";
  constructor(stage: RequestEndedError["stage"], message: string | undefined) {
    super(message ?? `request ${stage}`);
    this.name = "RequestEndedError";
    this.stage = stage;
  }
}

/** The origin already has a request in flight; a dApp gets one at a time. */
export class OriginBusyError extends Error {
  constructor(origin: string) {
    super(`${origin} already has an unfinished request`);
    this.name = "OriginBusyError";
  }
}

export type RequestStage =
  | "awaiting-approval"
  | "signing"
  | "submitted"
  | "rejected"
  | "failed"
  | "expired"
  | "invalidated";

export type PendingRequest = {
  readonly id: string;
  readonly origin: RequestOrigin;
  readonly method: RequestMethod;
  readonly account: AccountRef | SparkAccountRef | NostrKeyRef;
  readonly network: string;
  readonly stage: RequestStage;
  /** Decoded locally from the exact content that will be signed; `family` tells the shapes apart. */
  readonly display: DisplayIntent | SparkDisplay | NostrDisplay | LightningInvoiceDisplay;
  /** `unverifiable` as soon as any check is recorded; the host must ask for explicit confirmation. */
  readonly verification: "verified" | "unverifiable";
  readonly checks: ReadonlyArray<RequestCheckCode>;
  /**
   * Recipient risk; independent of `verification`. A `danger` needs the user's explicit
   * acknowledgement.
   */
  readonly risk: ReadonlyArray<RiskFinding>;
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
  readonly openStore: () => Promise<EngineStore>;
  readonly fetch: typeof globalThis.fetch;
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly logger: EngineLogger;
  /** Signs a Nostr event for `nostr-sign` — `nostr(wallet).signer(ref).signEvent`. */
  readonly nostrSign: (ref: NostrKeyRef, event: UnsignedEvent) => Promise<Event>;
};

/** Requests expire this long after creation. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** What approval needs from a prepared request, whichever kind it is. */
type Run =
  | {
      /** A funds or signature request needs the unlock factor at `submit`. */
      readonly factor: "required";
      /** The tracked transaction `submit` creates (chain requests only). */
      readonly txId?: string;
      readonly staleReason: () => string | undefined | Promise<string | undefined>;
      readonly submit: (
        verify: SendParams["verify"],
      ) => Promise<TrackedTransaction | SparkResult | SignatureResult>;
      readonly release: () => void;
    }
  | {
      /** `nostr-sign` is not per-event verifiable (WD-065) — `submit` takes no factor. */
      readonly factor: "none";
      readonly txId?: string;
      readonly staleReason: () => string | undefined | Promise<string | undefined>;
      readonly submit: () => Promise<NostrSignResult | WeblnInvoiceResult>;
      readonly release: () => void;
    };

type Built = {
  readonly account: AccountRef | SparkAccountRef | NostrKeyRef;
  readonly network: string;
  readonly display: DisplayIntent | SparkDisplay | NostrDisplay | LightningInvoiceDisplay;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  readonly risk: ReadonlyArray<RiskFinding>;
  readonly run: Run;
};

type Settler = {
  readonly promise: Promise<
    TrackedTransaction | SparkResult | SignatureResult | NostrSignResult | WeblnInvoiceResult
  >;
  readonly resolve: (
    value:
      | TrackedTransaction
      | SparkResult
      | SignatureResult
      | NostrSignResult
      | WeblnInvoiceResult,
  ) => void;
  readonly reject: (error: Error) => void;
};

type Entry = {
  readonly prepared: Run;
  readonly stopTimer: () => void;
};

const originKey = (origin: BrowserOrigin): string => `origin:${origin.origin}`;

/** The input's browser origin, when it carries one (`evm-sign`/`nostr-sign`/`webln-invoice`/`pay`). */
const browserOriginOf = (input: RequestInput): BrowserOrigin | undefined =>
  "origin" in input ? input.origin : undefined;

const LIVE: ReadonlySet<RequestStage> = new Set(["awaiting-approval", "signing"]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class RequestController extends Controller<RequestControllerState> {
  private readonly options: RequestControllerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly log: SignLog;
  private readonly settlers = new Map<string, Settler>();
  /** Original transaction id → the unfinished request replacing or accelerating it. */
  private readonly targets = new Map<string, string>();
  private locked = true;
  /** Bumped on every unlock and lock so work that outlives a session never touches the next one. */
  private session = 0;

  constructor(options: RequestControllerOptions) {
    super({ name: "requests", defaultState: () => ({ requests: {} }) });
    this.options = options;
    this.log = createSignLog(options.logger);
  }

  async init(): Promise<void> {
    this.session += 1;
    this.locked = false;
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
    this.session += 1;
    this.locked = true;
    for (const [id, request] of Object.entries(this.getState().requests)) {
      if (LIVE.has(request.stage)) {
        this.finish(id, "invalidated");
      }
    }
    this.log.close();
  }

  /** A page navigated away, was revoked or changed network: its unfinished requests are void. */
  invalidateOrigin(origin: string): void {
    for (const [id, request] of Object.entries(this.getState().requests)) {
      if (
        LIVE.has(request.stage) &&
        request.origin.kind === "browser" &&
        request.origin.origin === origin
      ) {
        this.finish(id, "invalidated");
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

  async prepare(input: RequestInput): Promise<PendingRequest> {
    if (this.locked) {
      throw new Error("requests require an unlocked vault");
    }
    const { session } = this;
    const id = newRequestId(this.options.random);
    // A transaction can have one unfinished replacement at a time; claimed synchronously so two
    // concurrent prepares cannot both pass.
    const target = "txId" in input ? input.txId : undefined;
    const browserOrigin = browserOriginOf(input);
    if (browserOrigin !== undefined) {
      const key = originKey(browserOrigin);
      if (this.targets.has(key)) {
        throw new OriginBusyError(browserOrigin.origin);
      }
      this.targets.set(key, id);
    }
    if (target !== undefined) {
      if (this.targets.has(target)) {
        throw new Error(`transaction ${target} already has an unfinished replacement request`);
      }
      this.targets.set(target, id);
    }
    let built: Built;
    try {
      built = await this.build(input, id);
    } catch (error) {
      this.unclaim(id);
      throw error;
    }
    if (session !== this.session) {
      built.run.release();
      this.unclaim(id);
      throw new Error("the vault was locked while the request was being prepared");
    }
    const { checks } = built;
    const createdAt = this.options.now();
    const request: PendingRequest = {
      id,
      origin: browserOrigin ?? { kind: "internal" },
      method: input.method,
      account: built.account,
      network: built.network,
      ...(target === undefined ? {} : { target }),
      stage: "awaiting-approval",
      display: built.display,
      verification: checks.length > 0 ? "unverifiable" : "verified",
      checks,
      risk: built.risk,
      createdAt,
      expiresAt: createdAt + REQUEST_TTL_MS,
    };
    const stopTimer = this.options.setTimer(REQUEST_TTL_MS, () => {
      if (this.getState().requests[id]?.stage === "awaiting-approval") {
        this.finish(id, "expired");
      }
    });
    this.entries.set(id, { prepared: built.run, stopTimer });
    this.put(request);
    this.openSettler(id);
    return request;
  }

  /**
   * Resolves with what `approve` returned, or rejects with `RequestEndedError` when the request
   * ends any other way — how a dApp's pending call learns the outcome.
   */
  async outcome(
    id: string,
  ): Promise<
    TrackedTransaction | SparkResult | SignatureResult | NostrSignResult | WeblnInvoiceResult
  > {
    const settler = this.settlers.get(id);
    if (settler === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    return settler.promise;
  }

  private openSettler(id: string): void {
    const holder: { resolve?: Settler["resolve"]; reject?: Settler["reject"] } = {};
    const promise = new Promise<
      TrackedTransaction | SparkResult | SignatureResult | NostrSignResult | WeblnInvoiceResult
    >((resolve, reject) => {
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

  private settle(
    id: string,
    result:
      | TrackedTransaction
      | SparkResult
      | SignatureResult
      | NostrSignResult
      | WeblnInvoiceResult
      | Error,
  ): void {
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
        submit: async (verify) => action.execute(this.options.spark, verify),
        release: () => undefined,
      },
    };
  }

  private async build(input: RequestInput, id: string): Promise<Built> {
    if (input.method === "pay" || input.method === "zap") {
      const action: PreparedSparkAction =
        input.method === "pay"
          ? await preparePay({ fetch: this.options.fetch, now: this.options.now }, input)
          : prepareZapAction(input.account, input.zap, {
              maxFeeSats: input.maxFeeSats,
              now: this.options.now,
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
        { fetch: this.options.fetch, now: this.options.now },
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
      const prepared = await this.options.transactions.prepareDapp(input.account, input.request);
      const isTransaction = input.request.kind === "evm.transaction";
      return {
        account: prepared.account,
        network: prepared.network,
        display: prepared.intent,
        checks: collectChecks([
          isTransaction && prepared.intent.verifiability !== "full" ? "decode-partial" : undefined,
          ...prepared.checks,
        ]),
        risk: isTransaction ? this.chainRisk(prepared.intent) : [],
        run: { ...prepared, factor: "required" },
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
    const prepared =
      input.method === "send"
        ? await this.options.transactions.prepareSend(input, id)
        : await this.options.transactions.prepareReplacement(input, id);
    return {
      account: prepared.account,
      network: prepared.network,
      display: prepared.intent,
      checks: collectChecks([
        prepared.intent.verifiability === "full" ? undefined : "decode-partial",
        ...prepared.checks,
      ]),
      risk: input.method === "send" ? this.chainRisk(prepared.intent) : [],
      run: { ...prepared, factor: "required" },
    };
  }

  /**
   * Signs and submits a request. Anything but a live, unexpired `send` request with this id throws
   * before any signing; a stale build (nonce taken, blockhash expired) fails without signing.
   */
  async approve(
    id: string,
    method: ChainRequestMethod | "spark-deposit",
    verify?: SendParams["verify"],
  ): Promise<TrackedTransaction>;
  async approve(
    id: string,
    method: "pay" | "zap" | "spark-exit",
    verify?: SendParams["verify"],
  ): Promise<SparkResult>;
  async approve(
    id: string,
    method: "evm-sign",
    verify?: SendParams["verify"],
  ): Promise<TrackedTransaction | SignatureResult>;
  async approve(id: string, method: "nostr-sign"): Promise<NostrSignResult>;
  async approve(id: string, method: "webln-invoice"): Promise<WeblnInvoiceResult>;
  async approve(
    id: string,
    method: RequestMethod,
    verify?: SendParams["verify"],
  ): Promise<
    TrackedTransaction | SparkResult | SignatureResult | NostrSignResult | WeblnInvoiceResult
  > {
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
      this.finish(id, "expired");
      throw new Error(`request ${id} expired`);
    }
    const { session } = this;
    this.put({ ...request, stage: "signing" });

    let stale: string | undefined;
    try {
      stale = await entry.prepared.staleReason();
    } catch (error) {
      stale = errorMessage(error);
    }
    if (session !== this.session) {
      throw new Error(`request ${id} was invalidated`);
    }
    if (stale !== undefined) {
      this.finish(id, "failed", stale);
      throw new Error(stale);
    }
    try {
      const result =
        entry.prepared.factor === "none"
          ? await entry.prepared.submit()
          : await entry.prepared.submit(this.requireVerify(verify));
      if (session === this.session) {
        entry.stopTimer();
        this.entries.delete(id);
        this.unclaim(id);
        const done: PendingRequest = {
          ...this.requireRequest(id),
          stage: "submitted",
          ...("id" in result ? { txId: result.id } : {}),
        };
        this.put(done);
        this.record(done, "submitted", undefined, result);
      } else {
        this.record(request, "submitted");
      }
      this.settle(id, result);
      return result;
    } catch (error) {
      if (session === this.session) {
        this.finish(id, this.failureStage(entry.prepared, error), errorMessage(error));
      } else {
        this.record(request, "failed", errorMessage(error));
      }
      throw error;
    }
  }

  /**
   * A cancelled or refused verification is `rejected`; anything after it is `failed`. Chain
   * requests record which step failed on the tracked transaction; for Spark, the approval round is
   * the only source of `WalletError`.
   */
  private failureStage(run: Run, error: unknown): "rejected" | "failed" {
    if (run.txId === undefined) {
      return error instanceof WalletError ? "rejected" : "failed";
    }
    return this.options.transactions.getState().txs[run.txId]?.state === "rejected"
      ? "rejected"
      : "failed";
  }

  reject(id: string): void {
    const request = this.getState().requests[id];
    if (request === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    if (request.stage !== "awaiting-approval") {
      throw new Error(`request ${id} is ${request.stage}, not awaiting approval`);
    }
    this.finish(id, "rejected");
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

  /** Ends a request in a terminal stage and frees what it reserved. */
  private finish(
    id: string,
    stage: "rejected" | "failed" | "expired" | "invalidated",
    error?: string,
  ): void {
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
    const request = this.getState().requests[id];
    if (request !== undefined) {
      const ended: PendingRequest = {
        ...request,
        stage,
        ...(error === undefined ? {} : { error }),
      };
      this.put(ended);
      this.record(ended, stage, error);
      this.settle(id, new RequestEndedError(stage, error));
    }
  }

  /** Appends the final stage to the signature record; a failed write is a warning, not an error. */
  private record(
    request: PendingRequest,
    outcome: SignLogOutcome,
    error?: string,
    result?:
      | TrackedTransaction
      | SparkResult
      | SignatureResult
      | NostrSignResult
      | WeblnInvoiceResult,
  ): void {
    const { display } = request;
    const eventId =
      result !== undefined && "kind" in result && result.kind === "nostr.event"
        ? result.event.id
        : undefined;
    const summary =
      "kind" in display && display.kind === "nostr.event"
        ? `nostr kind ${display.eventKind}${eventId === undefined ? "" : ` ${eventId}`}`
        : "kind" in display && display.kind === "lightning.invoice"
          ? `lightning invoice ${display.amountSats} sats`
          : "summary" in display
            ? display.summary
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
      .flatMap((tx) => tx.intent?.outflows.map((o) => o.to) ?? []);
    return [...contacts, ...paid];
  }

  private chainRisk(intent: DisplayIntent): ReadonlyArray<RiskFinding> {
    return assessRecipients(
      intent.family,
      intent.outflows.map((o) => o.to),
      this.knownAddresses(intent.family),
    );
  }

  /** Only a Spark transfer has a recipient to check; Lightning and exits are not assessed. */
  private sparkRisk(display: SparkDisplay): ReadonlyArray<RiskFinding> {
    if (display.kind !== "transfer") {
      return [];
    }
    const receiver = normalizeAddress("spark", display.receiver) ?? display.receiver;
    return assessRecipients("spark", [receiver], this.knownAddresses("spark"));
  }
}
