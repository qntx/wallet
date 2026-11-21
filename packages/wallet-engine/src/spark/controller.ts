import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  bitcoinAddressScript,
  decodeBolt11,
  decodeSparkAddress,
  decodeTokenIdentifier,
  encodeSparkAddress,
  parseSparkInvoice,
  SparkInputError,
  SparkRequestError,
  SparkTokenBroadcastError,
  uuidv7,
} from "@qntx/spark";
import type {
  CooperativeExitResult,
  LightningInvoice,
  LightningPayment,
  LightningSendStatus,
  SparkClient,
  SparkPayment,
  SparkTransfer,
} from "@qntx/spark";
import { registerLightningAddress, unregisterLightningAddress } from "@qntx/spark/lnurl";
import type { VerifyFactor } from "@qntx/wallet";
import type { SparkAccountRef, SparkApproveIntent, SparkNetwork } from "@qntx/wallet/protocol";
import type { SparkSigner } from "@qntx/wallet/spark";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore, EngineCollection } from "../store/port.ts";
import { categorize, SparkControllerError } from "./errors.ts";
import { encodePaymentNote, parsePaymentNote } from "./notes.ts";
import type { PaymentNote, SparkActivity } from "./notes.ts";
import { SparkPaymentLedger } from "./payments.ts";
import type { SparkPaymentDraft, SparkPaymentRecord } from "./payments.ts";
import { sparkStore } from "./store.ts";

export type SparkAccountState = {
  readonly status: "locked" | "connecting" | "ready" | "error";
  readonly balanceSats?: number;
  readonly identityPublicKey?: string;
  readonly sparkAddress?: string;
  readonly errorCategory?: string;
  /** First history page (20 entries, newest first), refreshed alongside the balance. */
  readonly recent?: ReadonlyArray<SparkActivity>;
  /** Token balances in base units, refreshed alongside `recent`; absent until the first read. */
  readonly tokens?: ReadonlyArray<SparkTokenBalance>;
  /**
   * This session's payment records by id — every open one, plus those that settled or failed since
   * unlock; absent until the account has one.
   */
  readonly payments?: Readonly<Record<string, SparkPaymentRecord>>;
};

export type SparkTokenBalance = {
  readonly tokenIdentifier: string;
  readonly amount: string;
  readonly outputCount: number;
};

export type SparkControllerState = {
  readonly accounts: Readonly<Record<string, SparkAccountState>>;
};

type SparkApis = {
  readonly signer: (ref: SparkAccountRef) => SparkSigner;
  readonly approve: (params: {
    account: SparkAccountRef;
    intent: SparkApproveIntent;
    verify: VerifyFactor;
  }) => Promise<unknown>;
};

export type SparkClientFactory = (options: {
  readonly ref: SparkAccountRef;
  readonly store: ReturnType<typeof sparkStore>;
  readonly signer: SparkSigner;
  readonly fetch: typeof globalThis.fetch;
}) => SparkClient;

export type SparkControllerOptions = {
  readonly spark: SparkApis;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly createClient: SparkClientFactory;
};

/** The `SparkControllerState.accounts` key of an account. */
export const sparkAccountKey = (ref: SparkAccountRef): string =>
  `${ref.walletId}:${ref.groupIndex}:${ref.network}`;
const key = sparkAccountKey;

