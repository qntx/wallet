/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Transitions are serialized on one promise chain,
 * so an unlock→lock flip can never overlap a still-opening store.
 */
import type { Event } from "@qntx/nostr";
import { createSparkClient } from "@qntx/spark";
import type { LightningInvoice, SparkNetwork } from "@qntx/spark";
import type { Wallet } from "@qntx/wallet";
import { bitcoinAddressFromXpub, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";
import { normalizeSolana } from "@qntx/wallet-chains/solana";
import { chains } from "@qntx/wallet/chains";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import { AccountTreeController } from "./accounts/controller.ts";
import { AddressBookController } from "./addresses/controller.ts";
import { AssetsController } from "./assets/controller.ts";
import { BackupController } from "./backup/controller.ts";
import type { CloudStore } from "./backup/port.ts";
import { prepareDappPsbts, signDappPsbts } from "./chains/bitcoin-dapp.ts";
import { SolanaChainAdapter } from "./chains/solana.ts";
import { BITCOIN_CHAIN_IDS, BitcoinWalletHandler } from "./connect/bitcoin.ts";
import { ConnectionController } from "./connect/controller.ts";
import { Eip1193Handler } from "./connect/eip1193.ts";
import { Nip07Handler } from "./connect/nip07.ts";
import { SolanaWalletHandler, SOLANA_CHAIN_IDS } from "./connect/solana.ts";
import { WeblnHandler } from "./connect/webln.ts";
import type { EngineLogger } from "./events.ts";
import { MetaSyncController } from "./meta/controller.ts";
import type { MetaSyncConfig } from "./meta/controller.ts";
import { resolveEns } from "./names/ens.ts";
import type { EnsResolution } from "./names/ens.ts";
import { NetworkController } from "./networks/controller.ts";
import { parsePayment } from "./payments/parse.ts";
import type { PaymentParse } from "./payments/parse.ts";
import { withdrawLnurl } from "./payments/pay.ts";
import type { WithdrawLnurlParams } from "./payments/pay.ts";
import { resolvePayment } from "./payments/resolve.ts";
import { prepareZap } from "./payments/zap.ts";
import type { PrepareZapParams, PreparedZap } from "./payments/zap.ts";
import { PhishingController } from "./phishing/controller.ts";
import { RequestController } from "./requests/controller.ts";
import { SparkController } from "./spark/controller.ts";
import type { SparkControllerOptions } from "./spark/controller.ts";
import { DepositClaimer } from "./spark/deposit-claim.ts";
import type { EngineStore, PublicStore } from "./store/port.ts";
import { TransactionController } from "./transactions/controller.ts";
import type { AccountRef, DelegationStatus } from "./transactions/route.ts";

export type EngineOptions = {
  readonly wallet: Wallet;
  /**
   * Verifies events the engine checks itself (external-signer zap requests, relay metadata
   * documents). Required, with no default: `@qntx/nostr`'s own `verifyEvent` is bound to the
   * pure-JS noble backend — pass the host's native verifier, the same one given to the wallet.
   */
  readonly verifyEvent: (event: Event) => boolean;
  /** Every Spark account the engine touches lives on this network. */
  readonly sparkNetwork: SparkNetwork;
  readonly fetch: typeof globalThis.fetch;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  /** The WebLN node's display alias — `getInfo` never exposes a pubkey. */
  readonly weblnAlias: string;
  /** The host's lightning fee cap for WebLN sends — validated to a non-negative safe integer. */
  readonly lightningMaxFee: (amountSats: number) => number;
  readonly logger: EngineLogger;
  readonly openStore: () => Promise<EngineStore>;
  /** The host surfaces a call bundle's status page — `wallet_showCallsStatus` triggers it. */
  readonly showCallsStatus: (request: {
    readonly origin: string;
    readonly txIds: ReadonlyArray<string>;
  }) => void;
  /**
   * Non-secret device data (the phishing list, the origins the user trusts), available while the
   * wallet is locked: a page can be opened before the first unlock.
   */
  readonly publicStore: PublicStore;
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
  /** Development builds: also accept `http://localhost` as a dApp origin. */
  readonly allowLocalhostOrigins?: boolean;
  /** Injected timer for polling and refresh loops; defaults to setTimeout. */
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
  readonly webln: WeblnHandler;
  readonly solanaWallet: SolanaWalletHandler;
  readonly bitcoinWallet: BitcoinWalletHandler;
  /** The phishing list: lifecycle is independent of the lock state. */
  readonly phishing: PhishingController;
  /** Read and receive surface; every payment goes through `requests`. */
  readonly spark: Omit<SparkController, "send" | "payInvoice" | "paySparkInvoice" | "withdraw">;
  readonly accounts: AccountTreeController;
  readonly metaSync: MetaSyncController;
  readonly backup: BackupController;
  readonly zaps: {
    readonly prepare: (params: PrepareZapParams) => Promise<PreparedZap>;
  };
  readonly names: {
    /** Forward-resolves an ENS name for a send on `network`; throws when it cannot resolve. */
    readonly resolve: (name: string, network: string) => Promise<EnsResolution>;
  };
  /** The account's EIP-7702 delegation state on `network`. */
  readonly delegation: (account: AccountRef, network: string) => Promise<DelegationStatus>;
  readonly payments: {
    readonly parse: (input: string, network: SparkNetwork) => PaymentParse;
    readonly resolve: (input: string, network: SparkNetwork) => Promise<PaymentParse>;
    /** Receives funds from an LNURL-withdraw service; needs no verification factor. */
    readonly withdrawLnurl: (
      params: WithdrawLnurlParams,
    ) => Promise<{ readonly kind: "lnurl-withdraw"; readonly invoice: LightningInvoice }>;
  };
  /** Stops listening to the wallet and stops the phishing list refresh. */
  readonly unsubscribe: () => void;
};

const defaultSetTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => {
    clearTimeout(id);
  };
};

