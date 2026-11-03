/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Transitions are serialized on one promise chain,
 * so an unlock→lock flip can never overlap a still-opening store.
 */
import { createSparkClient } from "@qntx/spark";
import type { LightningInvoice, SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import { AccountTreeController } from "./accounts/controller.ts";
import { AddressBookController } from "./addresses/controller.ts";
import { AssetsController } from "./assets/controller.ts";
import { BackupController } from "./backup/controller.ts";
import type { CloudStore } from "./backup/port.ts";
import { ConnectionController } from "./connect/controller.ts";
import { Eip1193Handler } from "./connect/eip1193.ts";
import { Nip07Handler } from "./connect/nip07.ts";
import type { EngineLogger } from "./events.ts";
import { MetaSyncController } from "./meta/controller.ts";
import type { MetaSyncConfig } from "./meta/controller.ts";
import { NetworkController } from "./networks/controller.ts";
import { parsePayment } from "./payments/parse.ts";
import type { PaymentParse } from "./payments/parse.ts";
import { withdrawLnurl } from "./payments/pay.ts";
import type { WithdrawLnurlParams } from "./payments/pay.ts";
import { resolvePayment } from "./payments/resolve.ts";
import { prepareZap } from "./payments/zap.ts";
import type { PrepareZapParams, PreparedZap } from "./payments/zap.ts";
import { RequestController } from "./requests/controller.ts";
import { SparkController } from "./spark/controller.ts";
import type { SparkControllerOptions } from "./spark/controller.ts";
import { DepositClaimer } from "./spark/deposit-claim.ts";
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
  /**
   * Host endpoints per network (CAIP-2), ordered by preference, for all three chain families: EVM
   * and Solana JSON-RPC URLs, and for Bitcoin the Esplora base URL.
   */
  readonly rpc?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * The wallet gateway: tried first for the networks it serves (read at each unlock) unless a
   * network has custom endpoints. The install id is sent only to the gateway's origin.
   */
  readonly gateway?: { readonly url: string; readonly installId: string };
  /** Injected timer for transaction polling; defaults to setTimeout. */
  /** Development builds: also accept `http://localhost` as a dApp origin. */
  readonly allowLocalhostOrigins?: boolean;
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  /** Kind-30078 wallet-metadata sync; absent → no wallet metadata is synced. */
  readonly metaSync?: MetaSyncConfig;
  /** Test seam — defaults to the wallet's real spark proxy. */
  readonly sparkApis?: SparkControllerOptions["spark"];
};

export type WalletEngine = {
  readonly networks: NetworkController;
  readonly assets: AssetsController;
  readonly transactions: TransactionController;
  readonly requests: RequestController;
  readonly addressBook: AddressBookController;
  readonly connections: ConnectionController;
  readonly eip1193: Eip1193Handler;
  readonly nip07: Nip07Handler;
  /** Read and receive surface; every payment goes through `requests`. */
  readonly spark: Omit<SparkController, "send" | "payInvoice" | "paySparkInvoice" | "withdraw">;
  readonly accounts: AccountTreeController;
  readonly metaSync: MetaSyncController;
  readonly backup: BackupController;
  readonly zaps: {
    readonly prepare: (params: PrepareZapParams) => Promise<PreparedZap>;
  };
  readonly payments: {
    readonly parse: (input: string, network: SparkNetwork) => PaymentParse;
    readonly resolve: (input: string, network: SparkNetwork) => Promise<PaymentParse>;
    /** Receives funds from an LNURL-withdraw service; needs no verification factor. */
    readonly withdrawLnurl: (
      params: WithdrawLnurlParams,
    ) => Promise<{ readonly kind: "lnurl-withdraw"; readonly invoice: LightningInvoice }>;
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
    gateway: options.gateway,
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

  const addressBook = new AddressBookController({
    openStore: options.openStore,
    random: options.random,
    now: options.now,
    logger: options.logger,
  });

  const requests = new RequestController({
    transactions,
    addressBook,
    openStore: options.openStore,
    spark: controller,
    nostrSign: async (ref, event) => nostr(options.wallet).signer(ref).signEvent(event),
    fetch: options.fetch,
    random: options.random,
    now: options.now,
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
    addressBook,
    nostr: { syncSigner: (walletId) => nostr(options.wallet).syncSigner(walletId) },
    metaSync: options.metaSync,
    logger: options.logger,
    now: options.now,
  });

  const depositClaimer = new DepositClaimer({
    transactions,
    spark: controller,
    networks,
    logger: options.logger,
  });
  const connections = new ConnectionController({
    openStore: options.openStore,
    random: options.random,
    now: options.now,
    logger: options.logger,
    allowLocalhost: options.allowLocalhostOrigins ?? false,
    selectedGroup: () => accounts.getState().selected ?? undefined,
    evmAddress: async (group, network) => {
      const account = await chains(options.wallet).account({
        ...group,
        template: "evm.bip44",
        network,
      });
      if (!("address" in account)) {
        throw new Error("no EVM address for the group");
      }
      return account.address;
    },
    enabledNetworks: () => networks.enabled("evm"),
    nostrPubkey: async (ref) => nostr(options.wallet).signer(ref).getPublicKey(),
    invalidate: (origin) => {
      requests.invalidateOrigin(origin);
    },
  });
  const eip1193 = new Eip1193Handler({
    connections,
    requests,
    networks,
    defaultNetwork: () => networks.enabled("evm")[0] ?? "eip155:1",
  });
  const nip07 = new Nip07Handler({
    connections,
    requests,
    signerFor: (ref) => nostr(options.wallet).signer(ref),
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
      await addressBook.init();
      await metaSync.init();
      await networks.init();
      await assets.init();
      await transactions.init();
      await requests.init();
      await connections.init();
      depositClaimer.start();
    } else if (!unlocked && started) {
      started = false;
      depositClaimer.stop();
      connections.lock();
      requests.lock();
      addressBook.lock();
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
    requests,
    addressBook,
    connections,
    eip1193,
    nip07,
    spark: controller,
    accounts,
    metaSync,
    backup,
    zaps: {
      prepare: async (params) => prepareZap(params, { fetch: options.fetch, now: options.now }),
    },
    payments: {
      parse: (input, network) => parsePayment(input, { network, now: options.now() }),
      resolve: async (input, network) =>
        resolvePayment(input, { network, now: options.now(), fetch: options.fetch }),
      withdrawLnurl: async (params) =>
        withdrawLnurl({ spark: controller, fetch: options.fetch, now: options.now }, params),
    },
    unsubscribe,
  };
}
