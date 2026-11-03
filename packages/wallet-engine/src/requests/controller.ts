import { WalletError } from "@qntx/wallet";
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
import type { EngineStore } from "../store/port.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  ChainRequestMethod,
  DisplayIntent,
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

export type { RequestCheckCode } from "./checks.ts";
export type { RiskFinding } from "./risk.ts";
export type { SignLogEntry, SignLogOutcome } from "./sign-log.ts";
export type { SignatureResult } from "../transactions/route.ts";
export type { SparkDisplay, SparkResult } from "../payments/action.ts";

/** A Spark, Lightning (including LNURL-pay and lightning addresses) or cooperative-exit payment. */
export type PayInput = { readonly method: "pay" } & PayParams;

/** A prepared zap; its invoice was fetched by `engine.zaps.prepare` and is paid as-is. */
export type ZapInput = {
  readonly method: "zap";
  readonly account: SparkAccountRef;
  readonly zap: PreparedZap;
  readonly maxFeeSats: number;
};

/** A web page; `origin` is `scheme://host[:port]`, computed by the host from the top-level URL. */
export type BrowserOrigin = { readonly kind: "browser"; readonly origin: string };

export type RequestOrigin = { readonly kind: "internal" } | BrowserOrigin;

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

export type RequestMethod = ChainRequestMethod | "pay" | "zap" | "evm-sign";
export type RequestInput = ChainRequestInput | PayInput | ZapInput | EvmSignInput;

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
  readonly account: AccountRef | SparkAccountRef;
  readonly network: string;
  readonly stage: RequestStage;
  /** Decoded locally from the exact content that will be signed; `family` tells the shapes apart. */
  readonly display: DisplayIntent | SparkDisplay;
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
};

/** Requests expire this long after creation. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** What approval needs from a prepared request, whichever kind it is. */
type Run = {
  /** The tracked transaction `submit` creates (chain requests only). */
  readonly txId?: string;
  readonly staleReason: () => string | undefined | Promise<string | undefined>;
  readonly submit: (
    verify: SendParams["verify"],
  ) => Promise<TrackedTransaction | SparkResult | SignatureResult>;
  readonly release: () => void;
};

type Built = {
  readonly account: AccountRef | SparkAccountRef;
  readonly network: string;
  readonly display: DisplayIntent | SparkDisplay;
  readonly checks: ReadonlyArray<RequestCheckCode>;
  readonly risk: ReadonlyArray<RiskFinding>;
  readonly run: Run;
};

type Settler = {
  readonly promise: Promise<TrackedTransaction | SparkResult | SignatureResult>;
  readonly resolve: (value: TrackedTransaction | SparkResult | SignatureResult) => void;
  readonly reject: (error: Error) => void;
};

type Entry = {
  readonly prepared: Run;
  readonly stopTimer: () => void;
};

const isSparkInput = (input: RequestInput): input is PayInput | ZapInput =>
  input.method === "pay" || input.method === "zap";

const originKey = (origin: BrowserOrigin): string => `origin:${origin.origin}`;

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
    const target =
      input.method === "send" || input.method === "evm-sign" || isSparkInput(input)
        ? undefined
        : input.txId;
    if (input.method === "evm-sign") {
      const key = originKey(input.origin);
      if (this.targets.has(key)) {
        throw new OriginBusyError(input.origin.origin);
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
      origin: input.method === "evm-sign" ? input.origin : { kind: "internal" },
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
  async outcome(id: string): Promise<TrackedTransaction | SparkResult | SignatureResult> {
    const settler = this.settlers.get(id);
    if (settler === undefined) {
      throw new Error(`unknown request ${id}`);
    }
    return settler.promise;
  }

  private openSettler(id: string): void {
    const holder: { resolve?: Settler["resolve"]; reject?: Settler["reject"] } = {};
    const promise = new Promise<TrackedTransaction | SparkResult | SignatureResult>(
      (resolve, reject) => {
        holder.resolve = resolve;
        holder.reject = reject;
      },
    );
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
    result: TrackedTransaction | SparkResult | SignatureResult | Error,
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

  private async build(input: RequestInput, id: string): Promise<Built> {
    if (input.method === "pay" || input.method === "zap") {
      const action: PreparedSparkAction =
        input.method === "pay"
          ? await preparePay({ fetch: this.options.fetch, now: this.options.now }, input)
          : prepareZapAction(input.account, input.zap, {
              maxFeeSats: input.maxFeeSats,
              now: this.options.now,
            });
      return {
        account: input.account,
        network: action.display.network,
        display: action.display,
        checks: collectChecks(action.checks),
        risk: this.sparkRisk(action.display),
        run: {
          staleReason: () => action.staleReason(this.options.now()),
          submit: async (verify) => action.execute(this.options.spark, verify),
          release: () => undefined,
        },
      };
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
        run: prepared,
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
      run: prepared,
    };
  }

  /**
   * Signs and submits a request. Anything but a live, unexpired `send` request with this id throws
   * before any signing; a stale build (nonce taken, blockhash expired) fails without signing.
   */
  async approve(
    id: string,
    method: ChainRequestMethod,
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction>;
  async approve(
    id: string,
    method: "pay" | "zap",
    verify: SendParams["verify"],
  ): Promise<SparkResult>;
  async approve(
    id: string,
    method: "evm-sign",
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction | SignatureResult>;
  async approve(
    id: string,
    method: RequestMethod,
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction | SparkResult | SignatureResult> {
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
      const result = await entry.prepared.submit(verify);
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
        this.record(done, "submitted");
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
  private record(request: PendingRequest, outcome: SignLogOutcome, error?: string): void {
    const { display } = request;
    const entry: SignLogEntry = {
      id: request.id,
      at: this.options.now(),
      origin: request.origin,
      method: request.method,
      account: request.account,
      network: request.network,
      summary: "summary" in display ? display.summary : `${display.kind} ${display.amountSats}`,
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
