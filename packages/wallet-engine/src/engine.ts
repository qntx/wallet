/**
 * Composition root: wires the Wallet's lock state to the SparkController's lifecycle. Unlocked →
 * open the EngineStore and start every declared account; locked → abort event loops, close every
 * client, close the store and reset account state. Transitions are serialized on one promise chain,
 * so an unlock→lock flip can never overlap a still-opening store.
 */
import { base58 } from "@scure/base";
import type { StoreApi } from "zustand/vanilla";

import type { Event } from "@qntx/nostr";
import { createSparkClient } from "@qntx/spark";
import type { LightningInvoice, SparkNetwork } from "@qntx/spark";
import type { KeysApi, Wallet } from "@qntx/wallet";
import { bitcoinAddressFromXpub, bitcoinPubkeyFromXpub } from "@qntx/wallet-chains/bitcoin";
import {
  addSolanaSignature,
  decodeSolana,
  decodeSolanaTransaction,
  normalizeSolana,
} from "@qntx/wallet-chains/solana";
import { chains } from "@qntx/wallet/chains";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";

import { AccountTreeController } from "./accounts/controller.ts";
import { WatchController } from "./accounts/watch.ts";
import type { WatchAccount } from "./accounts/watch.ts";
import { AddressBookController } from "./addresses/controller.ts";
import { AssetsController } from "./assets/controller.ts";
import type { AccountBalances } from "./assets/controller.ts";
import { BackupController } from "./backup/controller.ts";
import type { CloudStore } from "./backup/port.ts";
import { prepareDappPsbts, signDappPsbts } from "./chains/bitcoin-dapp.ts";
import { SOLANA_MAX_PROCESSING_AGE, SolanaChainAdapter } from "./chains/solana.ts";
import { BITCOIN_CHAIN_IDS, BitcoinWalletHandler } from "./connect/bitcoin.ts";
import { ConnectionController } from "./connect/controller.ts";
import { Eip1193Handler } from "./connect/eip1193.ts";
import { Nip07Handler } from "./connect/nip07.ts";
import { SolanaWalletHandler, SOLANA_CHAIN_IDS } from "./connect/solana.ts";
import { TronWalletHandler } from "./connect/tron.ts";
import { WeblnHandler } from "./connect/webln.ts";
import type { Controller } from "./controller.ts";
import type { EngineLogger } from "./events.ts";
import { gatewayFetch, gatewaySession } from "./gateway/client.ts";
import { HistoryController } from "./history/controller.ts";
import { lidoPosition } from "./lido/index.ts";
import type { LidoPosition } from "./lido/index.ts";
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
import { PricesController } from "./prices/controller.ts";
import { groupHoldings, heldAssets } from "./prices/holdings.ts";
import { valueHoldings } from "./prices/valuation.ts";
import type { Valuation } from "./prices/valuation.ts";
import { RequestController } from "./requests/controller.ts";
import { SparkController } from "./spark/controller.ts";
import type { SparkControllerOptions } from "./spark/controller.ts";
import { DepositClaimer } from "./spark/deposit-claim.ts";
import { stakePositions, stakeValidators } from "./staking/index.ts";
import type { StakePosition, StakeValidator } from "./staking/index.ts";
import type { EngineStore, PublicStore } from "./store/port.ts";
import type { AcrossBridgeQuote, AcrossBridgeStatus } from "./swaps/bridge.ts";
import type { SwapQuote } from "./swaps/index.ts";
import {
  fetchBridgeQuote,
  fetchBridgeStatus,
  fetchJupiterQuote,
  fetchSwapQuote,
} from "./swaps/quote.ts";
import { ownBitcoinTxids } from "./transactions/bitcoin.ts";
import { submitInOrder } from "./transactions/broadcast.ts";
import { TransactionController } from "./transactions/controller.ts";
import { accountAddress } from "./transactions/route.ts";
import type { AccountRef, DelegationStatus, DisplayIntent } from "./transactions/route.ts";

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
   * Host endpoints per network (CAIP-2), ordered by preference, per family: EVM and Solana JSON-RPC
   * URLs, the Esplora base URL for Bitcoin, full-node HTTP base URLs for TRON.
   */
  readonly rpc?: Readonly<Record<string, ReadonlyArray<string>>>;
  /**
   * The wallet gateway: tried first for the networks it serves (read at each unlock) unless a
   * network has custom endpoints. The engine draws per-session, per-scope client ids — sent only to
   * the gateway's origin — so requests cannot be joined across families or installs.
   */
  readonly gateway?: { readonly url: string };
  /** Development builds: also accept `http://localhost` as a dApp origin. */
  readonly allowLocalhostOrigins?: boolean;
  /**
   * Injected one-shot timer with `setTimeout` semantics (each call runs `fn` at most once); polling
   * loops re-arm it after every run. Defaults to setTimeout.
   */
  readonly setTimer?: (ms: number, fn: () => void) => () => void;
  /** Kind-30078 wallet-metadata sync; absent → no wallet metadata is synced. */
  readonly metaSync?: MetaSyncConfig;
  /** Test seam — defaults to the wallet's real spark proxy. */
  readonly sparkApis?: SparkControllerOptions["spark"];
};