export function createWalletEngine(options: EngineOptions): WalletEngine {
  const setTimer = options.setTimer ?? defaultSetTimer;

  const phishing = new PhishingController({
    publicStore: options.publicStore,
    gateway: options.gateway,
    fetch: options.fetch,
    now: options.now,
    setTimer,
    logger: options.logger,
  });
  const startPhishing = async (): Promise<void> => {
    try {
      await phishing.init();
    } catch (error) {
      options.logger.warn("phishing list failed to start", error);
    }
  };
  void startPhishing();
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
    setTimer,
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
    setTimer,
    random: options.random,
  });

  const assets = new AssetsController({
    networks,
    openStore: options.openStore,
    setTimer,
    logger: options.logger,
  });

  const transactions = new TransactionController({
    wallet: options.wallet,
    networks,
    openStore: options.openStore,
    random: options.random,
    setTimer,
    now: options.now,
    logger: options.logger,
  });

  const addressBook = new AddressBookController({
    openStore: options.openStore,
    random: options.random,
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
    setTimer,
  });

  const requests = new RequestController({
    phishing,
    blindSigning: (walletId, groupIndex) => accounts.blindSigning(walletId, groupIndex),
    tokens: {
      metadata: async (network, address) => assets.tokenMetadata(network, address),
      add: async (network, address) => assets.addToken(network, address),
    },
    simulateSolana: async (account, network, message) =>
      new SolanaChainAdapter().simulate(
        networks.solanaRpc(network),
        network,
        account.address,
        message,
        setTimer,
      ),
    transactions,
    addressBook,
    openStore: options.openStore,
    spark: controller,
    nostrSign: async (ref, event) => nostr(options.wallet).signer(ref).signEvent(event),
    solanaSign: async (account, network, request, verify) => {
      const rpc = networks.solanaRpc(network);
      const adapter = new SolanaChainAdapter();
      const hdAccount = {
        kind: "hd" as const,
        walletId: account.walletId,
        groupIndex: account.groupIndex,
        template: "solana.bip44-change" as const,
      };
      if (request.kind === "transactions") {
        const signatures: string[] = [];
        const signedTransactions: Uint8Array[] = [];
        for (const messageBytes of request.transactions) {
          // normalizeSolana validates the fee payer; chains.sign then verifies/signs it.
          normalizeSolana(
            {
              kind: "solana.transaction",
              network,
              account: hdAccount,
              message: messageBytes,
            },
            account.address,
          );
          // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential: each prompts.
          const result = await chains(options.wallet).sign({
            request: {
              kind: "solana.transaction",
              network,
              account: hdAccount,
              message: messageBytes,
            },
            verify,
          });
          if (result.kind !== "solana.transaction" || !(result.signature instanceof Uint8Array)) {
            throw new Error("unexpected solana sign result");
          }
          const wire = adapter.finalize(messageBytes, [result.signature]);
          if (request.send) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- broadcast is sequential per input.
            signatures.push(await adapter.broadcast(rpc, wire));
          } else {
            signedTransactions.push(wire);
          }
        }
        return request.send
          ? { kind: "solana.transactions" as const, send: true, signatures }
          : { kind: "solana.transactions" as const, send: false, signedTransactions };
      }
      normalizeSolana(
        {
          kind: "solana.message",
          format: "raw",
          network,
          account: hdAccount,
          message: request.message,
        },
        account.address,
      );
      const result = await chains(options.wallet).sign({
        request: {
          kind: "solana.message",
          format: "raw",
          network,
          account: hdAccount,
          message: request.message,
        },
        verify,
      });
      if (result.kind !== "solana.message" || !(result.signature instanceof Uint8Array)) {
        throw new Error("unexpected solana sign result");
      }
      return { kind: "solana.message" as const, signature: result.signature };
    },
    bitcoinPrepare: async (account, network, psbts) =>
      prepareDappPsbts(chains(options.wallet), networks.esplora(network), account, network, psbts),
    bitcoinSignPsbts: async (_account, network, prepared, send, verify) => {
      const { signedPsbts, txids } = await signDappPsbts(
        chains(options.wallet),
        networks.esplora(network),
        prepared,
        send,
        verify,
      );
      return { kind: "bitcoin.psbts" as const, signedPsbts, txids };
    },
    bitcoinSign: async (account, network, request, verify) => {
      const result = await chains(options.wallet).sign({
        request: {
          kind: "bitcoin.message",
          network,
          account: {
            kind: "hd",
            walletId: account.walletId,
            groupIndex: account.groupIndex,
            template: account.template,
          },
          address: account.address,
          message: request.message,
          format: "bip322-simple",
          change: 0,
          index: 0,
        },
        verify,
      });
      if (result.kind !== "bitcoin.message") {
        throw new Error("unexpected bitcoin sign result");
      }
      return { kind: "bitcoin.message" as const, signature: result.signature };
    },
    fetch: options.fetch,
    random: options.random,
    now: options.now,
    setTimer,
    logger: options.logger,
  });

  const metaSync = new MetaSyncController({
    wallet: options.wallet,
    accounts,
    addressBook,
    nostr: { syncSigner: (walletId) => nostr(options.wallet).syncSigner(walletId) },
    metaSync: options.metaSync,
    logger: options.logger,
    now: options.now,
    setTimer,
    verifyEvent: options.verifyEvent,
  });

  const depositClaimer = new DepositClaimer({
    transactions,
    spark: controller,
    networks,
    logger: options.logger,
    setTimer,
  });
  const bitcoinAccount = async (
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
    purpose: "payment" | "ordinals",
  ): Promise<{ address: string; publicKey: Uint8Array }> => {
    const template = purpose === "payment" ? "btc.bip84" : "btc.bip86";
    const account = await chains(options.wallet).account({ ...group, template, network });
    if (!("xpub" in account) || account.xpub === undefined) {
      throw new Error("no Bitcoin account for the group");
    }
    return {
      address: bitcoinAddressFromXpub(account.xpub, template, network, 0, 0),
      publicKey: bitcoinPubkeyFromXpub(account.xpub, template, network, 0, 0),
    };
  };
  const connections = new ConnectionController({
    phishing,
    setTimer,
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
    solanaAddress: async (group, network) => {
      const account = await chains(options.wallet).account({
        ...group,
        template: "solana.bip44-change",
        network,
      });
      if (!("address" in account)) {
        throw new Error("no Solana address for the group");
      }
      return account.address;
    },
    bitcoinAddress: async (group, network, purpose) => {
      const { address } = await bitcoinAccount(group, network, purpose);
      return address;
    },
    enabledNetworks: () => [
      ...networks.enabled("evm"),
      ...networks.enabled("solana"),
      ...networks.enabled("bitcoin"),
    ],
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
    isTracked: (network, address) => assets.isTracked(network, address),
    delegationState: async (account, network) => transactions.delegationState(account, network),
    batches: {
      record: async (record) => transactions.recordBatch(record),
      get: (origin, id) => transactions.batchById(origin, id),
    },
    txById: (id) => transactions.txById(id),
    showCallsStatus: options.showCallsStatus,
    now: options.now,
    random: options.random,
  });
  const nip07 = new Nip07Handler({
    connections,
    requests,
    signerFor: (ref) => nostr(options.wallet).signer(ref),
  });
  const webln = new WeblnHandler({
    connections,
    requests,
    spark: controller,
    sparkAccount: () => {
      const group = connections.activeGroup();
      return group === undefined
        ? undefined
        : {
            walletId: group.walletId,
            groupIndex: group.groupIndex,
            network: options.sparkNetwork,
          };
    },
    now: options.now,
    alias: options.weblnAlias,
    lightningMaxFee: options.lightningMaxFee,
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        setTimer(ms, resolve);
      });
    },
  });
  const solanaWallet = new SolanaWalletHandler({
    connections,
    requests,
    solanaAccount: async (group, network) => {
      const account = await chains(options.wallet).account({
        ...group,
        template: "solana.bip44-change",
        network,
      });
      if (
        !("address" in account) ||
        !("publicKey" in account) ||
        !(account.publicKey instanceof Uint8Array)
      ) {
        throw new Error("no Solana account for the group");
      }
      return { address: account.address, publicKey: account.publicKey };
    },
    activeGroup: () => connections.activeGroup(),
    solanaNetwork: () => networks.enabled("solana")[0] ?? SOLANA_CHAIN_IDS["solana:mainnet"] ?? "",
  });

  const bitcoinWallet = new BitcoinWalletHandler({
    connections,
    requests,
    bitcoinAccount,
    activeGroup: () => connections.activeGroup(),
    bitcoinNetwork: () => {
      const enabled = networks.enabled("bitcoin");
      const mainnet = BITCOIN_CHAIN_IDS["bitcoin:mainnet"] ?? "";
      return enabled.includes(mainnet) ? mainnet : (enabled[0] ?? mainnet);
    },
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
    webln,
    solanaWallet,
    bitcoinWallet,
    spark: controller,
    accounts,
    metaSync,
    backup,
    zaps: {
      prepare: async (params) =>
        prepareZap(params, {
          fetch: options.fetch,
          now: options.now,
          verifyEvent: options.verifyEvent,
        }),
    },
    payments: {
      parse: (input, network) => parsePayment(input, { network, now: options.now() }),
      resolve: async (input, network) =>
        resolvePayment(input, { network, now: options.now(), fetch: options.fetch }),
      withdrawLnurl: async (params) =>
        withdrawLnurl({ spark: controller, fetch: options.fetch, now: options.now }, params),
    },
    names: {
      resolve: async (name, network) => resolveEns(networks, name, network),
    },
    delegation: async (account: AccountRef, network: string) =>
      transactions.delegationState(account, network),
    phishing,
    unsubscribe: () => {
      unsubscribe();
      void phishing.destroy();
    },
  };
}
