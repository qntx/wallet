/**
 * Every wallet-initiated Spark payment as a durable record: written before the SDK call that
 * commits value, resolved only from the Spark operator's own answer. A lost commit response or a
 * restart therefore never loses a payment that may have gone out, and nothing is reported failed
 * unless the operator says so.
 */
import * as z from "zod/mini";

import type { SparkClient, SparkPayment, SparkTokenOutput } from "@qntx/spark";

import type { EngineLogger } from "../events.ts";
import { readJson } from "../store/json.ts";
import type { EngineCollection } from "../store/port.ts";
import { repeat } from "../timer.ts";
import type { SetTimer } from "../timer.ts";

/** A Spark send or Spark invoice, a Lightning payment, a cooperative exit, or a token send. */
export type SparkPaymentKind = "transfer" | "lightning" | "exit" | "token";

/**
 * `submitted`: persisted before the commit call, and kept after it returned until the operator
 * reports a final status. `unknown`: the commit response was lost — it may have committed.
 * `settled` and `failed` are the operator's final answer.
 */
export type SparkPaymentState = "submitted" | "unknown" | "settled" | "failed";

/** One wallet-initiated Spark payment, from just before its commit call to the operator's answer. */
export type SparkPaymentRecord = {
  /** The request's idempotent transfer id — for sats payments, the Spark transfer id. */
  readonly id: string;
  readonly kind: SparkPaymentKind;
  readonly state: SparkPaymentState;
  /** Spark address, Lightning payee public key (hex) or bitcoin address. */
  readonly receiver: string;
  /** Decimal base units: sats, or the token's base units. */
  readonly amount: string;
  /** Token payments: the bech32m token identifier. */
  readonly tokenIdentifier?: string;
  /** Token payments whose broadcast outcome was uncertain: the outputs it spends. */
  readonly inputOutputIds?: ReadonlyArray<string>;
  /** Settled token payments: the final transaction hash. */
  readonly transactionHash?: string;
  /** Milliseconds since the epoch, taken just before the commit call. */
  readonly submittedAt: number;
  /** Why the payment failed, or why its outcome is unknown. */
  readonly error?: string;
};

export type SparkPaymentDraft = Pick<
  SparkPaymentRecord,
  "id" | "kind" | "receiver" | "amount" | "tokenIdentifier"
>;

type Outcome = Partial<
  Pick<SparkPaymentRecord, "state" | "error" | "inputOutputIds" | "transactionHash">
>;

/** Each open record is re-checked after this, doubling per inconclusive check up to the cap. */
export const RECONCILE_BASE_MS = 15_000;
export const RECONCILE_MAX_MS = 600_000;
/**
 * A sats payment the operator still does not list this long after submission never committed: every
 * commit call has long ended, and an uncommitted SSP request expires within minutes.
 */
export const ABSENT_FAIL_MS = 1_800_000;
const HISTORY_PAGE = 100;
const HISTORY_MAX_PAGES = 10;
/** Operator timestamps may run behind the device clock by up to this much. */
const CLOCK_SKEW_MS = 600_000;

export const isOpen = (record: SparkPaymentRecord): boolean =>
  record.state === "submitted" || record.state === "unknown";

/** Open, and the operator can be asked about it — a token send needs its spent output ids. */
const reconcilable = (record: SparkPaymentRecord): boolean =>
  isOpen(record) && (record.kind !== "token" || record.inputOutputIds !== undefined);

const recordSchema = z.object({
  id: z.string(),
  kind: z.enum(["transfer", "lightning", "exit", "token"]),
  state: z.enum(["submitted", "unknown"]),
  receiver: z.string(),
  amount: z.string().check(z.regex(/^[0-9]+$/)),
  tokenIdentifier: z.optional(z.string()),
  inputOutputIds: z.optional(z.array(z.string())),
  submittedAt: z.number(),
  error: z.optional(z.string()),
});

export const encodePaymentRecord = (record: SparkPaymentRecord): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(record));

/** A stored open record, or `undefined` for anything off-shape or not stored under its own id. */
export const decodePaymentRecord = (
  key: string,
  bytes: Uint8Array,
): SparkPaymentRecord | undefined => {
  const parsed = recordSchema.safeParse(readJson(bytes));
  if (!parsed.success || parsed.data.id !== key) {
    return undefined;
  }
  const { tokenIdentifier, inputOutputIds, error, ...fields } = parsed.data;
  return {
    ...fields,
    ...(tokenIdentifier === undefined ? {} : { tokenIdentifier }),
    ...(inputOutputIds === undefined ? {} : { inputOutputIds }),
    ...(error === undefined ? {} : { error }),
  };
};

/** The operator's final answer in one history entry, if it has given one. */
export const paymentOutcome = (payment: SparkPayment): Outcome | undefined => {
  if (payment.status === "completed") {
    return { state: "settled" };
  }
  return payment.status === "failed"
    ? { state: "failed", error: "the Spark operator reports the payment failed" }
    : undefined;
};

