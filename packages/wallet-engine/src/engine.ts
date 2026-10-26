/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Subscribes, never polls.
 */
import { createSparkClient } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { spark } from "@qntx/wallet/spark";

import type { EngineLogger } from "./events.ts";
import { SparkController } from "./spark/controller.ts";
import type { SparkControllerOptions } from "./spark/controller.ts";
import type { EngineStore } from "./store/port.ts";

export type EngineOptions = {
  readonly wallet: Wallet;
  /** Test seam — defaults to the wallet's real spark proxy. */
  readonly sparkApis?: SparkControllerOptions["spark"];
  readonly fetch: typeof globalThis.fetch;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly openStore: () => Promise<EngineStore>;
};

export type WalletEngine = {
  readonly spark: SparkController;
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
        // The signer port is structural — the wallet proxy satisfies it.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        signer: signer as Parameters<typeof createSparkClient>[0]["signer"],
        store,
        fetch,
      }),
  });

  let store: EngineStore | undefined;
  let started = false;
  const onStatus = async (): Promise<void> => {
    const unlocked = options.wallet.getSnapshot().vault === "unlocked";
    if (unlocked && !started) {
      started = true;
      store = await options.openStore();
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
  const unsubscribe = options.wallet.subscribe(() => {
    void onStatus();
  });
  void onStatus();
  return { spark: controller, unsubscribe };
}