/** A commit whose outcome the retries could not settle; `recorded` reports it as unknown. */
class UnknownOutcomeError extends Error {
  readonly inputOutputIds: ReadonlyArray<string> | undefined;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "UnknownOutcomeError";
    this.inputOutputIds =
      cause instanceof SparkTokenBroadcastError ? cause.inputOutputIds : undefined;
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** An exit may only pay an address on the account's own L1 network. */
const assertExitAddress = (address: string, network: SparkNetwork): void => {
  try {
    bitcoinAddressScript(address, network);
  } catch {
    throw new SparkControllerError("rejected", "withdrawal address is not on this network");
  }
};

/**
 * A request's idempotent transfer id: a UUIDv7 — the shape the SO expects — whose random bits are
 * keyed by the request id, so a retry after a lost response resumes the same payment instead of
 * paying twice.
 */
export const sparkTransferId = (requestId: string, createdAt: number): string =>
  uuidv7(
    () => sha256(utf8ToBytes(`qntx/spark/transfer-id\0${requestId}`)).subarray(0, 10),
    () => createdAt,
  );

/** Catch-up sync for one pass: claim every pending transfer, then read balance and identity. */
async function resync(
  client: SparkClient,
  log: (transferId: string, error: unknown) => void,
): Promise<{ balance: number; identity: Uint8Array }> {
  const { failures } = await client.transfers.claimPending();
  for (const failure of failures) {
    log(failure.transferId, failure.error);
  }
  const [balance, identity] = await Promise.all([client.balance(), client.identityPublicKey()]);
  return { balance, identity };
}

/** Abortable backoff — resolves early when the signal aborts; removes its listener. */
export async function eventsBackoff(
  failures: number,
  signal: AbortSignal,
  setTimer: (ms: number, fn: () => void) => () => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const cancel = setTimer(Math.min(2 ** failures, 30) * 1000, () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    const onAbort = (): void => {
      cancel();
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class SparkController extends Controller<SparkControllerState> {
  private readonly options: SparkControllerOptions;
  private engineStore: EngineStore | undefined;
  private readonly accounts = new Map<string, SparkAccountRef>();
  private readonly clients = new Map<string, SparkClient>();
  private readonly ledgers = new Map<string, SparkPaymentLedger>();
  private readonly recentSeq = new Map<string, number>();
  private readonly tokensSeq = new Map<string, number>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(options: SparkControllerOptions) {
    super({ name: "spark", defaultState: () => ({ accounts: {} }) });
    this.options = options;
  }

  /** Engine calls this with the open store on unlock; `undefined` on lock. */
  setStore(store: EngineStore | undefined): void {
    this.engineStore = store;
  }

  /**
   * Declarative account set: refs not yet tracked are patched `locked` and started when the store
   * is open; tracked refs no longer listed are stopped and dropped; running refs stay untouched.
   */
  setAccounts(refs: ReadonlyArray<SparkAccountRef>): void {
    const wanted = new Map(refs.map((ref) => [key(ref), ref]));
    for (const k of this.accounts.keys()) {
      if (!wanted.has(k)) {
        this.accounts.delete(k);
        this.stopAccount(k);
      }
    }
    for (const [k, ref] of wanted) {
      if (!this.accounts.has(k)) {
        this.accounts.set(k, ref);
        this.patch(k, { status: "locked" });
      }
      if (this.engineStore !== undefined && !this.clients.has(k)) {
        this.startAccount(ref);
      }
    }
  }

  async init(): Promise<void> {
    for (const ref of this.accounts.values()) {
      this.startAccount(ref);
    }
    await Promise.resolve();
  }

  async destroy(): Promise<void> {
    await this.lockAll();
  }

  private stopAccount(k: string): void {
    this.aborts.get(k)?.abort();
    this.aborts.delete(k);
    this.clients.get(k)?.close();
    this.clients.delete(k);
    this.ledgers.get(k)?.stop();
    this.ledgers.delete(k);
    this.update((s) => {
      if (!(k in s.accounts)) {
        return s;
      }
      const { [k]: _dropped, ...rest } = s.accounts;
      void _dropped;
      return { ...s, accounts: rest };
    });
  }

  /** Lock: abort every event loop, close every client, reset state. */
  async lockAll(): Promise<void> {
    for (const [k, client] of this.clients) {
      this.aborts.get(k)?.abort();
      client.close();
    }
    for (const ledger of this.ledgers.values()) {
      ledger.stop();
    }
    this.aborts.clear();
    this.clients.clear();
    this.ledgers.clear();
    this.engineStore = undefined;
    await Promise.resolve();
    this.update((s) =>
      Object.keys(s.accounts).length === 0
        ? s
        : {
            ...s,
            accounts: Object.fromEntries(
              Object.keys(s.accounts).map((k) => [k, { status: "locked" as const }]),
            ),
          },
    );
  }

  private startAccount(ref: SparkAccountRef): void {
    const k = key(ref);
    if (this.engineStore === undefined || this.clients.has(k)) {
      return;
    }
    this.patch(k, { status: "connecting" });
    try {
      const col = this.engineStore.collection(`spark-exit-chains:${k}`);
      const client = this.options.createClient({
        ref,
        store: sparkStore(col),
        signer: this.options.spark.signer(ref),
        fetch: this.options.fetch,
      });
      this.clients.set(k, client);
      const ledger = new SparkPaymentLedger({
        collection: this.engineStore.collection(`spark-payments:${k}`),
        client,
        now: this.options.now,
        setTimer: this.options.setTimer,
        logger: this.options.logger,
        onChange: (payments) => {
          this.patch(k, { payments });
        },
      });
      this.ledgers.set(k, ledger);
      void ledger.load();
      const abort = new AbortController();
      this.aborts.set(k, abort);
      // The initial sync lives in the event loop's catch-up pass: a transient failure at
      // account start retries through the loop's backoff instead of leaving the account dead
      // in "error".
      this.runEvents(k, client, abort.signal, ref.network);
    } catch (error) {
      this.patch(k, { status: "error", errorCategory: categorize(error) });
      this.options.logger.warn("spark account failed to start", error);
    }
  }

  private runEvents(
    k: string,
    client: SparkClient,
    signal: AbortSignal,
    network: SparkAccountRef["network"],
  ): void {
    // Every pass resyncs before streaming: the catch-up claim retries anything a previous
    // pass failed on and covers events missed while disconnected — a failed claim is never
    // lost, only deferred one pass. Any throw or a clean stream end backs off (exponential,
    // abortable) and starts a new pass.
    const loop = async (): Promise<void> => {
      let failures = 0;
      while (!signal.aborted) {
        try {
          // Catch-up: claim pending transfers and refresh the balance snapshot. Per-transfer
          // failures are logged, not fatal — one poisoned transfer must not fail the pass.
          // oxlint-disable-next-line no-await-in-loop -- catch-up sync must precede streaming
          const { balance, identity } = await resync(client, (transferId, error) => {
            this.options.logger.warn(
              `spark catch-up claim failed for ${transferId} (${categorize(error)})`,
            );
          });
          if (signal.aborted) {
            return;
          }
          this.patch(k, {
            balanceSats: balance,
            status: "ready",
            identityPublicKey: [...identity].map((b) => b.toString(16).padStart(2, "0")).join(""),
            sparkAddress: encodeSparkAddress({
              network,
              identityPublicKey: identity,
            }),
          });
          void this.refreshRecent(k, client);
          void this.refreshTokens(k, client);
          // Every catch-up also asks the operator about the payments still open.
          void this.ledgers.get(k)?.reconcile();
          const iterator = client.events(signal)[Symbol.asyncIterator]();
          let open = true;
          while (open) {
            // oxlint-disable-next-line no-await-in-loop -- events arrive in stream order
            const item = await iterator.next();
            if (item.done === true) {
              open = false;
            } else {
              const event = item.value;
              if (event.type === "transfer") {
                try {
                  // oxlint-disable-next-line no-await-in-loop -- claims are ordered per event
                  await this.handleTransfer(client, event, signal, k);
                  failures = 0;
                } catch (error) {
                  // A terminal status (expired, returned…) is not a stream failure — log the
                  // transfer and keep consuming the stream.
                  if (!(error instanceof SparkInputError)) {
                    throw error;
                  }
                  this.options.logger.warn(
                    `spark claim of ${event.transferId} rejected (${categorize(error)})`,
                  );
                  failures = 0;
                }
              }
            }
          }
          // A clean end is abnormal for a permanent stream — back off like a failure.
          failures += 1;
          this.options.logger.warn("spark event stream ended — resubscribing");
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          failures += 1;
          if (failures === 1) {
            this.patch(k, { status: "error", errorCategory: categorize(error) });
          }
          this.options.logger.warn("spark event stream failed — resubscribing", error);
        }
        // oxlint-disable-next-line no-await-in-loop -- the backoff bounds resubscribe pace
        await eventsBackoff(failures, signal, this.options.setTimer);
      }
    };
    void loop();
  }

  private async handleTransfer(
    client: SparkClient,
    event: { readonly direction: "incoming" | "outgoing"; readonly transferId: string },
    signal: AbortSignal,
    k: string,
  ): Promise<void> {
    if (event.direction === "incoming") {
      // claim(id) re-queries until the transfer turns claimable — it owns the protocol-level
      // wait for the SSP's claimable window, so no extra delay or pending-list scan here.
      await client.transfers.claim(event.transferId, { signal });
    }
    this.patch(k, { balanceSats: await client.balance() });
    void this.refreshRecent(k, client);
    void this.refreshTokens(k, client);
  }

  private notesCollection(k: string): EngineCollection | undefined {
    return this.engineStore?.collection(`spark-notes:${k}`);
  }

  /** Attach locally written notes to a history page; malformed records warn and drop. */
  private async withNotes(
    k: string,
    payments: ReadonlyArray<SparkPayment>,
  ): Promise<ReadonlyArray<SparkActivity>> {
    const col = this.notesCollection(k);
    if (col === undefined) {
      return payments;
    }
    return Promise.all(
      payments.map(async (payment): Promise<SparkActivity> => {
        const bytes = await col.get(payment.id);
        if (bytes === undefined) {
          return payment;
        }
        let note: PaymentNote | undefined;
        try {
          note = parsePaymentNote(JSON.parse(new TextDecoder().decode(bytes)));
        } catch {
          note = undefined;
        }
        if (note === undefined) {
          // A stored note that fails to parse is store corruption — surface it, but the payment
          // id and the note bytes stay out of the log.
          this.options.logger.warn("spark note record ignored: malformed");
          return payment;
        }
        return { ...payment, note };
      }),
    );
  }

  /**
   * Refill `recent` from the first history page. A failure keeps the previous page — it never
   * touches `status`/`errorCategory`. A per-account sequence keeps a slower older refresh from
   * overwriting a newer one.
   */
  private async refreshRecent(k: string, client: SparkClient): Promise<void> {
    const seq = (this.recentSeq.get(k) ?? 0) + 1;
    this.recentSeq.set(k, seq);
    try {
      const { payments } = await client.transfers.history({ limit: 20 });
      const items = await this.withNotes(k, payments);
      // A stale seq or a closed client (lockAll cleared the map) must not write.
      if (this.recentSeq.get(k) === seq && this.clients.get(k) === client) {
        this.patch(k, { recent: items });
        this.ledgers.get(k)?.observe(payments);
      }
    } catch (error) {
      this.options.logger.warn(`spark recent refresh failed for ${k}`, error);
    }
  }

  /**
   * Refill `tokens` from the client's balance list. Like `refreshRecent`: a failure warns and keeps
   * the previous list — it never touches `status`/`errorCategory` — and the sequence + client
   * identity guard keeps a stale read from overwriting a newer one.
   */
  private async refreshTokens(k: string, client: SparkClient): Promise<void> {
    const seq = (this.tokensSeq.get(k) ?? 0) + 1;
    this.tokensSeq.set(k, seq);
    try {
      const balances = await client.tokens.balances();
      if (this.tokensSeq.get(k) === seq && this.clients.get(k) === client) {
        this.patch(k, {
          tokens: balances.map((b) => ({
            tokenIdentifier: b.tokenIdentifier,
            amount: b.amount.toString(),
            outputCount: b.outputCount,
          })),
        });
      }
    } catch (error) {
      this.options.logger.warn(`spark tokens refresh failed for ${k}`, error);
    }
  }

  private patch(k: string, delta: Partial<SparkAccountState>): void {
    this.update((s) => ({
      ...s,
      accounts: { ...s.accounts, [k]: { status: "locked" as const, ...s.accounts[k], ...delta } },
    }));
  }

  private clientFor(ref: SparkAccountRef): SparkClient {
    return this.connection(ref).client;
  }

  /** A running account's client and payment ledger — they start and stop together. */
  private connection(ref: SparkAccountRef): {
    readonly client: SparkClient;
    readonly ledger: SparkPaymentLedger;
  } {
    const client = this.clients.get(key(ref));
    const ledger = this.ledgers.get(key(ref));
    if (client === undefined || ledger === undefined) {
      throw new SparkControllerError("internal", "account is not connected");
    }
    return { client, ledger };
  }

  /**
   * Runs a committing call under a payment record persisted first — a failed write throws before
   * anything is sent. An unknown outcome leaves the record open and throws `unknown` carrying it; a
   * definite error fails it; a call that returns keeps it `submitted` until the operator's history
   * settles it, unless `settled` reads the final state from the result itself.
   */
  private async recorded<T>(
    ledger: SparkPaymentLedger,
    draft: SparkPaymentDraft,
    call: () => Promise<T>,
    settled?: (result: T) => Pick<SparkPaymentRecord, "transactionHash">,
  ): Promise<T> {
    /* A retry under a new id of a payment still open as unknown would double-pay: only the same
       id (an idempotent resume) or a settled/failed earlier record may proceed. */
    const earlier = ledger.duplicateOf(draft);
    if (earlier !== undefined) {
      throw new SparkControllerError(
        "duplicate",
        `payment ${earlier.id} to this receiver is still unresolved`,
        undefined,
        earlier,
      );
    }
    const record = await ledger.begin(draft);
    let result: T;
    try {
      result = await call();
    } catch (error) {
      /* A sats commit error is not itself a verdict — the library throws the same classes before
         and after the commit request, so only the operator's own listing decides. `check` folds a
         listed final status into the record; anything else stays open as unknown. */
      if (record.kind !== "token") {
        await ledger.check(record);
      }
      if (error instanceof UnknownOutcomeError) {
        const payment = ledger.resolve(record, {
          state: "unknown",
          error: errorText(error.cause),
          ...(error.inputOutputIds === undefined ? {} : { inputOutputIds: error.inputOutputIds }),
        });
        if (payment.state === "failed") {
          throw error;
        }
        throw new SparkControllerError("unknown", error.message, error.cause, payment);
      }
      if (record.kind === "token") {
        /* The library's contract makes first-attempt failures definite: output selection and the
           ownership/metadata checks precede the broadcast, and `broadcastPartialTokenTransaction`
           converts its own uncertain failures to `SparkTokenBroadcastError`. */
        if (
          error instanceof SparkInputError ||
          (error instanceof SparkRequestError && !(error instanceof SparkTokenBroadcastError))
        ) {
          ledger.resolve(record, { state: "failed", error: errorText(error) });
          throw error;
        }
        /* Anything else — e.g. a `SparkError` after the commit response — may have committed; a
           token record without its spent input ids cannot be reconciled, so it stays open as
           unknown. */
        const payment = ledger.resolve(record, { state: "unknown", error: errorText(error) });
        throw new SparkControllerError("unknown", "token transfer outcome unknown", error, payment);
      }
      const payment = ledger.resolve(record, { state: "unknown", error: errorText(error) });
      if (payment.state === "failed") {
        throw error;
      }
      throw new SparkControllerError("unknown", "payment outcome unknown", error, payment);
    }
    if (settled !== undefined) {
      ledger.resolve(record, { state: "settled", ...settled(result) });
    }
    return result;
  }

  /**
   * A definite pre-commit refusal for sats payments: the operator's balance answers before any
   * record exists — an unreadable balance is `network` (nothing is committed), a shortfall is
   * `insufficient-funds`.
   */
  private async requireSats(client: SparkClient, sats: number): Promise<void> {
    let balance: number;
    try {
      balance = await client.balance();
    } catch (error) {
      throw new SparkControllerError("network", "the account balance could not be read", error);
    }
    if (balance < sats) {
      throw new SparkControllerError(
        "insufficient-funds",
        `the balance ${balance} sats does not cover ${sats} sats`,
      );
    }
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SparkControllerError) {
        throw error;
      }
      throw new SparkControllerError(categorize(error), "spark action failed", error);
    }
  }

  /**
   * Runs a committing client call with up to three idempotent retries (1 s, 2 s, 4 s backoff):
   * `retryable` decides which error means the outcome is unknown and the same call may repeat,
   * `call` receives the previous attempt's error so a retry can carry the handle it reported. A
   * definite error on the first attempt propagates; after an uncertain attempt nothing is definite
   * any more — the earlier attempt may have committed — so exhaustion and any later error throw
   * {@link UnknownOutcomeError} with `message`.
   */
  private async committing<T>(
    retryable: (error: unknown) => boolean,
    call: (lastError: unknown) => Promise<T>,
    message: string,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- idempotent retries stay sequential
        return await call(lastError);
      } catch (error) {
        if (!retryable(error)) {
          throw attempt === 0 ? error : new UnknownOutcomeError(message, lastError);
        }
        lastError = error;
        if (attempt < 3) {
          // oxlint-disable-next-line no-await-in-loop -- backoff between idempotent retries
          await new Promise<void>((resolve) => {
            this.options.setTimer(2 ** attempt * 1000, resolve);
          });
        }
      }
    }
    throw new UnknownOutcomeError(message, lastError);
  }