/**
 * A token send's outcome from the outputs this identity still owns: an input that is `available`
 * again was spent by no live transaction, and the consumed approval can never sign one; inputs no
 * longer owned were spent. Anything else (`pending-outbound`) is still undecided.
 */
export const tokenOutcome = (
  inputOutputIds: ReadonlyArray<string>,
  outputs: ReadonlyArray<SparkTokenOutput>,
): Outcome | undefined => {
  const owned = new Map(outputs.map((output) => [output.id, output]));
  if (inputOutputIds.some((id) => owned.get(id)?.status === "available")) {
    return { state: "failed", error: "the token transfer did not commit: its inputs are unspent" };
  }
  return inputOutputIds.every((id) => !owned.has(id)) ? { state: "settled" } : undefined;
};

/**
 * Pages the operator's history newest first for `ids`. `complete` means the listing ended or went
 * past `since` (less the clock-skew margin) — an id not found then is not listed at all.
 */
export const findPayments = async (
  history: SparkClient["transfers"]["history"],
  ids: ReadonlySet<string>,
  since: number,
): Promise<{ readonly found: ReadonlyMap<string, SparkPayment>; readonly complete: boolean }> => {
  const found = new Map<string, SparkPayment>();
  let offset = 0;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page starts at the previous one's end
    const { payments, nextOffset } = await history({ limit: HISTORY_PAGE, offset });
    for (const payment of payments) {
      if (ids.has(payment.id)) {
        found.set(payment.id, payment);
      }
    }
    const passedSince = payments.some(
      (payment) => payment.createdAt !== undefined && payment.createdAt < since - CLOCK_SKEW_MS,
    );
    if (found.size === ids.size || nextOffset === undefined || passedSince) {
      return { found, complete: true };
    }
    offset = nextOffset;
  }
  return { found, complete: false };
};

export type SparkPaymentLedgerOptions = {
  readonly collection: EngineCollection;
  readonly client: Pick<SparkClient, "transfers" | "tokens">;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  readonly logger: EngineLogger;
  /** Every change of the record set while the ledger runs. */
  readonly onChange: (records: Readonly<Record<string, SparkPaymentRecord>>) => void;
};

/**
 * One account's payment records. Store rows hold only open records — a final state deletes its row
 * and stays in memory for the session. Reconciliation runs at load, whenever the controller asks,
 * and on a backed-off poll while reconcilable records remain; after `stop` nothing is written or
 * reported.
 */
export class SparkPaymentLedger {
  private readonly options: SparkPaymentLedgerOptions;
  private records: Readonly<Record<string, SparkPaymentRecord>> = {};
  private readonly backoff = new Map<string, { checks: number; dueAt: number }>();
  private stopped = false;
  private stopPoll: (() => void) | undefined;
  private running: Promise<void> | undefined;

  constructor(options: SparkPaymentLedgerOptions) {
    this.options = options;
  }

