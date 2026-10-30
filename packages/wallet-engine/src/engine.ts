/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Transitions are serialized on one promise chain,
 * so an unlock→lock flip can never overlap a still-opening store.
 */
import { createSparkClient } from "@qntx/spark";
import type { LightningPayment, SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import type { SparkAccountRef } from "@qntx/wallet/protocol";
import { spark } from "@qntx/wallet/spark";

import { AccountTreeController } from "./accounts/controller.ts";
import { AssetsController } from "./assets/controller.ts";
import { BackupController } from "./backup/controller.ts";
import type { CloudStore } from "./backup/port.ts";
import type { EngineLogger } from "./events.ts";
import { MetaSyncController } from "./meta/controller.ts";
import type { MetaSyncConfig } from "./meta/controller.ts";
import { NetworkController } from "./networks/controller.ts";
import { parsePayment } from "./payments/parse.ts";
import type { PaymentParse } from "./payments/parse.ts";
import { pay as runPay } from "./payments/pay.ts";
import type { PayParams, PayResult } from "./payments/pay.ts";
import { resolvePayment } from "./payments/resolve.ts";
import { payZap, prepareZap } from "./payments/zap.ts";
import type { PrepareZapParams, PreparedZap, PayZapOptions } from "./payments/zap.ts";
import { SparkController } from "./spark/controller.ts";
import type { SparkControllerOptions } from "./spark/controller.ts";
import type { EngineStore } from "./store/port.ts";
import { TransactionController } from "./transactions/controller.ts";

export type EngineOptions = {
  readonly wallet: Wallet;
  /** Every Spark account the engine touches lives on this network. */
  readonly sparkNetwork: SparkNetwork;
  readonly fetch: typeof globalThis.fetch;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly openStore: () => Promise<EngineStore>;
  /** Cloud file transport for the backup controller; absent → `unavailable`. */
  readonly cloud?: CloudStore;
  /** RPC endpoints per network (CAIP-2), ordered by preference for the viem fallback transport. */
  readonly rpc?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Injected timer for transaction polling; defaults to setTimeout. */
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  /** Kind-30078 wallet-metadata sync; absent → every wallet reports `unavailable`. */
  readonly metaSync?: MetaSyncConfig;
  /** Test seam — defaults to the wallet's real spark proxy. */
  readonly sparkApis?: SparkControllerOptions["spark"];
};

export type WalletEngine = {
  readonly networks: NetworkController;
  readonly assets: AssetsController;
  readonly transactions: TransactionController;
  readonly spark: SparkController;
  readonly accounts: AccountTreeController;
  readonly metaSync: MetaSyncController;
  readonly backup: BackupController;
  readonly zaps: {
    readonly prepare: (params: PrepareZapParams) => Promise<PreparedZap>;
    readonly pay: (
      account: SparkAccountRef,
      prepared: PreparedZap,
      options: Omit<PayZapOptions, "now">,
    ) => Promise<LightningPayment>;
  };
  readonly payments: {
    readonly parse: (input: string, network: SparkNetwork) => PaymentParse;
    readonly resolve: (input: string, network: SparkNetwork) => Promise<PaymentParse>;
    readonly pay: (params: PayParams) => Promise<PayResult>;
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

  const networks = new NetworkController({
    fetch: options.fetch,
    rpc: options.rpc ?? {},
    openStore: options.openStore,
    logger: options.logger,
  });

  const assets = new AssetsController({
    networks,
    openStore: options.openStore,
    setTimer:
      options.setTimer ??
      ((ms, fn) => {
        const id = setTimeout(() => {
          void fn();
        }, ms);
        return () => clearTimeout(id);
      }),
    logger: options.logger,
  });

  const transactions = new TransactionController({
    wallet: options.wallet,
    networks,
    openStore: options.openStore,
    random: options.random,
    setTimer:
      options.setTimer ??
      ((ms, fn) => {
        const id = setTimeout(() => {
          void fn();
        }, ms);
        return () => clearTimeout(id);
      }),
    now: options.now,
    logger: options.logger,
  });

  const accounts = new AccountTreeController({
    wallet: options.wallet,
    spark: controller,
    sparkNetwork: options.sparkNetwork,
    networks,
    logger: options.logger,
    now: options.now,
  });

  const metaSync = new MetaSyncController({
    wallet: options.wallet,
    accounts,
    nostr: { signer: (ref) => nostr(options.wallet).signer(ref) },
    metaSync: options.metaSync,
    logger: options.logger,
    now: options.now,
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
      accounts.setStore(store);
      backup.trigger(); // reconcile — never awaited on the transition chain
      // Load + reconcile + drive the selected account through spark.setAccounts.
      await accounts.init();
      await controller.init();
      // Pull → merge → maybe publish for every wallet with a group-0 identity.
      await metaSync.init();
      await networks.init();
      await assets.init();
      await transactions.init();
    } else if (!unlocked && started) {
      started = false;
      transactions.lock();
      assets.lock();
      networks.lock();
      // Lock: cancel sync write-backs, tree → locked, spark.setAccounts([]), totals flush.
      await metaSync.lock();
      await accounts.lock();
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
      accounts.reconcile();
      metaSync.reconcile();
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
    networks,
    assets,
    transactions,
    spark: controller,
    accounts,
    metaSync,
    backup,
    zaps: {
      prepare: async (params) => prepareZap(params, { fetch: options.fetch, now: options.now }),
      pay: async (account, prepared, payOptions) =>
        payZap(controller, account, prepared, { ...payOptions, now: options.now }),
    },
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