/** A controller's store without `setState`: hosts read and subscribe, only the engine writes. */
export type ReadonlyStore<S> = Pick<StoreApi<S>, "getState" | "getInitialState" | "subscribe">;

/**
 * Read-only view all the way down: primitives and functions pass through, `Uint8Array` and the
 * other ArrayBuffer views stay as-is (they are runtime-frozen only as objects, and their contents
 * are engine inputs anyway — the runtime freeze cannot cover them), arrays become ReadonlyArray,
 * Map/Set their readonly twins, and every other object is mapped readonly recursively.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends
        | Uint8Array
        | Uint8ClampedArray
        | Int8Array
        | Int16Array
        | Int32Array
        | Uint16Array
        | Uint32Array
        | Float16Array
        | Float32Array
        | Float64Array
        | BigInt64Array
        | BigUint64Array
        | DataView
    ? T
    : T extends ReadonlyArray<infer E>
      ? ReadonlyArray<DeepReadonly<E>>
      : T extends ReadonlyMap<infer K, infer V>
        ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
        : T extends ReadonlySet<infer E>
          ? ReadonlySet<DeepReadonly<E>>
          : T extends Record<PropertyKey, unknown>
            ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
            : T;

/**
 * A controller as hosts hold it: its state, deeply read-only, and the methods named in `K`.
 * Lifecycle and the wiring between controllers stay with the engine, and a method added to a
 * controller is not host API until it is listed here.
 */
export type HostController<
  C extends Controller<Record<string, unknown>>,
  K extends Exclude<keyof C, "store">,
> = Pick<C, Exclude<K, "getState">> & {
  readonly getState: () => DeepReadonly<ReturnType<C["getState"]>>;
  readonly store: ReadonlyStore<DeepReadonly<ReturnType<C["getState"]>>>;
};

