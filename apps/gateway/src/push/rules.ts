/**
 * The dedup/reorg state machine for one (subscription, network, hash) record — pure functions, no
 * I/O, so every branch is mutation-testable. Rules:
 *
 * - Webhook observations never emit; they fill the pending record and schedule a receipt check.
 *   `direction` "out" wins over "in" (a self-transfer notifies as sent), the first transfer is the
 *   display, and at most `TIDS_MAX` activity ids are kept (`x` is shown only when exactly one).
 * - `applyCheck` is the only emitter: included on a pending/gone record emits received/sent/failed
 *   (an incoming failed receipt emits nothing), a re-inclusion after `gone` bumps `generation` so
 *   it is a distinct event id; `ABSENT_LIMIT` consecutive absences on an included record take it to
 *   `gone` and emit `reverted` only when something was notified; `final` stops checking; `unknown`
 *   only moves `nextCheck`.
 * - Records are retained `RECORD_TTL_MS` regardless of status — replayed webhooks must not re-notify.
 */
import type { PushEventKind, PushTransfer } from "@qntx/wallet-engine/gateway/contract";

export type PushRecord = {
  readonly network: string;
  readonly hash: string;
  readonly direction: "in" | "out";
  /** `undefined` only for an engine-registered outgoing watch until its receipt names `from`. */
  readonly address: string | undefined;
  /** Display of the first activity. */
  readonly transfer: PushTransfer | undefined;
  /** Distinct activity ids seen (cap `TIDS_MAX`); `x` is shown only when exactly 1. */
  readonly tids: ReadonlyArray<string>;
  readonly status: "pending" | "included" | "gone" | "final";
  /** The last emitted kind — a `reverted` is owed only after a real notification. */
  readonly notified: PushEventKind | undefined;
  /** Separates a re-inclusion's second "included" from its first — part of the event id. */
  readonly generation: number;
  readonly block: number | undefined;
  /** Consecutive absent checks since the last inclusion. */
  readonly absent: number;
  /** Checks done — drives the re-check delay. */
  readonly checks: number;
  readonly created: number;
  readonly nextCheck: number | undefined;
};

/** One webhook activity item for a watched address of one subscription. */
export type Observation = {
  readonly direction: "in" | "out";
  /** The subscription's own (normalized) address the activity touched. */
  readonly address: string;
  /** The activity's unique id — dedup and the `x` singleton check. */
  readonly tid: string;
  readonly transfer: PushTransfer | undefined;
  /** Alchemy `log.removed`: the activity left the chain in a re-org. */
  readonly removed: boolean;
};

export type CheckResult =
  | { readonly kind: "unknown" }
  | { readonly kind: "absent" }
  | {
      readonly kind: "included";
      readonly success: boolean;
      readonly block: number;
      readonly final: boolean;
      /** The receipt sender — normalized exactly like the subscription's addresses. */
      readonly from: string;
    };

export const ABSENT_LIMIT = 2;
export const RECORD_TTL_MS = 86_400_000;
export const TIDS_MAX = 16;
/** A failed or inconclusive check is retried on the minute, outside the delay ladder. */
const UNKNOWN_DELAY_MS = 60_000;

/** Re-check pacing by checks done: 15 s after the first, a minute through the fifth, then 5 m. */
export const checkDelay = (checks: number): number =>
  checks <= 1 ? 15_000 : checks <= 5 ? 60_000 : 300_000;

/** The record an engine `POST transactions` creates: an outgoing tx before any receipt exists. */
export const newWatchRecord = (network: string, hash: string, now: number): PushRecord => ({
  network,
  hash,
  direction: "out",
  address: undefined,
  transfer: undefined,
  tids: [],
  status: "pending",
  notified: undefined,
  generation: 0,
  block: undefined,
  absent: 0,
  checks: 0,
  created: now,
  nextCheck: now,
});

