/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Transitions are serialized on one promise chain,
 * so an unlock→lock flip can never overlap a still-opening store.
 */
import { createSparkClient } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import type { EngineLogger } from "./events.ts";
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
  /** Test seam — defaults to the wallet's real spark proxy. */
  readonly sparkApis?: SparkControllerOptions["spark"];
};

export type WalletEngine = {
  readonly spark: SparkController;
  readonly zap: (params: ZapParams) => Promise<ZapResult>;
  readonly unsubscribe: () => void;
};

export function createWalletEngine(options: EngineOptions): WalletEngine {
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
  const unsubscribe = options.wallet.subscribe(schedule);
  schedule();
  return {
    spark: controller,
    zap: async (params) =>
      runZap(params, {
        fetch: options.fetch,
        nostr: (ref) => nostr(options.wallet).signer(ref),
        spark: controller,
      }),
    unsubscribe,
  };
}