  /** Loads the open records left by earlier sessions, then reconciles them once. */
  async load(): Promise<void> {
    const { collection, logger } = this.options;
    const loaded: Record<string, SparkPaymentRecord> = {};
    try {
      const keys = await collection.list();
      for (const key of keys) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- rows load one at a time
        const bytes = await collection.get(key);
        const record = bytes === undefined ? undefined : decodePaymentRecord(key, bytes);
        if (record === undefined) {
          logger.warn("spark payment record ignored: unreadable");
        } else {
          loaded[key] = record;
        }
      }
    } catch (error) {
      logger.warn("spark payment records failed to load", error);
      return;
    }
    if (this.stopped) {
      return;
    }
    if (Object.keys(loaded).length > 0) {
      this.records = { ...loaded, ...this.records };
      this.changed();
    }
    await this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    this.stopPoll?.();
    this.stopPoll = undefined;
  }

  /** An open token send still holds outputs of this token — another send could spend them. */
  holdsToken(tokenIdentifier: string): boolean {
    return Object.values(this.records).some(
      (record) => record.tokenIdentifier === tokenIdentifier && reconcilable(record),
    );
  }

  /** Persists the record before the commit call; a failed write throws and nothing may be sent. */
  async begin(draft: SparkPaymentDraft): Promise<SparkPaymentRecord> {
    const record: SparkPaymentRecord = {
      ...draft,
      state: "submitted",
      submittedAt: this.options.now(),
    };
    await this.options.collection.put(record.id, encodePaymentRecord(record));
    this.records = { ...this.records, [record.id]: record };
    this.changed();
    return record;
  }

  /** Applies an outcome to an open record; a final record never changes again. */
  resolve(record: SparkPaymentRecord, outcome: Outcome): SparkPaymentRecord {
    const current = this.records[record.id] ?? record;
    if (!isOpen(current)) {
      return current;
    }
    const next: SparkPaymentRecord = { ...current, ...outcome };
    if (this.stopped) {
      return next;
    }
    this.records = { ...this.records, [next.id]: next };
    if (!isOpen(next)) {
      this.backoff.delete(next.id);
    }
    this.persist(next);
    this.changed();
    return next;
  }

  /**
   * Whether the operator lists this record's transfer, asked right after a commit call failed:
   * `listed` also folds a final status into the record; `absent` only when a complete read past
   * `submittedAt` does not carry it; an incomplete listing or a failed read answers `unknown`.
   */
  async check(record: SparkPaymentRecord): Promise<"listed" | "absent" | "unknown"> {
    let page: { readonly found: ReadonlyMap<string, SparkPayment>; readonly complete: boolean };
    try {
      page = await findPayments(
        this.options.client.transfers.history,
        new Set([record.id]),
        record.submittedAt,
      );
    } catch {
      return "unknown";
    }
    const payment = page.found.get(record.id);
    if (payment === undefined) {
      return page.complete ? "absent" : "unknown";
    }
    this.observe([payment]);
    return "listed";
  }

  /** Resolves open sats records listed in a history page the controller already read. */
  observe(payments: ReadonlyArray<SparkPayment>): void {
    for (const payment of payments) {
      const record = this.records[payment.id];
      const outcome = paymentOutcome(payment);
      if (record !== undefined && record.kind !== "token" && outcome !== undefined) {
        this.resolve(record, outcome);
      }
    }
  }

  /** One pass over the records that are due; concurrent callers share the running pass. */
  async reconcile(): Promise<void> {
    if (this.running !== undefined) {
      return this.running;
    }
    const run = (async (): Promise<void> => {
      try {
        await this.pass();
      } finally {
        this.running = undefined;
      }
    })();
    this.running = run;
    return run;
  }

  private async pass(): Promise<void> {
    const now = this.options.now();
    const due = Object.values(this.records).filter(
      (record) => reconcilable(record) && (this.backoff.get(record.id)?.dueAt ?? 0) <= now,
    );
    const outcomes = new Map<string, Outcome>();
    const sats = due.filter((record) => record.kind !== "token");
    if (sats.length > 0) {
      try {
        const { found, complete } = await findPayments(
          this.options.client.transfers.history,
          new Set(sats.map((record) => record.id)),
          Math.min(...sats.map((record) => record.submittedAt)),
        );
        for (const record of sats) {
          const payment = found.get(record.id);
          const outcome =
            payment === undefined
              ? complete && now - record.submittedAt >= ABSENT_FAIL_MS
                ? { state: "failed" as const, error: "the Spark operator lists no such transfer" }
                : undefined
              : paymentOutcome(payment);
          if (outcome !== undefined) {
            outcomes.set(record.id, outcome);
          }
        }
      } catch (error) {
        this.options.logger.warn("spark payment reconciliation failed", error);
      }
    }
    const tokens = new Set(due.flatMap((record) => record.tokenIdentifier ?? []));
    for (const tokenIdentifier of tokens) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one token's outputs at a time
        const outputs = await this.options.client.tokens.outputs({ tokenIdentifier });
        for (const record of due) {
          const outcome =
            record.tokenIdentifier === tokenIdentifier && record.inputOutputIds !== undefined
              ? tokenOutcome(record.inputOutputIds, outputs)
              : undefined;
          if (outcome !== undefined) {
            outcomes.set(record.id, outcome);
          }
        }
      } catch (error) {
        this.options.logger.warn("spark token reconciliation failed", error);
      }
    }
    if (this.stopped) {
      return;
    }
    for (const record of due) {
      const outcome = outcomes.get(record.id);
      if (outcome === undefined) {
        const checks = (this.backoff.get(record.id)?.checks ?? 0) + 1;
        this.backoff.set(record.id, {
          checks,
          dueAt: now + Math.min(RECONCILE_BASE_MS * 2 ** (checks - 1), RECONCILE_MAX_MS),
        });
      } else {
        this.resolve(record, outcome);
      }
    }
  }

  private persist(record: SparkPaymentRecord): void {
    const { collection, logger } = this.options;
    const write = async (): Promise<void> => {
      try {
        await (isOpen(record)
          ? collection.put(record.id, encodePaymentRecord(record))
          : collection.delete(record.id));
      } catch (error) {
        // The row keeps its previous open state, so the next session reconciles it again.
        logger.warn("spark payment record write failed", error);
      }
    };
    void write();
  }

  /** Reports the record set and runs the poll exactly while reconcilable records remain. */
  private changed(): void {
    if (this.stopped) {
      return;
    }
    this.options.onChange(this.records);
    const open = Object.values(this.records).some(reconcilable);
    if (open && this.stopPoll === undefined) {
      this.stopPoll = repeat(
        this.options.setTimer,
        RECONCILE_BASE_MS,
        async () => this.reconcile(),
        (error) => {
          this.options.logger.warn("spark payment reconciliation failed", error);
        },
      );
    } else if (!open) {
      this.stopPoll?.();
      this.stopPoll = undefined;
    }
  }
}