  /**
   * A sats payment commits under its transfer id: a network failure leaves the outcome unknown, so
   * the same call retries under the same id — the SO/SSP deduplicates it.
   */
  private async committed<T>(call: () => Promise<T>): Promise<T> {
    return this.committing(
      (error) => categorize(error) === "network",
      async () => call(),
      "payment outcome unknown",
    );
  }

  /**
   * A token transfer commits under its spent output ids: only `SparkTokenBroadcastError` means the
   * broadcast's outcome is uncertain — a plain network error happened before it — so the retry
   * carries `error.inputOutputIds` and the same terms, per the library's contract.
   */
  private async committedToken<T>(
    call: (inputOutputIds: ReadonlyArray<string> | undefined) => Promise<T>,
  ): Promise<T> {
    return this.committing(
      (error) => error instanceof SparkTokenBroadcastError,
      async (lastError) =>
        call(lastError instanceof SparkTokenBroadcastError ? lastError.inputOutputIds : undefined),
      "token transfer outcome unknown",
    );
  }

  /**
   * One-off balance + activity probe for an account that may not be running: builds a temporary
   * client through the same factory on the account's own exit-chain collection (nothing diverges —
   * `balance()`/`transfers.history` never write it), reads, and closes it in `finally`.
   */
  async inspect(ref: SparkAccountRef): Promise<{ balanceSats: number; used: boolean }> {
    return this.guarded(async () => {
      if (this.engineStore === undefined) {
        throw new SparkControllerError("internal", "engine store is not open");
      }
      const k = key(ref);
      const running = this.clients.get(k);
      if (running !== undefined) {
        const [balance, page] = await Promise.all([
          running.balance(),
          running.transfers.history({ limit: 1 }),
        ]);
        return { balanceSats: balance, used: balance > 0 || page.payments.length > 0 };
      }
      const client = this.options.createClient({
        ref,
        store: sparkStore(this.engineStore.collection(`spark-exit-chains:${k}`)),
        signer: this.options.spark.signer(ref),
        fetch: this.options.fetch,
      });
      try {
        const [balance, page] = await Promise.all([
          client.balance(),
          client.transfers.history({ limit: 1 }),
        ]);
        return { balanceSats: balance, used: balance > 0 || page.payments.length > 0 };
      } finally {
        client.close();
      }
    });
  }

