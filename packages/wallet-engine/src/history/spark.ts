import type { SparkAccountRef, SparkNetwork } from "@qntx/wallet/protocol";

import { sparkAccountKey } from "../spark/controller.ts";
import type { SparkControllerState } from "../spark/controller.ts";
import type { SparkActivity } from "../spark/notes.ts";
import type { SparkPaymentRecord, SparkPaymentState } from "../spark/payments.ts";
import type { Stream } from "./merge.ts";
import type { HistoryEntry, HistoryStatus } from "./types.ts";

const PAGE = 25;

export type SparkHistory = (
  ref: SparkAccountRef,
  options?: {
    readonly limit?: number;
    readonly offset?: number;
  },
) => Promise<{
  readonly items: ReadonlyArray<SparkActivity>;
  readonly nextOffset: number | undefined;
}>;

/** The group's view of one Spark payment — read from the Spark operator, `verified` is true. */
export const sparkEntry = (network: string, payment: SparkActivity): HistoryEntry => ({
  id: `spark:${network}:${payment.id}`,
  family: "spark",
  network: `spark:${network}`,
  hash: payment.id,
  direction: payment.direction === "send" ? "out" : "in",
  counterparties: [],
  changes: [
    {
      direction: payment.direction === "send" ? "out" : "in",
      asset: "sats",
      amount: String(payment.amountSats),
      decimals: 8,
      symbol: "BTC",
      listed: true,
    },
  ],
  ...(payment.direction === "send" ? { fee: String(payment.feeSats) } : {}),
  status:
    payment.status === "completed"
      ? "confirmed"
      : payment.status === "failed"
        ? "failed"
        : "pending",
  ...(payment.createdAt === undefined ? {} : { timestamp: payment.createdAt }),
  verified: true,
  origin: "chain",
  flags: [],
});

/** One history stream for the wallet's Spark network: offset-paged until `nextOffset` runs out. */
export const sparkHistoryStream = (
  history: SparkHistory,
  network: SparkNetwork,
  group: { readonly walletId: string; readonly groupIndex: number },
): Stream<HistoryEntry> => {
  let offset: number | undefined;
  let done = false;
  return {
    id: `spark:${network}`,
    next: async () => {
      if (done) {
        return { items: [], done: true };
      }
      const page = await history(
        { ...group, network },
        { limit: PAGE, ...(offset === undefined ? {} : { offset }) },
      );
      offset = page.nextOffset;
      done = page.nextOffset === undefined;
      return { items: page.items.map((payment) => sparkEntry(network, payment)), done };
    },
  };
};

const RECORD_STATUS: Readonly<Record<SparkPaymentState, HistoryStatus>> = {
  submitted: "pending",
  unknown: "pending",
  settled: "confirmed",
  failed: "failed",
  // Genuinely unknown forever — pending, never failed.
  archived: "pending",
};

/**
 * The group's own Spark payment record as a history entry: present from the moment it is submitted
 * — token sends, which the operator's history never lists, included. It shares the operator entry's
 * id, so the operator's view replaces it once listed. `verified` is false — the record is this
 * wallet's own claim.
 */
export const sparkRecordEntry = (
  network: SparkNetwork,
  record: SparkPaymentRecord,
): HistoryEntry => ({
  id: `spark:${network}:${record.id}`,
  family: "spark",
  network: `spark:${network}`,
  hash: record.id,
  direction: "out",
  // A Lightning payee key or an exit's bitcoin address (possibly the group's own) is no Spark
  // counterparty.
  counterparties: record.kind === "transfer" || record.kind === "token" ? [record.receiver] : [],
  changes: [
    record.tokenIdentifier === undefined
      ? {
          direction: "out",
          asset: "sats",
          amount: record.amount,
          decimals: 8,
          symbol: "BTC",
          listed: true,
        }
      : { direction: "out", asset: record.tokenIdentifier, amount: record.amount, listed: false },
  ],
  status: RECORD_STATUS[record.state],
  timestamp: record.submittedAt,
  verified: false,
  origin: "local",
  flags: record.state === "archived" ? ["unresolved"] : [],
});

/** The group's Spark payment records as history entries. */
export const sparkRecordEntries = (
  state: SparkControllerState,
  network: SparkNetwork,
  group: { readonly walletId: string; readonly groupIndex: number },
): ReadonlyArray<HistoryEntry> =>
  Object.values(state.accounts[sparkAccountKey({ ...group, network })]?.payments ?? {}).map(
    (record) => sparkRecordEntry(network, record),
  );

/** Whether any account's payment records changed — other Spark state does not touch history. */
export const sparkRecordsChanged = (
  next: SparkControllerState,
  previous: SparkControllerState,
): boolean =>
  Object.keys({ ...next.accounts, ...previous.accounts }).some(
    (k) => next.accounts[k]?.payments !== previous.accounts[k]?.payments,
  );
