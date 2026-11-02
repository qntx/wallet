/**
 * Request pipeline for internal sends, speed-ups, cancellations and CPFP: `prepare` builds,
 * estimates and cross-checks without signing; `approve(id, method, verify)` is the only way to
 * sign, and only for a live, unexpired request of the right method; locking invalidates everything
 * that has not finished. The unsigned content stays in a private table, never in the state
 * snapshot, and cannot change after prepare.
 */
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type {
  AccountRef,
  DisplayIntent,
  PreparedRequest,
  RequestInput,
  RequestMethod,
  SendParams,
  TrackedTransaction,
} from "../transactions/route.ts";
import { newRequestId } from "../transactions/route.ts";
import { collectChecks } from "./checks.ts";
import type { RequestCheckCode } from "./checks.ts";

export type { RequestCheckCode } from "./checks.ts";
export type { RequestInput, RequestMethod } from "../transactions/route.ts";

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
  readonly origin: { readonly kind: "internal" };
  readonly method: RequestMethod;
  readonly account: AccountRef;
  readonly network: string;
  readonly stage: RequestStage;
  /** Decoded locally from the exact content that will be signed. */
  readonly display: DisplayIntent;
  /** `unverifiable` as soon as any check is recorded; the host must ask for explicit confirmation. */
  readonly verification: "verified" | "unverifiable";
  readonly checks: ReadonlyArray<RequestCheckCode>;
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
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly logger: EngineLogger;
};

/** Requests expire this long after creation. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

type Entry = {
  readonly prepared: PreparedRequest;
  readonly stopTimer: () => void;
};

const LIVE: ReadonlySet<RequestStage> = new Set(["awaiting-approval", "signing"]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class RequestController extends Controller<RequestControllerState> {
  private readonly options: RequestControllerOptions;
  private readonly entries = new Map<string, Entry>();
  /** Original transaction id → the unfinished request replacing or accelerating it. */
  private readonly targets = new Map<string, string>();
  private locked = true;
  /** Bumped on every unlock and lock so work that outlives a session never touches the next one. */
  private session = 0;

  constructor(options: RequestControllerOptions) {
    super({ name: "requests", defaultState: () => ({ requests: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    this.session += 1;
    this.locked = false;
    this.entries.clear();
    this.targets.clear();
    this.update(() => ({ requests: {} }));
    await Promise.resolve();
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
  }

  async prepare(input: RequestInput): Promise<PendingRequest> {
    if (this.locked) {
      throw new Error("requests require an unlocked vault");
    }
    const { session } = this;
    const id = newRequestId(this.options.random);
    // A transaction can have one unfinished replacement at a time; claimed synchronously so two
    // concurrent prepares cannot both pass.
    const target = input.method === "send" ? undefined : input.txId;
    if (target !== undefined) {
      if (this.targets.has(target)) {
        throw new Error(`transaction ${target} already has an unfinished replacement request`);
      }
      this.targets.set(target, id);
    }
    let prepared: PreparedRequest;
    try {
      prepared =
        input.method === "send"
          ? await this.options.transactions.prepareSend(input, id)
          : await this.options.transactions.prepareReplacement(input, id);
    } catch (error) {
      this.unclaim(id);
      throw error;
    }
    if (session !== this.session) {
      prepared.release();
      this.unclaim(id);
      throw new Error("the vault was locked while the request was being prepared");
    }
    const checks = collectChecks([
      prepared.intent.verifiability === "full" ? undefined : "decode-partial",
      ...prepared.checks,
    ]);
    const createdAt = this.options.now();
    const request: PendingRequest = {
      id,
      origin: { kind: "internal" },
      method: input.method,
      account: prepared.account,
      network: prepared.network,
      ...(target === undefined ? {} : { target }),
      stage: "awaiting-approval",
      display: prepared.intent,
      verification: checks.length > 0 ? "unverifiable" : "verified",
      checks,
      createdAt,
      expiresAt: createdAt + REQUEST_TTL_MS,
    };
    const stopTimer = this.options.setTimer(REQUEST_TTL_MS, () => {
      if (this.getState().requests[id]?.stage === "awaiting-approval") {
        this.finish(id, "expired");
      }
    });
    this.entries.set(id, { prepared, stopTimer });
    this.put(request);
    return request;
  }

  /**
   * Signs and submits a request. Anything but a live, unexpired `send` request with this id throws
   * before any signing; a stale build (nonce taken, blockhash expired) fails without signing.
   */
  async approve(
    id: string,
    method: RequestMethod,
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> {
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
      const tx = await entry.prepared.submit(verify);
      if (session === this.session) {
        entry.stopTimer();
        this.entries.delete(id);
        this.unclaim(id);
        this.put({ ...this.requireRequest(id), stage: "submitted", txId: tx.id });
      }
      return tx;
    } catch (error) {
      if (session === this.session) {
        const tracked = this.options.transactions.getState().txs[entry.prepared.txId];
        this.finish(id, tracked?.state === "rejected" ? "rejected" : "failed", errorMessage(error));
      }
      throw error;
    }
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
      this.put({ ...request, stage, ...(error === undefined ? {} : { error }) });
    }
  }
}
