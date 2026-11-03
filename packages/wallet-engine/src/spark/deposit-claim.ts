/**
 * Claims Spark deposits: once a transaction tagged `sparkDeposit` is confirmed, its raw bytes are
 * read from Esplora and handed to the Spark account's `deposits.claim`. Claiming too early (the SO
 * wants enough confirmations) just fails and is retried with backoff; locking stops everything.
 * Works only from the transaction state, so a restart resumes whatever is confirmed and unclaimed.
 */
import { hex } from "@scure/base";

import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type { TrackedTransaction } from "../transactions/route.ts";
import { eventsBackoff } from "./controller.ts";
import type { SparkController } from "./controller.ts";

export type DepositClaimerOptions = {
  readonly transactions: TransactionController;
  readonly spark: SparkController;
  readonly networks: NetworkController;
  readonly logger: EngineLogger;
};

const pending = (tx: TrackedTransaction): boolean =>
  tx.sparkDeposit !== undefined && tx.state === "confirmed" && tx.sparkDeposit.claimed !== true;

export class DepositClaimer {
  private readonly options: DepositClaimerOptions;
  private readonly active = new Map<string, AbortController>();
  private unsubscribe: (() => void) | undefined;

  constructor(options: DepositClaimerOptions) {
    this.options = options;
  }

  /** Starts watching; every confirmed, unclaimed deposit already in the state is picked up. */
  start(): void {
    this.stop();
    this.unsubscribe = this.options.transactions.store.subscribe(() => {
      this.scan();
    });
    this.scan();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const abort of this.active.values()) {
      abort.abort();
    }
    this.active.clear();
  }

  private scan(): void {
    for (const tx of Object.values(this.options.transactions.getState().txs)) {
      if (pending(tx) && !this.active.has(tx.id)) {
        const abort = new AbortController();
        this.active.set(tx.id, abort);
        void this.claim(tx.id, abort.signal);
      }
    }
  }

  private async claim(id: string, signal: AbortSignal): Promise<void> {
    for (let failures = 0; !signal.aborted; failures += 1) {
      const tx = this.options.transactions.getState().txs[id];
      if (tx === undefined || !pending(tx) || tx.sparkDeposit === undefined) {
        break;
      }
      const { walletId, groupIndex, network: sparkNetwork } = tx.sparkDeposit;
      try {
        if (tx.hash === undefined) {
          throw new Error("the deposit has no transaction id");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one attempt at a time, then backoff
        const raw = await this.options.networks.esplora(tx.network).get(`/tx/${tx.hash}/hex`);
        if (typeof raw !== "string") {
          throw new TypeError("esplora returned a malformed transaction");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await this.options.spark.claimDeposit(
          { walletId, groupIndex, network: sparkNetwork },
          hex.decode(raw.trim()),
        );
        if (signal.aborted) {
          break;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await this.options.transactions.markDepositClaimed(id);
        break;
      } catch (error) {
        this.options.logger.warn(`spark deposit ${id} not claimed yet`, error);
        // oxlint-disable-next-line eslint/no-await-in-loop
        await eventsBackoff(failures, signal);
      }
    }
    if (this.active.get(id)?.signal === signal) {
      this.active.delete(id);
    }
  }
}