export type WalletEngine = {
  readonly networks: HostController<
    NetworkController,
    | "endpoints"
    | "info"
    | "enabled"
    | "client"
    | "independentClient"
    | "solanaRpc"
    | "esplora"
    | "addRpc"
  >;
  readonly assets: HostController<
    AssetsController,
    | "setVisible"
    | "refresh"
    | "refreshBitcoinGroup"
    | "isTracked"
    | "tokenMetadata"
    | "addToken"
    | "setTokenHidden"
  >;
  /** Spot prices of the held assets — display-only; nothing that builds or signs reads them. */
  readonly prices: HostController<PricesController, "setVisible" | "setCurrency" | "refresh">;
  /**
   * Fiat valuation of the balances already in state, at the current quotes — exact decimals,
   * display-only. `group` covers the group's EVM and Solana addresses on every enabled network, its
   * Bitcoin accounts and its Spark balance; it reads no chain.
   */
  readonly portfolio: {
    readonly group: (group: {
      readonly walletId: string;
      readonly groupIndex: number;
    }) => Promise<Valuation>;
  };
  /** Tracked transactions and coin control; every send, replacement and dApp signature is a request. */
  readonly transactions: HostController<
    TransactionController,
    "txById" | "nextReceiveAddress" | "setUtxosFrozen" | "frozenUtxos"
  >;
  readonly requests: HostController<
    RequestController,
    "prepare" | "approve" | "reject" | "outcome" | "signLog" | "clearSignLog"
  >;
  readonly addressBook: HostController<
    AddressBookController,
    "add" | "rename" | "setNote" | "remove"
  >;
  readonly history: HostController<HistoryController, "load" | "loadMore">;
  /** DApp sessions; `checkOrigin` and `invalidateOrigin` are what `createBrowserBridge` needs. */
  readonly connections: HostController<
    ConnectionController,
    | "checkOrigin"
    | "invalidateOrigin"
    | "session"
    | "pending"
    | "sessionAccounts"
    | "previewAccounts"
    | "nostrIdentity"
    | "isEnabled"
    | "approveConnection"
    | "rejectConnection"
    | "revoke"
    | "setCurrentNetwork"
    | "setTronNetwork"
    | "activeIdentity"
    | "setActiveIdentity"
    | "nostrPolicy"
    | "lightningPolicy"
    | "establishWalletConnect"
    | "authorize"
    | "touch"
  >;
  readonly eip1193: Pick<Eip1193Handler, "handle" | "subscribe">;
  readonly nip07: Pick<Nip07Handler, "handle">;
  readonly webln: Pick<WeblnHandler, "handle">;
  readonly solanaWallet: Pick<SolanaWalletHandler, "handle" | "subscribe">;
  readonly bitcoinWallet: Pick<BitcoinWalletHandler, "handle" | "subscribe">;
  readonly tronWallet: Pick<TronWalletHandler, "handle" | "subscribe">;
  /** The phishing list: lifecycle is independent of the lock state. */
  readonly phishing: HostController<PhishingController, "check" | "sync" | "trust" | "untrust">;
  /** Read and receive surface; every payment goes through `requests`. */
  readonly spark: HostController<
    SparkController,
    | "history"
    | "accountBalance"
    | "archivePayment"
    | "receiveAddress"
    | "createInvoice"
    | "newDepositAddress"
    | "paymentStatus"
    | "quoteExit"
    | "registerLightningAddress"
    | "unregisterLightningAddress"
  >;
  readonly accounts: HostController<
    AccountTreeController,
    | "imported"
    | "addGroup"
    | "addGroups"
    | "renameWallet"
    | "renameGroup"
    | "setHidden"
    | "select"
    | "bind"
    | "unbind"
    | "bindingOf"
    | "discoverSpark"
    | "discoverGroups"
    | "refreshTotals"
  >;
  readonly watch: {
    readonly add: (input: {
      readonly family: "evm" | "solana" | "bitcoin" | "tron";
      readonly address: string;
      readonly name?: string;
    }) => Promise<WatchAccount>;
    readonly rename: (id: string, name: string) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
    readonly list: () => ReadonlyArray<WatchAccount>;
    readonly assets: (id: string, network: string) => Promise<AccountBalances>;
  };
  readonly metaSync: HostController<MetaSyncController, "sync">;
  readonly backup: HostController<
    BackupController,
    "enable" | "disable" | "sync" | "list" | "restore"
  >;
  readonly zaps: {
    readonly prepare: (params: PrepareZapParams) => Promise<PreparedZap>;
  };
  readonly names: {
    /** Forward-resolves an ENS name for a send on `network`; throws when it cannot resolve. */
    readonly resolve: (name: string, network: string) => Promise<EnsResolution>;
  };
  /** The account's EIP-7702 delegation state on `network`. */
  readonly delegation: (account: AccountRef, network: string) => Promise<DelegationStatus>;
  /**
   * A gateway Across bridge quote — display-only; `undefined` when the route has no liquidity.
   * `status` reads the Across deposit-status API; neither affects signing.
   */
  readonly bridges: {
    readonly quote: (params: {
      readonly account: AccountRef;
      readonly network: string;
      readonly destinationNetwork: string;
      readonly inputToken: string;
      readonly outputToken: string;
      readonly amount: bigint;
      /** Highest relay fee accepted, in basis points of the input amount. */
      readonly maxFeeBps: number;
    }) => Promise<AcrossBridgeQuote | undefined>;
    readonly status: (params: {
      readonly network: string;
      readonly txHash: string;
    }) => Promise<AcrossBridgeStatus>;
  };
  /** Imported single private keys held in the vault — passthrough to `wallet.keys`. */
  readonly keys: KeysApi;
  /**
   * A gateway swap quote (0x on EVM, Jupiter on Solana) bound to the request's tokens, amount and
   * slippage; `undefined` when the quote has no liquidity.
   */
  readonly swaps: {
    readonly quote: (params: {
      readonly account: AccountRef;
      readonly network: string;
      readonly sell: string;
      readonly buy: string;
      readonly amount: bigint;
      readonly slippageBps: number;
    }) => Promise<SwapQuote | undefined>;
  };
  /** Lido liquid staking on Ethereum mainnet — stETH balance and withdrawal requests. */
  readonly lido: {
    readonly position: (account: AccountRef) => Promise<LidoPosition>;
  };
  /** Solana staking reads — the account's stake positions and the current validator set. */
  readonly staking: {
    readonly positions: (
      account: AccountRef,
      network: string,
    ) => Promise<ReadonlyArray<StakePosition>>;
    readonly validators: (network: string) => Promise<ReadonlyArray<StakeValidator>>;
  };
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
  const gateway =
    options.gateway === undefined ? undefined : gatewaySession(options.gateway.url, options.random);

  // The one EngineStore per unlock session, opened by `transition` and closed by `stop`; every
  // controller receives this accessor instead of opening its own.
  let store: EngineStore | undefined;
  // oxlint-disable-next-line typescript/require-await -- the openStore option requires an async accessor
  const sessionStore = async (): Promise<EngineStore> => {
    if (store === undefined) {
      throw new Error("the engine store is closed");
    }
    return store;
  };

  const phishing = new PhishingController({
    publicStore: options.publicStore,
    gateway,
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
    openStore: sessionStore,
    logger: options.logger,
    gateway,
    setTimer,
    random: options.random,
    now: options.now,
  });

  const assets = new AssetsController({
    networks,
    // Deferred like every other chains() call here — resolving the api at construction would
    // validate the wallet before any balance read needs it.
    chains: {
      account: async (params) => chains(options.wallet).account(params),
    },
    ownBitcoinTxids: () => ownBitcoinTxids(transactions.getState().txs),
    openStore: sessionStore,
    setTimer,
    logger: options.logger,
    gateway,
    fetch: options.fetch,
    now: options.now,
  });

  const prices = new PricesController({
    gateway,
    fetch: options.fetch,
    openStore: sessionStore,
    setTimer,
    now: options.now,
    logger: options.logger,
    held: () =>
      heldAssets(assets.getState().balances, controller.getState().accounts, options.sparkNetwork),
    onHeldChange: (listener) => {
      const offAssets = assets.store.subscribe(listener);
      const offSpark = controller.store.subscribe(listener);
      return () => {
        offAssets();
        offSpark();
      };
    },
  });

  const transactions = new TransactionController({
    wallet: options.wallet,
    networks,
    openStore: sessionStore,
    random: options.random,
    setTimer,
    now: options.now,
    logger: options.logger,
  });

  const addressBook = new AddressBookController({
    openStore: sessionStore,
    random: options.random,
    now: options.now,
    logger: options.logger,
  });

  const history = new HistoryController({
    networks,
    // Deferred like every other chains() call here — resolving the api at construction would
    // validate the wallet before any history read needs it.
    chains: {
      account: async (params) => chains(options.wallet).account(params),
    },
    spark: controller,
    sparkNetwork: options.sparkNetwork,
    transactions,
    addressBook,
    gateway:
      gateway === undefined
        ? undefined
        : { url: gateway.url, fetch: gatewayFetch(options.fetch, gateway) },
    openStore: sessionStore,
    setTimer,
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
  const watch = new WatchController({
    random: options.random,
    now: options.now,
    logger: options.logger,
    /* "Own" covers only the HD groups' derived EVM, Solana and Bitcoin (payment/ordinals)
       addresses — derived on demand since the tree stores only group indexes. Deliberately
       not the balances-state keys: a removed watch account's address can still appear
       there, and treating it as own would block re-adding it. */
    ownAddresses: async () => {
      const reads = Object.entries(accounts.getState().groups).flatMap(([walletId, groups]) =>
        groups.flatMap((group) =>
          (
            [
              ["evm.bip44", "evm"],
              ["solana.bip44-change", "solana"],
              ["tron.bip44", "tron"],
              ["btc.bip84", "bitcoin"],
              ["btc.bip86", "bitcoin"],
            ] as const
          ).flatMap(([template, family]) =>
            networks.enabled(family).map(async (network) => {
              try {
                const account = await chains(options.wallet).account({
                  walletId,
                  groupIndex: group.index,
                  template,
                  network,
                });
                return "address" in account ? account.address : undefined;
              } catch {
                /* a family the group has no account on is not a collision */
                return undefined;
              }
            }),
          ),
        ),
      );
      const derived = await Promise.all(reads);
      return derived.filter((a) => a !== undefined);
    },
  });

  const requests = new RequestController({
    phishing,
    blindSigning: () => options.wallet.getSnapshot().blindSigning,
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
    openStore: sessionStore,
    spark: controller,
    nostrSign: async (ref, event) => nostr(options.wallet).signer(ref).signEvent(event),
    solanaSign: async (account, network, request, verify, commit) => {
      const rpc = networks.solanaRpc(network);
      const adapter = new SolanaChainAdapter();
      const hdAccount = {
        kind: "hd" as const,
        walletId: account.walletId,
        groupIndex: account.groupIndex,
        template: "solana.bip44-change" as const,
      };
      if (request.kind === "transactions") {
        const wires: Uint8Array[] = [];
        const messages: Uint8Array[] = [];
        for (const wire of request.transactions) {
          const { message } = decodeSolanaTransaction(wire, account.address);
          // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential: each prompts.
          const result = await chains(options.wallet).sign({
            request: {
              kind: "solana.transaction",
              network,
              account: hdAccount,
              message,
            },
            verify,
          });
          if (result.kind !== "solana.transaction" || !(result.signature instanceof Uint8Array)) {
            throw new Error("unexpected solana sign result");
          }
          wires.push(addSolanaSignature(wire, account.address, result.signature));
          messages.push(message);
        }
        if (!request.send) {
          return { kind: "solana.transactions" as const, send: false, signedTransactions: wires };
        }
        const intents = messages.map((message): DisplayIntent =>
          decodeSolana(
            { kind: "solana.transaction", network, account: hdAccount, message },
            account.address,
          ),
        );
        /* The message carries only a blockhash: bound its expiry by the processed height at
           request time plus Agave's processing age. The dApp fetched the blockhash earlier, at
           any commitment, so the processed height is the bound that never comes in too low — a
           low bound would let the poll prove a drop while the bytes can still land. Read once,
           before commit: a failed read sends nothing. */
        const lastValidBlockHeight =
          (await adapter.blockHeight(rpc, "processed")) + SOLANA_MAX_PROCESSING_AGE;
        commit();
        const batch = await submitInOrder(wires.length, async (index) => {
          const wire = wires[index];
          const intent = intents[index];
          if (wire === undefined || intent === undefined) {
            throw new Error("signed transaction without its input");
          }
          return transactions.submitDappSolana(
            network,
            account.walletId,
            wire,
            lastValidBlockHeight,
            intent,
          );
        });
        return {
          kind: "solana.transactions" as const,
          send: true,
          signatures: batch.ids,
          ...(batch.stopped === undefined ? {} : { stopped: batch.stopped }),
        };
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
      prepareDappPsbts(
        chains(options.wallet),
        networks.esplora(network),
        account,
        network,
        psbts,
        new Set(
          transactions.frozenUtxos(
            { walletId: account.walletId, groupIndex: account.groupIndex },
            network,
          ),
        ),
      ),
    bitcoinSignPsbts: async (account, network, prepared, send, verify, commit) => {
      const { signedPsbts, txids, stopped } = await signDappPsbts(
        chains(options.wallet),
        prepared,
        send,
        verify,
        commit,
        async (p, r) => transactions.submitDappBitcoin(network, account.walletId, p, r),
      );
      return {
        kind: "bitcoin.psbts" as const,
        signedPsbts,
        txids,
        ...(stopped === undefined ? {} : { stopped }),
      };
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
  /** An imported ref's stored address from `wallet.keys` — family must match or it is refused. */
  const importedAddressOf = async (
    account: Extract<AccountRef, { kind: "imported" }>,
    family: "evm" | "solana",
  ): Promise<string> => {
    if (account.family !== family) {
      throw new Error(`an imported ${account.family} key cannot sign on a ${family} network`);
    }
    const keys = await options.wallet.keys.list();
    const key = keys.find((entry) => entry.keyId === account.keyId);
    if (key === undefined) {
      throw new Error("the imported key is not in the vault");
    }
    return key.address;
  };
  const evmAddressOf = async (account: AccountRef, network: string): Promise<string> => {
    if (account.kind === "imported") {
      return importedAddressOf(account, "evm");
    }
    const resolved = await chains(options.wallet).account({
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template: "evm.bip44",
      network,
    });
    return accountAddress(resolved);
  };
  const solanaAddressOf = async (account: AccountRef, network: string): Promise<string> => {
    if (account.kind === "imported") {
      return importedAddressOf(account, "solana");
    }
    const resolved = await chains(options.wallet).account({
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template: "solana.bip44-change",
      network,
    });
    return accountAddress(resolved);
  };
  /** The group's address on the family's networks, or none when the group has no such account. */
  const groupAddresses = async (
    group: { readonly walletId: string; readonly groupIndex: number },
    family: "evm" | "solana" | "tron",
  ): Promise<ReadonlyArray<{ readonly network: string; readonly address: string }>> => {
    const enabled = networks.enabled(family);
    const [first] = enabled;
    if (first === undefined) {
      return [];
    }
    const template =
      family === "evm"
        ? ("evm.bip44" as const)
        : family === "solana"
          ? ("solana.bip44-change" as const)
          : ("tron.bip44" as const);
    try {
      // One derivation serves every network of the family: the address does not depend on it.
      const account = await chains(options.wallet).account({
        ...group,
        template,
        network: first,
      });
      return "address" in account
        ? enabled.map((network) => ({ network, address: account.address }))
        : [];
    } catch {
      return [];
    }
  };
  const connections = new ConnectionController({
    phishing,
    setTimer,
    openStore: sessionStore,
    random: options.random,
    now: options.now,
    logger: options.logger,
    allowLocalhost: options.allowLocalhostOrigins ?? false,
    selectedGroup: () => accounts.getState().selected ?? undefined,
    onSelectedGroup: (listener) =>
      accounts.store.subscribe((state, previous) => {
        if (
          state.selected?.walletId !== previous.selected?.walletId ||
          state.selected?.groupIndex !== previous.selected?.groupIndex
        ) {
          listener();
        }
      }),
    invalidateAll: () => {
      requests.invalidateAll();
    },
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
    tronAddress: async (group, network) => {
      const account = await chains(options.wallet).account({
        ...group,
        template: "tron.bip44",
        network,
      });
      if (!("address" in account)) {
        throw new Error("no TRON address for the group");
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
      ...networks.enabled("tron"),
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
    sparkNetwork: options.sparkNetwork,
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
      if (!("address" in account)) {
        throw new Error("no Solana account for the group");
      }
      // A Solana address is the base58 of the ed25519 public key itself.
      return { address: account.address, publicKey: base58.decode(account.address) };
    },
    solanaNetwork: () => networks.enabled("solana")[0] ?? SOLANA_CHAIN_IDS["solana:mainnet"] ?? "",
  });

  const bitcoinWallet = new BitcoinWalletHandler({
    connections,
    requests,
    bitcoinAccount,
    bitcoinNetwork: () => {
      const enabled = networks.enabled("bitcoin");
      const mainnet = BITCOIN_CHAIN_IDS["bitcoin:mainnet"] ?? "";
      return enabled.includes(mainnet) ? mainnet : (enabled[0] ?? mainnet);
    },
  });

  const tronWallet = new TronWalletHandler({
    connections,
    requests,
    transactions,
    tronNetworks: () => networks.enabled("tron"),
    tronNetwork: () => {
      const enabled = networks.enabled("tron");
      return enabled.includes("tron:728126428")
        ? "tron:728126428"
        : (enabled[0] ?? "tron:728126428");
    },
    isTracked: (network, address) => assets.isTracked(network, address),
  });

  // The transition chain: every status change queues behind the previous one, so a late lock
  // always observes the snapshot left by a settled unlock (and vice versa).
  let chain: Promise<void> = Promise.resolve();
  let started = false;

  const stop = async (): Promise<void> => {
    started = false;
    depositClaimer.stop();
    connections.lock();
    requests.lock();
    addressBook.lock();
    watch.lock();
    transactions.lock();
    history.lock();
    prices.lock();
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
  };

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
      try {
        controller.setStore(store);
        backup.setStore(store);
        accounts.setStore(store);
        watch.setStore(store);
        backup.trigger(); // reconcile — never awaited on the transition chain
        // Load + reconcile + drive the selected account through spark.setAccounts.
        await accounts.init();
        await watch.init();
        await controller.init();
        // Pull → merge → maybe publish for every wallet with a group-0 identity.
        await addressBook.init();
        // Relay pulls are unbounded: meta sync starts in the background so a slow relay cannot
        // delay transaction recovery or the request pipeline. Its generation drops a pull that
        // a lock overtakes.
        // oxlint-disable-next-line promise/prefer-await-to-then -- background start, not on the chain
        void metaSync.init().catch((error: unknown) => {
          options.logger.warn("meta sync start failed", error);
        });
        await networks.init();
        await assets.init();
        await prices.init();
        await transactions.init();
        await history.init();
        await requests.init();
        await connections.init();
        depositClaimer.start();
      } catch (error) {
        // A start that fails mid-sequence leaves the same state as a lock: torn down, store
        // closed, started false — so the next wallet status event retries the whole start.
        options.logger.warn("engine start failed", error);
        await stop();
      }
    } else if (!unlocked && started) {
      await stop();
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
    prices,
    portfolio: {
      group: async (group) => {
        const [evm, solana, tron] = await Promise.all([
          groupAddresses(group, "evm"),
          groupAddresses(group, "solana"),
          groupAddresses(group, "tron"),
        ]);
        const holdings = groupHoldings({
          balances: assets.getState().balances,
          spark: controller.getState().accounts,
          sparkNetwork: options.sparkNetwork,
          group,
          addresses: [...evm, ...solana, ...tron],
          bitcoin: networks.enabled("bitcoin"),
        });
        return valueHoldings(holdings, prices.getState(), options.now());
      },
    },
    transactions,
    requests,
    history,
    watch: {
      add: async (input) => watch.add(input),
      rename: async (id, name) => watch.rename(id, name),
      remove: async (id) => watch.remove(id),
      list: () => watch.list(),
      /* The same per-address balance read the HD accounts use — the controller refreshes a
         plain address, so a watch account's stored address plugs straight in. */
      assets: async (id, network) => {
        const account = watch.getState().accounts[id];
        if (account === undefined) {
          throw new Error("no such watch account");
        }
        return assets.refresh(account.address, network);
      },
    },
    addressBook,
    connections,
    eip1193,
    nip07,
    webln,
    solanaWallet,
    bitcoinWallet,
    tronWallet,
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
        withdrawLnurl({ spark: controller, fetch: options.fetch }, params),
    },
    names: {
      resolve: async (name, network) => resolveEns(networks, name, network),
    },
    delegation: async (account: AccountRef, network: string) =>
      transactions.delegationState(account, network),
    bridges: {
      quote: async (params) =>
        fetchBridgeQuote(
          {
            fetch: options.fetch,
            gateway,
            address: evmAddressOf,
            now: options.now,
          },
          params,
        ),
      status: async (params) => fetchBridgeStatus({ fetch: options.fetch }, params),
    },
    keys: {
      import: async (family, secret) => options.wallet.keys.import(family, secret),
      list: async () => options.wallet.keys.list(),
      remove: async (keyId, verify) => options.wallet.keys.remove(keyId, verify),
      export: async (keyId, verify) => options.wallet.keys.export(keyId, verify),
    },
    swaps: {
      quote: async (params) =>
        (params.network.startsWith("solana:") ? fetchJupiterQuote : fetchSwapQuote)(
          {
            fetch: options.fetch,
            gateway,
            address: evmAddressOf,
            now: options.now,
          },
          params,
        ),
    },
    staking: {
      positions: async (account, network) =>
        stakePositions(networks.solanaRpc(network), await solanaAddressOf(account, network)),
      validators: async (network) => stakeValidators(networks.solanaRpc(network)),
    },
    lido: {
      position: async (account) =>
        lidoPosition(networks.client("eip155:1"), await evmAddressOf(account, "eip155:1")),
    },
    phishing,
    unsubscribe: () => {
      unsubscribe();
      void phishing.destroy();
    },
  };
}