const recordOf = (obs: Observation, network: string, hash: string, now: number): PushRecord => ({
  network,
  hash,
  direction: obs.direction,
  address: obs.address,
  transfer: obs.transfer,
  tids: [obs.tid],
  status: "pending",
  notified: undefined,
  generation: 0,
  block: undefined,
  absent: 0,
  checks: 0,
  created: now,
  nextCheck: now,
});

/**
 * Folds one observation into the record — never emits. A new key becomes a pending record checked
 * immediately; a `final` record ignores further activity; otherwise the observation dedups by tid,
 * keeps the first transfer, upgrades direction to "out" and reschedules a check right away when the
 * activity was removed or the record is still pending.
 */
export function observe(
  record: PushRecord | undefined,
  obs: Observation,
  network: string,
  hash: string,
  now: number,
): PushRecord {
  if (record === undefined) {
    return recordOf(obs, network, hash, now);
  }
  if (record.status === "final") {
    return record;
  }
  const tids =
    record.tids.includes(obs.tid) || record.tids.length >= TIDS_MAX
      ? record.tids
      : [...record.tids, obs.tid];
  return {
    ...record,
    direction: obs.direction === "out" ? "out" : record.direction,
    address: record.address ?? obs.address,
    transfer: record.transfer ?? obs.transfer,
    tids,
    nextCheck: obs.removed || record.status === "pending" ? now : record.nextCheck,
  };
}

export type CheckOutcome = {
  /** `undefined` means the record is deleted (a watch whose receipt `from` is foreign). */
  readonly record: PushRecord | undefined;
  readonly emit: { readonly kind: PushEventKind; readonly generation: number } | undefined;
};

/**
 * Applies one receipt check. `addresses` is the subscription's normalized address set — a pending
 * outgoing watch survives only when the receipt's `from` belongs to it. Returns the record to
 * persist (or delete) and the one event it may emit.
 */
export function applyCheck(
  record: PushRecord,
  result: CheckResult,
  now: number,
  addresses: ReadonlySet<string>,
): CheckOutcome {
  if (record.status === "final") {
    return { record, emit: undefined };
  }
  if (result.kind === "unknown") {
    return { record: { ...record, nextCheck: now + UNKNOWN_DELAY_MS }, emit: undefined };
  }
  if (result.kind === "absent") {
    let emit: CheckOutcome["emit"];
    let { status } = record;
    let absent = record.absent + 1;
    let { notified } = record;
    if (status === "included" && absent >= ABSENT_LIMIT) {
      status = "gone";
      absent = 0;
      if (notified !== undefined && notified !== "reverted") {
        emit = { kind: "reverted", generation: record.generation };
        notified = "reverted";
      }
    }
    const checks = record.checks + 1;
    return {
      record: {
        ...record,
        status,
        notified,
        absent,
        checks,
        nextCheck: now + checkDelay(checks),
      },
      emit,
    };
  }
  // included
  let { address } = record;
  if (address === undefined) {
    if (!addresses.has(result.from)) {
      return { record: undefined, emit: undefined };
    }
    address = result.from;
  }
  let emit: CheckOutcome["emit"];
  let { status } = record;
  let { notified } = record;
  let { generation } = record;
  let { absent } = record;
  let { block } = record;
  if (status === "pending" || status === "gone") {
    generation += status === "gone" ? 1 : 0;
    const kind =
      record.direction === "in"
        ? result.success
          ? "received"
          : undefined
        : result.success
          ? "sent"
          : "failed";
    if (kind !== undefined) {
      emit = { kind, generation };
      notified = kind;
    }
    status = "included";
    absent = 0;
    ({ block } = result);
  } else if (status === "included") {
    absent = 0;
    ({ block } = result);
  }
  const checks = record.checks + 1;
  return {
    record: {
      ...record,
      address,
      status: result.final ? "final" : status,
      notified,
      generation,
      absent,
      block,
      checks,
      nextCheck: result.final ? undefined : now + checkDelay(checks),
    },
    emit,
  };
}

/** Retention: a record is swept once this old, whatever its status. */
export const expired = (record: PushRecord, now: number): boolean =>
  now - record.created >= RECORD_TTL_MS;