  /** History for one account: a client page merged with locally written notes by id. */
  async history(
    ref: SparkAccountRef,
    options?: {
      readonly limit?: number;
      readonly offset?: number;
    },
  ): Promise<{
    readonly items: ReadonlyArray<SparkActivity>;
    readonly nextOffset: number | undefined;
  }> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      const { payments, nextOffset } = await client.transfers.history({
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
        ...(options?.offset === undefined ? {} : { offset: options.offset }),
      });
      return { items: await this.withNotes(key(ref), payments), nextOffset };
    });
  }

  async send(
    ref: SparkAccountRef,
    params: {
      receiver: string;
      amountSats: number;
      /** The request's idempotent transfer id — a retry resumes, never double-pays. */
      transferId: string;
      verify: VerifyFactor;
      /** Called immediately before the send; a throw there means nothing may be sent. */
      commit: () => void;
    },
  ): Promise<SparkTransfer> {
    return this.guarded(async () => {
      const { client, ledger } = this.connection(ref);
      const receiver = decodeSparkAddress(params.receiver);
      if (receiver.network !== ref.network) {
        throw new SparkControllerError("rejected", "receiver address is on a different network");
      }
      const identity = receiver.identityPublicKey;
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "transfer",
          receivers: [{ identityPublicKey: identity, amountSats: params.amountSats }],
        },
        verify: params.verify,
      });
      params.commit();
      await this.requireSats(client, params.amountSats);
      const transfer = await this.recorded(
        ledger,
        {
          id: params.transferId,
          kind: "transfer",
          receiver: params.receiver,
          amount: String(params.amountSats),
        },
        async () =>
          this.committed(async () =>
            client.transfers.send({
              receiver: params.receiver,
              amountSats: params.amountSats,
              transferId: params.transferId,
            }),
          ),
      );
      void this.refreshRecent(key(ref), client);
      return transfer;
    });
  }

  /**
   * Sends a token amount to a Spark address. The approval intent is the kernel's `token` shape —
   * the raw 32-byte identifier and the receiver's identity key with a canonical decimal amount —
   * and the commit retries only on `SparkTokenBroadcastError`, under the spent output ids it
   * reports; everything else propagates (a plain network failure happened before broadcast).
   */
  async sendToken(
    ref: SparkAccountRef,
    params: {
      /** Spark address of the receiver. */
      receiver: string;
      /** Bech32m token identifier (`btkn`/`btknrt`). */
      tokenIdentifier: string;
      /** Base units, 1…2^128−1. */
      amount: bigint;
      /** The request's idempotent transfer id — keys the payment record. */
      transferId: string;
      verify: VerifyFactor;
      /** Called immediately before the transfer; a throw there means nothing may be sent. */
      commit: () => void;
    },
  ): Promise<string> {
    return this.guarded(async () => {
      const { client, ledger } = this.connection(ref);
      const receiver = decodeSparkAddress(params.receiver);
      if (receiver.network !== ref.network) {
        throw new SparkControllerError("rejected", "receiver address is on a different network");
      }
      let identifier: Uint8Array;
      try {
        const decoded = decodeTokenIdentifier(params.tokenIdentifier);
        if (decoded.network !== ref.network) {
          throw new SparkControllerError("rejected", "token identifier is on a different network");
        }
        identifier = decoded.tokenIdentifier;
      } catch (error) {
        if (error instanceof SparkControllerError) {
          throw error;
        }
        throw new SparkControllerError("rejected", "token identifier is not valid bech32m", error);
      }
      const U128_MAX = 340282366920938463463374607431768211455n;
      if (params.amount <= 0n || params.amount > U128_MAX) {
        throw new SparkControllerError("rejected", "token amount must be 1…2^128−1 base units");
      }
      // Until an uncertain send of this token resolves, its inputs must not be spent by another:
      // "inputs no longer owned" is how that send is recognized as settled.
      if (ledger.holdsToken(params.tokenIdentifier)) {
        throw new SparkControllerError(
          "rejected",
          "an earlier transfer of this token is still unresolved",
        );
      }
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "token",
          tokenIdentifier: identifier,
          receivers: [
            { ownerPublicKey: receiver.identityPublicKey, amount: params.amount.toString() },
          ],
        },
        verify: params.verify,
      });
      params.commit();
      const transactionHash = await this.recorded(
        ledger,
        {
          id: params.transferId,
          kind: "token",
          receiver: params.receiver,
          amount: params.amount.toString(),
          tokenIdentifier: params.tokenIdentifier,
        },
        async () =>
          this.committedToken(async (inputOutputIds) =>
            client.tokens.transfer({
              tokenIdentifier: params.tokenIdentifier,
              amount: params.amount,
              receiver: params.receiver,
              ...(inputOutputIds === undefined ? {} : { inputOutputIds }),
            }),
          ),
        (hash) => ({ transactionHash: hash }),
      );
      void this.refreshTokens(key(ref), client);
      void this.refreshRecent(key(ref), client);
      return transactionHash;
    });
  }

  async registerLightningAddress(
    ref: SparkAccountRef,
    params: { serverUrl: string; domain: string; username: string; description: string },
  ): Promise<{ lnurl: string; lightningAddress: string }> {
    const signer = this.options.spark.signer(ref);
    try {
      return await registerLightningAddress({ ...params, fetch: this.options.fetch, signer });
    } catch (error) {
      if (error instanceof SparkControllerError) {
        throw error;
      }
      // A request error (lnurl_error / http_*) is a network failure — the engine surfaces the
      // category and keeps the upstream error as cause instead of flattening it to internal.
      throw new SparkControllerError(
        error instanceof SparkRequestError ? "network" : "internal",
        "registration failed",
        error,
      );
    }
  }

  async unregisterLightningAddress(
    ref: SparkAccountRef,
    params: { serverUrl: string; domain: string; username: string },
  ): Promise<void> {
    const signer = this.options.spark.signer(ref);
    try {
      await unregisterLightningAddress({ ...params, fetch: this.options.fetch, signer });
    } catch (error) {
      if (error instanceof SparkControllerError) {
        throw error;
      }
      throw new SparkControllerError(
        error instanceof SparkRequestError ? "network" : "internal",
        "unregistration failed",
        error,
      );
    }
  }

  async payInvoice(
    ref: SparkAccountRef,
    params: {
      invoice: string;
      amountSats?: number;
      maxFeeSats: number;
      /** The request's idempotent transfer id — a retry resumes, never double-pays. */
      transferId: string;
      verify: VerifyFactor;
      /** Called immediately before the send; a throw there means nothing may be sent. */
      commit: () => void;
      /** Local annotation written under the payment's transfer id after it succeeds. */
      note?: PaymentNote;
    },
  ): Promise<LightningPayment> {
    return this.guarded(async () => {
      const { client, ledger } = this.connection(ref);
      const decoded = decodeBolt11(params.invoice);
      const amountSats =
        params.amountSats ??
        (decoded.amountMsat === undefined
          ? undefined
          : Math.ceil(Number(decoded.amountMsat) / 1000));
      if (amountSats === undefined) {
        throw new SparkControllerError("rejected", "amountless invoice requires amountSats");
      }
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "lightning",
          invoice: params.invoice,
          ...(params.amountSats === undefined ? {} : { amountSats: params.amountSats }),
          maxFeeSats: params.maxFeeSats,
        },
        verify: params.verify,
      });
      params.commit();
      await this.requireSats(client, amountSats + params.maxFeeSats);
      const payment = await this.recorded(
        ledger,
        {
          id: params.transferId,
          kind: "lightning",
          receiver: bytesToHex(decoded.payee),
          amount: String(amountSats),
        },
        async () =>
          this.committed(async () =>
            client.lightning.pay({
              invoice: params.invoice,
              maxFeeSats: params.maxFeeSats,
              ...(params.amountSats === undefined ? {} : { amountSats: params.amountSats }),
              transferId: params.transferId,
            }),
          ),
      );
      if (params.note !== undefined) {
        try {
          await this.notesCollection(key(ref))?.put(
            payment.transferId,
            encodePaymentNote(params.note),
          );
        } catch (error) {
          // The payment already succeeded — a lost annotation is a warning, not a failure.
          this.options.logger.warn("spark note write failed", error);
        }
      }
      void this.refreshRecent(key(ref), client);
      return payment;
    });
  }

  /**
   * Pays a Spark invoice address. The approval intent mirrors `send`: receiver identity and amount
   * come from the parsed invoice (the supplied `amountSats` fills an open invoice). Then
   * `client.invoices.pay` executes it.
   */
  async paySparkInvoice(
    ref: SparkAccountRef,
    params: {
      invoice: string;
      amountSats?: number;
      /** The request's idempotent transfer id — a retry resumes, never double-pays. */
      transferId: string;
      verify: VerifyFactor;
      /** Called immediately before the send; a throw there means nothing may be sent. */
      commit: () => void;
    },
  ): Promise<SparkTransfer> {
    return this.guarded(async () => {
      const { client, ledger } = this.connection(ref);
      const parsed = parseSparkInvoice(params.invoice, {
        network: ref.network,
        now: this.options.now(),
      });
      const invoicePayment = parsed.fields.payment;
      if (invoicePayment !== undefined && invoicePayment.type !== "sats") {
        throw new SparkControllerError(
          "rejected",
          "spark invoice: only sats invoices are supported",
        );
      }
      if (
        invoicePayment?.type === "sats" &&
        invoicePayment.amount !== undefined &&
        params.amountSats !== undefined &&
        params.amountSats !== invoicePayment.amount
      ) {
        throw new SparkControllerError(
          "rejected",
          "spark invoice: amountSats conflicts with the invoice amount",
        );
      }
      const amountSats =
        invoicePayment?.type === "sats" && invoicePayment.amount !== undefined
          ? invoicePayment.amount
          : params.amountSats;
      if (amountSats === undefined) {
        throw new SparkControllerError(
          "rejected",
          "spark invoice: amountless invoice requires amountSats",
        );
      }
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "transfer",
          receivers: [{ identityPublicKey: parsed.receiverIdentityPublicKey, amountSats }],
        },
        verify: params.verify,
      });
      params.commit();
      await this.requireSats(client, amountSats);
      const result = await this.recorded(
        ledger,
        {
          id: params.transferId,
          kind: "transfer",
          receiver: encodeSparkAddress({
            network: ref.network,
            identityPublicKey: parsed.receiverIdentityPublicKey,
          }),
          amount: String(amountSats),
        },
        async () =>
          this.committed(async () =>
            client.invoices.pay(params.invoice, {
              amount: amountSats,
              transferId: params.transferId,
            }),
          ),
      );
      void this.refreshRecent(key(ref), client);
      // invoices.pay returns a string for token invoices — unreachable after the pre-approval
      // sats check above, kept as the internal guard.
      if (typeof result === "string") {
        throw new SparkControllerError("internal", "unexpected token invoice result");
      }
      return result;
    });
  }

  async createInvoice(
    ref: SparkAccountRef,
    params: { amountSats: number; memo?: string },
  ): Promise<LightningInvoice> {
    return this.guarded(async () =>
      this.clientFor(ref).lightning.createInvoice({
        amountSats: params.amountSats,
        ...(params.memo === undefined ? {} : { memo: params.memo }),
      }),
    );
  }

  /** A fresh single-use L1 deposit address (with the SO's proof of possession). */
  async newDepositAddress(ref: SparkAccountRef): Promise<string> {
    return this.guarded(async () => this.clientFor(ref).deposits.newAddress());
  }

  /** Claims a confirmed L1 deposit paying one of the account's unused deposit addresses. */
  async claimDeposit(ref: SparkAccountRef, transaction: Uint8Array): Promise<void> {
    await this.guarded(async () => this.clientFor(ref).deposits.claim({ transaction }));
  }

  /** The account's last-synced balance — a cached snapshot, not a fresh query. */
  accountBalance(ref: SparkAccountRef): number | undefined {
    return this.getState().accounts[key(ref)]?.balanceSats;
  }

  /** A payment's settle status — `payInvoice` resolves the send; `sendStatus` reports its preimage. */
  async paymentStatus(
    ref: SparkAccountRef,
    request: { readonly requestId: string; readonly paymentHash: Uint8Array },
  ): Promise<LightningSendStatus> {
    return this.guarded(async () => this.clientFor(ref).lightning.sendStatus(request));
  }

  async receiveAddress(ref: SparkAccountRef): Promise<string | undefined> {
    const state = this.getState().accounts[key(ref)];
    await Promise.resolve();
    return state?.sparkAddress;
  }

  /**
   * The SSP's converged cooperative-exit quote for paying `amountSats` to an L1 address: the fee
   * depends on the gross amount, so the quote is re-taken on `amountSats + fee` until it settles.
   */
  async quoteExit(
    ref: SparkAccountRef,
    params: {
      address: string;
      /** Sats that arrive at the address — the exit debits amountSats + fee. */
      amountSats: number;
      speed: "FAST" | "MEDIUM" | "SLOW";
    },
  ): Promise<{ readonly feeSats: number; readonly exitSats: number }> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      assertExitAddress(params.address, ref.network);
      return this.settleExitFee(client, params);
    });
  }

  /**
   * Cooperative exit to an L1 address: `amountSats` arrives at the address and the exit debits
   * `amountSats + fee` of leaves, where `fee` is the SSP's converged quote for the speed —
   * re-quoted here and bounded by `maxFeeSats` before any approval. The intent carries the payout
   * (`amountSats`) and the fee (`maxFeeSats: fee`); the kernel matches the exit output against it.
   */
  async withdraw(
    ref: SparkAccountRef,
    params: {
      address: string;
      /** Sats that arrive at the address — the exit debits amountSats + the quoted fee. */
      amountSats: number;
      speed: "FAST" | "MEDIUM" | "SLOW";
      /** Caller cap on the converged exit fee, in sats. */
      maxFeeSats: number;
      /** The request's idempotent transfer id — a retry resumes, never double-pays. */
      transferId: string;
      verify: VerifyFactor;
      /** Called immediately before the send; a throw there means nothing may be sent. */
      commit: () => void;
    },
  ): Promise<CooperativeExitResult> {
    return this.guarded(async () => {
      const { client, ledger } = this.connection(ref);
      assertExitAddress(params.address, ref.network);
      const { feeSats, exitSats } = await this.settleExitFee(client, params);
      if (feeSats > params.maxFeeSats) {
        throw new SparkControllerError("rejected", "quoted exit fee exceeds maxFeeSats");
      }
      if (feeSats >= params.amountSats) {
        throw new SparkControllerError(
          "insufficient-funds",
          "exit fee meets or exceeds the amount",
        );
      }
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "exit",
          address: params.address,
          amountSats: params.amountSats,
          maxFeeSats: feeSats,
        },
        verify: params.verify,
      });
      params.commit();
      await this.requireSats(client, exitSats);
      const exit = await this.recorded(
        ledger,
        {
          id: params.transferId,
          kind: "exit",
          receiver: params.address,
          amount: String(params.amountSats),
        },
        async () =>
          this.committed(async () =>
            client.withdrawals.cooperativeExit({
              address: params.address,
              speed: params.speed,
              maxFeeSats: feeSats,
              amountSats: exitSats,
              transferId: params.transferId,
            }),
          ),
      );
      void this.refreshRecent(key(ref), client);
      return exit;
    });
  }

  /**
   * Converges the SSP exit fee for a payout: the fee is quoted on the gross amount, so re-quote on
   * `amountSats + fee` until the fee stops growing (three re-quotes at most).
   */
  private async settleExitFee(
    client: SparkClient,
    params: { address: string; amountSats: number; speed: "FAST" | "MEDIUM" | "SLOW" },
  ): Promise<{ readonly feeSats: number; readonly exitSats: number }> {
    const quote = async (amountSats: number): Promise<number> => {
      const quoted = await client.withdrawals.quoteCooperativeExit({
        address: params.address,
        amountSats,
      });
      return quoted.fees[
        params.speed === "FAST" ? "fast" : params.speed === "MEDIUM" ? "medium" : "slow"
      ];
    };
    let fee = await quote(params.amountSats);
    for (let round = 0; round < 3; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each requote depends on the previous fee
      const next = await quote(params.amountSats + fee);
      if (next <= fee) {
        return { feeSats: fee, exitSats: params.amountSats + fee };
      }
      fee = next;
    }
    throw new SparkControllerError("rejected", "exit fee did not settle");
  }
}
