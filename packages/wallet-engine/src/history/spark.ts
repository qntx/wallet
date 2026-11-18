import type { SparkAccountRef, SparkNetwork } from "@qntx/wallet/protocol";

import type { SparkActivity } from "../spark/notes.ts";
import type { Stream } from "./merge.ts";
import type { HistoryEntry } from "./types.ts";

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
