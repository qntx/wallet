/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Transitions are serialized on one promise chain,
 * so an unlock→lock flip can never overlap a still-opening store.
 */
import { createSparkClient } from "@qntx/spark";
import type { SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import { BackupController } from "./backup/controller.ts";
import type { CloudStore } from "./backup/port.ts";
import type { EngineLogger } from "./events.ts";
import { parsePayment } from "./payments/parse.ts";
import type { PaymentParse } from "./payments/parse.ts";
import { pay as runPay } from "./payments/pay.ts";
import type { PayParams } from "./payments/pay.ts";
import { resolvePayment } from "./payments/resolve.ts";
import { zap as runZap } from "./payments/zap.ts";
import type { ZapParams, ZapResult } from "./payments/zap.ts";
import { SparkController } from "./spark/controller.ts";
import type { SparkControllerOptions } from "./spark/controller.ts";
import type { EngineStore } from "./store/port.ts";

export type EngineOptions = {
  readonly wallet: Wallet;
  readonly fetch: typeof globalThis.fetch;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly openStore: () => Promise<EngineStore>;
  /** Cloud file transport for the backup controller; absent → `unavailable`. */
  readonly cloud?: CloudStore;
  /** Test seam — defaults to the wallet's real spark proxy. */
  readonly sparkApis?: SparkControllerOptions["spark"];
};

export type WalletEngine = {
  readonly spark: SparkController;
  readonly backup: BackupController;
  readonly zap: (params: ZapParams) => Promise<ZapResult>;
  readonly payments: {
    readonly parse: (input: string, network: SparkNetwork) => PaymentParse;
    readonly resolve: (input: string, network: SparkNetwork) => Promise<PaymentParse>;
    readonly pay: (params: PayParams) => Promise<unknown>;
  };
  readonly unsubscribe: () => void;
};

export function createWalletEngine(options: EngineOptions): WalletEngine {
  const backup = new BackupController({
    wallet: options.wallet,
    cloud: options.cloud,
    now: options.now,
    logger: options.logger,
  });

  const controller = new SparkController({
    spark: options.sparkApis ?? spark(options.wallet),
    fetch: options.fetch,
    random: options.random,
    now: options.now,
    logger: options.logger,
    createClient: ({ ref, store, signer, fetch }) =>
      createSparkClient({
        network: ref.network,
        signer,
        store,
        fetch,
      }),
  });

  // The transition chain: every status change queues behind the previous one, so a late lock
  // always observes the snapshot left by a settled unlock (and vice versa).
  let chain: Promise<void> = Promise.resolve();
  let store: EngineStore | undefined;
  let started = false;

  const transition = async (): Promise<void> => {
    const unlocked = options.wallet.getSnapshot().vault === "unlocked";
    if (unlocked && !started) {
      started = true;
      try {
        store = await options.openStore();
      } catch (error) {
        // No store, no clients — reset so the next status event retries cleanly.
        started = false;
        store = undefined;
        options.logger.warn("engine store failed to open", error);
        return;
      }
      controller.setStore(store);
      backup.setStore(store);
      backup.trigger(); // reconcile — never awaited on the transition chain
      await controller.init();
    } else if (!unlocked && started) {
      started = false;
      await controller.lockAll();
      controller.setStore(undefined);
      const s = store;
      store = undefined;
      await s?.close();
    }
  };

  const snapshotListener = (): void => {
    // Every snapshot change while unlocked nudges the reconcile; the lock transition is
    // handled inside transition() and bumps the backup generation.
    if (options.wallet.getSnapshot().vault === "unlocked") {
      backup.trigger();
    } else {
      backup.lock();
    }
  };

  const schedule = (): void => {
    const previous = chain;
    chain = (async () => {
      try {
        await previous;
        await transition();
      } catch (error) {
        options.logger.warn("engine lock transition failed", error);
      }
    })();
  };
  const unsubscribe = options.wallet.subscribe(() => {
    schedule();
    snapshotListener();
  });
  schedule();
  return {
    spark: controller,
    backup,
    zap: async (params) =>
      runZap(params, {
        fetch: options.fetch,
        nostr: (ref) => nostr(options.wallet).signer(ref),
        spark: controller,
      }),
    payments: {
      parse: (input, network) => parsePayment(input, { network, now: options.now() }),
      resolve: async (input, network) =>
        resolvePayment(input, { network, now: options.now(), fetch: options.fetch }),
      pay: async (params) =>
        runPay({ spark: controller, fetch: options.fetch, now: options.now }, params),
    },
    unsubscribe,
  };
}
