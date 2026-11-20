/**
 * Transaction controller: orchestrates lifecycle, persistence and polling; each chain family routes
 * through its own module (`evm.ts`, `solana.ts`, `bitcoin.ts`). A rejected signature (wrong
 * password, cancelled presence) never broadcasts.
 */
import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { BITCOIN_TEMPLATES } from "../chains/bitcoin-scan.ts";
import { Controller } from "../controller.ts";
import type { PreparedBitcoinPsbt } from "../requests/types.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import { repeat } from "../timer.ts";
import { createBitcoinRoute } from "./bitcoin.ts";
import { createEvmRoute } from "./evm.ts";
import type {
  AccountRef,
  BatchRecord,
  DisplayIntent,
  Options,
  PrepareParams,
  PreparedMessage,
  PreparedRequest,
  ChainRequestInput,
  RouteContext,
  SendParams,
  SignResult,
  SparkDepositTag,
  TrackedTransaction,
  TxBlock,
  TxState,
  DelegationStatus,
} from "./route.ts";
import { accountAddressOf, awaitingFinality, newId } from "./route.ts";
import {
  pollSolana,
  prepareSolana,
  prepareSolanaCoreSend,
  prepareSolanaStake,
  prepareSolanaSwap,
  submitDappSolana,
} from "./solana.ts";

export type {
  AccountRef,
  PrepareParams,
  PreparedRequest,
  ChainRequestInput,
  ChainRequestMethod,
  SendParams,
  TrackedTransaction,
  TxState,
} from "./route.ts";
export type { Options } from "./route.ts";

export type TransactionControllerState = {
  readonly txs: Record<string, TrackedTransaction>;
};

const encode = (tx: TrackedTransaction): Uint8Array => new TextEncoder().encode(JSON.stringify(tx));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const encodeBatch = (record: BatchRecord): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(record));

/** A bundle id is unique per origin — the store key must carry both. */
const batchKey = (origin: string, id: string): string => `${origin}${id}`;

const isBatchRecord = (value: unknown): value is BatchRecord => {
  if (!isRecord(value)) {
    return false;
  }
  const { origin, id, network, atomic, txIds, expected, createdAt } = value;
  return (
    typeof origin === "string" &&
    typeof id === "string" &&
    typeof network === "string" &&
    typeof atomic === "boolean" &&
    Array.isArray(txIds) &&
    txIds.every((t) => typeof t === "string") &&
    typeof expected === "number" &&
    Number.isSafeInteger(expected) &&
    expected > 0 &&
    txIds.length <= expected &&
    typeof createdAt === "number"
  );
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const TX_STATES: ReadonlySet<string> = new Set([
  "draft",
  "signed",
  "submitted",
  "pending",
  "confirmed",
  "failed",
  "rejected",
  "dropped",
  "replaced",
]);

const isTxState = (v: unknown): v is TxState => typeof v === "string" && TX_STATES.has(v);

/**
 * States whose signed bytes may be on the network without a block answer: tracked until they
 * end. An included (`tx.block` set) row that is not final yet joins them — at the slower
 * finality interval — and a `final` one is never polled again.
 */
const LIVE_STATES: ReadonlySet<TxState> = new Set(["signed", "submitted", "pending"]);

/**
 * A transaction in a block that is not final is polled at `pollMs` times this — a reorg is rare,
 * and only the rare one needs a quick answer.
 */
export const FINALITY_POLL_FACTOR = 15;

const decodeBlock = (v: unknown): TxBlock | undefined =>
  isObject(v) &&
  typeof v["height"] === "number" &&
  Number.isSafeInteger(v["height"]) &&
  v["height"] >= 0 &&
  (v["hash"] === undefined || typeof v["hash"] === "string")
    ? v["hash"] === undefined
      ? { height: v["height"] }
      : { hash: v["hash"], height: v["height"] }
    : undefined;

type BtcRecord = NonNullable<TrackedTransaction["btc"]>;
const isBtcRecord = (v: unknown): v is BtcRecord => {
  if (!isObject(v)) {
    return false;
  }
  const { inputs, outputs, vsize, fee, feeRate, template, groupIndex, tier } = v;
  return (
    Array.isArray(inputs) &&
    Array.isArray(outputs) &&
    typeof vsize === "number" &&
    typeof fee === "number" &&
    typeof feeRate === "number" &&
    // A record without the rebuild fields decodes without `btc` — no migration, the
    // replacement paths refuse it as having no build record.
    (BITCOIN_TEMPLATES as ReadonlyArray<string>).includes(
      typeof template === "string" ? template : "",
    ) &&
    typeof groupIndex === "number" &&
    Number.isSafeInteger(groupIndex) &&
    (tier === "fast" || tier === "normal" || tier === "slow") &&
    inputs.every(
      (i) =>
        isObject(i) &&
        typeof i["txid"] === "string" &&
        typeof i["vout"] === "number" &&
        typeof i["value"] === "number" &&
        typeof i["address"] === "string",
    ) &&
    outputs.every(
      (o) =>
        isObject(o) &&
        typeof o["address"] === "string" &&
        typeof o["value"] === "number" &&
        typeof o["own"] === "boolean",
    )
  );
};

type EvmRecord = NonNullable<TrackedTransaction["evm"]>;
const isEvmAccountRef = (v: unknown): v is EvmRecord["account"] =>
  isObject(v) &&
  ((v["kind"] === "hd" &&
    typeof v["walletId"] === "string" &&
    typeof v["groupIndex"] === "number" &&
    Number.isSafeInteger(v["groupIndex"]) &&
    v["groupIndex"] >= 0 &&
    typeof v["template"] === "string") ||
    (v["kind"] === "imported" && typeof v["keyId"] === "string" && v["family"] === "evm"));
const isEvmRecord = (v: unknown): v is EvmRecord =>
  isObject(v) && typeof v["from"] === "string" && isEvmAccountRef(v["account"]);

const isSparkDeposit = (v: unknown): v is SparkDepositTag =>
  isObject(v) &&
  typeof v["walletId"] === "string" &&
  typeof v["groupIndex"] === "number" &&
  (v["network"] === "mainnet" || v["network"] === "regtest") &&
  (v["claimed"] === undefined || typeof v["claimed"] === "boolean");

const isIntent = (v: unknown): v is DisplayIntent =>
  isObject(v) &&
  typeof v["summary"] === "string" &&
  Array.isArray(v["outflows"]) &&
  typeof v["verifiability"] === "string";

const decode = (
  raw: Uint8Array,
  warn: (msg: string) => void = () => undefined,
): TrackedTransaction | undefined => {
  const parsed = readJson(raw);
  if (!isObject(parsed)) {
    return undefined;
  }
  const {
    id,
    family,
    network,
    account,
    hash,
    state,
    intent,
    nonce,
    block,
    final,
    lastValidBlockHeight,
    replaces,
    parentId,
    raw: signedRaw,
    evm,
    btc,
    sparkDeposit,
    submittedAt,
    error,
  } = parsed;
  if (
    typeof id !== "string" ||
    (family !== "evm" && family !== "solana" && family !== "bitcoin") ||
    typeof network !== "string" ||
    typeof account !== "string" ||
    !isTxState(state) ||
    typeof nonce !== "number" ||
    typeof submittedAt !== "number"
  ) {
    return undefined;
  }
  const decoded = decodeBlock(block);
  const decodedBlock = decoded === undefined ? {} : { block: decoded };
  return {
    id,
    family,
    network,
    account,
    hash: typeof hash === "string" ? hash : undefined,
    state,
    intent: isIntent(intent) ? intent : undefined,
    nonce,
    ...decodedBlock,
    ...(typeof final === "boolean" ? { final } : {}),
    ...(typeof lastValidBlockHeight === "number" && Number.isSafeInteger(lastValidBlockHeight)
      ? { lastValidBlockHeight }
      : {}),
    ...(typeof replaces === "string" ? { replaces } : {}),
    ...(typeof parentId === "string" ? { parentId } : {}),
    ...(typeof signedRaw === "string" && signedRaw !== "" ? { raw: signedRaw } : {}),
    ...(isEvmRecord(evm)
      ? { evm }
      : (() => {
          if (evm !== undefined) {
            warn(`dropping malformed evm build record on transaction ${id}`);
          }
          return {};
        })()),
    ...(isBtcRecord(btc) ? { btc } : {}),
    ...(isSparkDeposit(sparkDeposit) ? { sparkDeposit } : {}),
    submittedAt,
    error: typeof error === "string" ? error : undefined,
  };
};

export class TransactionController extends Controller<TransactionControllerState> {
  private readonly options: Options;
  private engineStore?: EngineStore | undefined;
  private readonly timers = new Map<string, () => void>();
  private evmRoute = createEvmRoute();
  private bitcoinRoute = createBitcoinRoute();
  private locked = true;
  private readonly batches = new Map<string, BatchRecord>();

  constructor(options: Options) {
    super({ name: "transactions", defaultState: () => ({ txs: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    this.locked = false;
    this.engineStore = await this.options.openStore();
    await this.bitcoinRoute.unlock(this.engineStore);
    const collection = this.engineStore.collection("transactions");
    const keys = await collection.list();
    const rows = await Promise.all(keys.map(async (key) => collection.get(key)));
    for (const raw of rows) {
      const loaded =
        raw === undefined ? undefined : decode(raw, (msg) => this.options.logger.warn(msg));
      if (loaded === undefined) {
        continue;
      }
      this.update((s) => ({ ...s, txs: { ...s.txs, [loaded.id]: loaded } }));
      const { hash } = loaded;
      if ((!LIVE_STATES.has(loaded.state) && !awaitingFinality(loaded)) || hash === undefined) {
        continue;
      }
      // Signed bytes persisted but the broadcast never settled (the app stopped mid-send): the
      // outcome is unknown, so the transaction is tracked like any submitted one.
      const tx =
        loaded.state === "signed"
          ? // oxlint-disable-next-line eslint/no-await-in-loop -- rows load in order
            await this.transition(loaded, { state: "submitted" })
          : loaded;
      if (tx.family === "evm") {
        this.evmRoute.resume(tx);
      }
      this.track(tx.id, hash);
    }
    const batches = this.engineStore.collection("call-batches");
    const batchKeys = await batches.list();
    const batchRows = await Promise.all(batchKeys.map(async (key) => batches.get(key)));
    for (const raw of batchRows) {
      const record =
        raw === undefined
          ? undefined
          : (() => {
              try {
                const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
                return isBatchRecord(parsed) ? parsed : undefined;
              } catch {
                return undefined;
              }
            })();
      if (record !== undefined) {
        this.batches.set(batchKey(record.origin, record.id), record);
      }
    }
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** One `wallet_sendCalls` bundle the user approved; retained alongside the transactions it lists. */
  async recordBatch(record: BatchRecord): Promise<void> {
    const key = batchKey(record.origin, record.id);
    this.batches.set(key, record);
    const store = this.engineStore;
    if (store === undefined) {
      this.options.logger.warn(`call batch ${record.id} not persisted: vault locked`);
      return;
    }
    await store.collection("call-batches").put(key, encodeBatch(record));
  }

  /** The bundle `origin` asked for, or `undefined` when it is not theirs (or is gone). */
  batchById(origin: string, id: string): BatchRecord | undefined {
    return this.batches.get(batchKey(origin, id));
  }

  /** A tracked transaction by id — for `wallet_getCallsStatus`. */
  txById(id: string): TrackedTransaction | undefined {
    return this.getState().txs[id];
  }

  lock(): void {
    this.locked = true;
    for (const stop of this.timers.values()) {
      stop();
    }
    this.timers.clear();
    this.engineStore = undefined;
    this.evmRoute = createEvmRoute();
    this.bitcoinRoute.lock();
    this.bitcoinRoute = createBitcoinRoute();
  }

  private async persist(tx: TrackedTransaction): Promise<void> {
    const store = this.engineStore;
    if (store === undefined) {
      this.options.logger.warn(`transaction ${tx.id} (${tx.state}) not persisted: vault locked`);
      return;
    }
    await store.collection("transactions").put(tx.id, encode(tx));
  }

  private async transition(
    tx: TrackedTransaction,
    next: Partial<TrackedTransaction>,
    durable = false,
  ): Promise<TrackedTransaction> {
    if (durable && this.engineStore === undefined) {
      throw new Error("transactions require an unlocked vault");
    }
    const updated: TrackedTransaction = { ...tx, ...next };
    this.update((s) => ({ ...s, txs: { ...s.txs, [tx.id]: updated } }));
    await this.persist(updated);
    return updated;
  }

  private routeCtx(): RouteContext {
    return {
      options: this.options,
      transition: async (tx, next, durable) => this.transition(tx, next, durable),
      track: (id, hash) => this.track(id, hash),
      txs: () => this.getState().txs,
      newId: () => newId(this.options.random),
    };
  }

  /**
   * Internal entry for the request pipeline: builds, estimates and cross-checks a send without
   * signing it. Bitcoin outputs it selects stay locked under `requestId` until the returned
   * `release` runs or the broadcast moves them to the transaction.
   */
  async prepareSend(
    params: PrepareParams,
    requestId: string,
    sparkDeposit?: SparkDepositTag,
  ): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const { network } = params;
    const info = this.options.networks.info(network);
    const ctx = this.routeCtx();
    if (info.family === "solana") {
      return prepareSolana(ctx, params);
    }
    if (info.family === "bitcoin") {
      return this.bitcoinRoute.prepare(ctx, params, requestId, sparkDeposit);
    }
    return this.evmRoute.prepare(ctx, params);
  }

  /** The group's next unused `btc.bip84` receive address on a bitcoin `network`. */
  async nextReceiveAddress(walletId: string, groupIndex: number, network: string): Promise<string> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return this.bitcoinRoute.nextReceiveAddress(this.routeCtx(), walletId, groupIndex, network);
  }

  /**
   * Freeze or unfreeze bitcoin outpoints (`txid:vout`) for one account on one `network`. Freezing
   * is intent, not utxo state — the outpoint need not be unspent — and it never lifts the derived
   * inscription protection.
   */
  async setUtxosFrozen(
    account: { readonly walletId: string; readonly groupIndex: number },
    network: string,
    outpoints: ReadonlyArray<string>,
    frozen: boolean,
  ): Promise<void> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    await this.bitcoinRoute.setUtxosFrozen(
      `${account.walletId}:${String(account.groupIndex)}:${network}`,
      outpoints,
      frozen,
    );
  }

  /** The outpoints the account froze on `network`. */
  frozenUtxos(
    account: { readonly walletId: string; readonly groupIndex: number },
    network: string,
  ): ReadonlyArray<string> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return this.bitcoinRoute.frozenUtxos(
      `${account.walletId}:${String(account.groupIndex)}:${network}`,
    );
  }

  /**
   * Internal entry for the dApp `signTransaction` send path: a dApp-built transaction has no build
   * record; it joins tracking under its signed bytes like a wallet send.
   */
  async submitDappBitcoin(
    network: string,
    walletId: string,
    prepared: PreparedBitcoinPsbt,
    result: SignResult,
  ): Promise<string> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return this.bitcoinRoute.submitDapp(this.routeCtx(), {
      network,
      walletId,
      prepared,
      result,
    });
  }

  /**
   * Internal entry for the dApp `signAndSendTransaction` path: a dApp-built transaction has no
   * build record; it joins tracking under its signed bytes like a wallet send.
   */
  async submitDappSolana(
    network: string,
    walletId: string,
    wire: Uint8Array,
    lastValidBlockHeight: bigint,
    intent: DisplayIntent,
  ): Promise<string> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return submitDappSolana(this.routeCtx(), {
      network,
      walletId,
      wire,
      lastValidBlockHeight,
      intent,
    });
  }

  /** Records that a Spark deposit was credited; persisted with the transaction. */
  async markDepositClaimed(id: string): Promise<void> {
    const tx = this.getState().txs[id];
    if (tx?.sparkDeposit === undefined) {
      throw new Error(`transaction ${id} is not a Spark deposit`);
    }
    await this.transition(tx, { sparkDeposit: { ...tx.sparkDeposit, claimed: true } });
  }

  /**
   * Internal entry for a dApp's EVM signature request: the request is normalized first, a
   * transaction is rebuilt with fresh nonce and fees (the dApp's own are discarded), and a message
   * is decoded and signed as is.
   */
  async prepareDapp(
    account: AccountRef,
    request: SignRequest,
  ): Promise<PreparedRequest | PreparedMessage> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const normalized = normalizeEvm(request);
    if (normalized.kind === "evm.transaction") {
      return this.evmRoute.prepareCall(this.routeCtx(), {
        account,
        network: normalized.network,
        tx: normalized.tx,
      });
    }
    if (normalized.kind !== "evm.personal-message" && normalized.kind !== "evm.typed-data") {
      throw new Error(`unsupported dApp request ${normalized.kind}`);
    }
    const { kind, network } = normalized;
    const apis = this.options.chains ?? chains(this.options.wallet);
    const signer = await accountAddressOf(this.routeCtx(), account, "evm.bip44", network);
    return {
      account,
      network,
      signer,
      intent: decodeEvm(normalized, signer),
      checks: [],
      staleReason: () => undefined,
      release: () => undefined,
      submit: async (verify: SendParams["verify"]) => {
        const result = await apis.sign({
          request:
            normalized.kind === "evm.personal-message"
              ? { kind: normalized.kind, network, account, message: normalized.message }
              : { kind: normalized.kind, network, account, typedData: normalized.typedData },
          verify,
        });
        if (result.kind !== kind || !("signature" in result)) {
          throw new Error("unexpected sign result");
        }
        return { kind, signature: result.signature };
      },
    };
  }

  /**
   * Internal entry for replacements and CPFP: builds, cross-checks and reserves what the
   * replacement needs without signing it. The original must be `submitted` or `pending`.
   */
  async prepareReplacement(
    input: Extract<ChainRequestInput, { method: "speed-up" | "cancel" | "cpfp" }>,
    requestId: string,
  ): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const old = this.getState().txs[input.txId];
    if (old === undefined) {
      throw new Error(`unknown transaction ${input.txId}`);
    }
    if (old.state !== "pending" && old.state !== "submitted") {
      throw new Error(`cannot ${input.method} a ${old.state} transaction`);
    }
    const ctx = this.routeCtx();
    if (input.method === "cpfp") {
      if (old.family !== "bitcoin") {
        throw new Error("cpfp is Bitcoin-only");
      }
      return this.bitcoinRoute.prepareCpfp(ctx, old, input.feeRate, requestId);
    }
    if (old.family === "bitcoin") {
      return this.bitcoinRoute.prepareReplace(ctx, old, input.method, requestId);
    }
    if (old.family === "evm") {
      return this.evmRoute.prepareReplace(ctx, old, input.method);
    }
    throw new Error(`${input.method} is EVM and Bitcoin only`);
  }

  /**
   * Internal EVM requests (`evm-delegation`/`evm-batch`/`evm-approve`/`evm-swap`/`evm-lido`):
   * builds, estimates and cross-checks the self-transaction without signing it.
   */
  async prepareEvmInternal(
    input: Extract<
      ChainRequestInput,
      {
        method:
          | "evm-delegation"
          | "evm-batch"
          | "evm-approve"
          | "evm-swap"
          | "evm-bridge"
          | "evm-nft-send"
          | "evm-lido";
      }
    >,
    _requestId: string,
  ): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return this.evmRoute.prepareEvmInternal(this.routeCtx(), input);
  }

  /**
   * Internal `solana-stake` requests: checks the delegation rules, then builds the stake
   * transaction through the same fee/simulation path as a SOL send without signing it.
   */
  async prepareSolanaStake(
    input: Extract<ChainRequestInput, { method: "solana-stake" }>,
    _requestId: string,
  ): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return prepareSolanaStake(this.routeCtx(), input);
  }

  async prepareSolanaSwap(
    input: Extract<ChainRequestInput, { method: "solana-swap" }>,
    _requestId: string,
  ): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return prepareSolanaSwap(this.routeCtx(), input);
  }

  async prepareSolanaCoreSend(
    input: Extract<ChainRequestInput, { method: "solana-core-send" }>,
    _requestId: string,
  ): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    return prepareSolanaCoreSend(this.routeCtx(), input);
  }

  /** The account's 7702 delegation state on `network` (primary endpoint only). */
  async delegationState(account: AccountRef, network: string): Promise<DelegationStatus> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const ctx = this.routeCtx();
    return this.evmRoute.delegationState(
      ctx,
      network,
      await accountAddressOf(ctx, account, "evm.bip44", network),
    );
  }

  private track(id: string, hash: string): void {
    if (this.locked) {
      this.options.logger.warn(
        `transaction ${id} was broadcast after the vault locked; its signed bytes are persisted and tracking resumes at the next unlock`,
      );
      return;
    }
    if (this.timers.has(id) || hash === "") {
      return;
    }
    const row = this.getState().txs[id];
    const pollMs =
      (this.options.pollMs ?? 4000) *
      (row !== undefined && awaitingFinality(row) ? FINALITY_POLL_FACTOR : 1);
    this.timers.set(
      id,
      repeat(this.options.setTimer, pollMs, async () => this.pollOnce(id), (error) => {
        this.options.logger.warn("tx status poll failed", error);
      }),
    );
  }

  /** Re-arms a transaction's loop — at the finality interval once included, back to `pollMs` after a reorg. */
  private retrack(id: string, hash: string): void {
    this.untrack(id);
    this.track(id, hash);
  }

  private untrack(id: string): void {
    this.timers.get(id)?.();
    this.timers.delete(id);
  }

  /**
   * One status poll. `included` keeps a non-final row tracked at the finality interval;
   * `reorged` clears the block and returns the row to the pool as `submitted`; `ended` stops
   * the loop. An answer describes the snapshot the poll started from — a concurrent transition
   * (a sibling marking this replaced, a reload) means the row moved on and the next poll decides.
   */
  private async pollOnce(id: string): Promise<void> {
    const tx = this.getState().txs[id];
    if (tx === undefined) {
      this.untrack(id);
      return;
    }
    const ctx = this.routeCtx();
    const answer =
      tx.family === "solana"
        ? await pollSolana(ctx, tx)
        : tx.family === "bitcoin"
          ? await this.bitcoinRoute.poll(ctx, tx)
          : await this.evmRoute.poll(ctx, tx);
    if (answer === undefined || this.locked) {
      return;
    }
    if (this.getState().txs[id] !== tx) {
      return;
    }
    if (answer.kind === "included") {
      const firstInclusion = tx.block === undefined;
      const updated = await this.transition(tx, {
        state: answer.state,
        block: answer.block,
        final: answer.final,
      });
      if (firstInclusion) {
        this.settle(updated);
        await this.markReplacedSiblings(updated);
      }
      if (answer.final) {
        this.untrack(id);
      } else if (firstInclusion) {
        this.retrack(id, updated.hash ?? "");
      }
      return;
    }
    if (answer.kind === "reorged") {
      const { block } = tx;
      const updated = await this.transition(tx, {
        state: "submitted",
        block: undefined,
        final: undefined,
      });
      this.reopen(updated);
      this.options.logger.warn(
        `transaction ${id} left block ${block?.hash ?? "?"} at height ${String(block?.height)}: reorged, tracking again`,
      );
      await this.reviveSiblings(updated);
      this.retrack(id, updated.hash ?? "");
      return;
    }
    this.untrack(id);
    const updated = await this.transition(tx, { state: answer.state });
    this.settle(updated);
  }

  /** When one of a replace pair is included, its live siblings are `replaced`. */
  private async markReplacedSiblings(updated: TrackedTransaction): Promise<void> {
    const siblings = Object.values(this.getState().txs).filter(
      (t) =>
        t.id !== updated.id &&
        t.hash !== undefined &&
        t.state !== "replaced" &&
        replaceLinked(t, updated) &&
        (t.state === "submitted" || t.state === "pending"),
    );
    await Promise.all(
      siblings.map(async (sibling) => {
        this.untrack(sibling.id);
        this.settle(await this.transition(sibling, { state: "replaced" }));
      }),
    );
  }

  /** A reorged transaction revives `replaced` siblings: each is `submitted` and polled again. */
  private async reviveSiblings(updated: TrackedTransaction): Promise<void> {
    const siblings = Object.values(this.getState().txs).filter(
      (t) =>
        t.id !== updated.id &&
        t.hash !== undefined &&
        t.state === "replaced" &&
        replaceLinked(t, updated),
    );
    await Promise.all(
      siblings.map(async (sibling) => {
        const revived = await this.transition(sibling, { state: "submitted" });
        this.reopen(revived);
        this.track(revived.id, revived.hash ?? "");
      }),
    );
  }

  /** A reorged transaction re-anchors what it consumed — EVM nonces, Bitcoin inputs. */
  private reopen(tx: TrackedTransaction): void {
    if (tx.family === "bitcoin") {
      this.bitcoinRoute.reopen(tx);
    }
    if (tx.family === "evm") {
      this.evmRoute.reopen(tx);
    }
  }

  /** A transaction that settled frees what it locked, whichever way it settled. */
  private settle(tx: TrackedTransaction): void {
    if (tx.family === "bitcoin") {
      this.bitcoinRoute.settle(tx.id, tx.state);
    }
    if (tx.family === "evm") {
      this.evmRoute.settle(tx);
    }
  }
}

/** Two transactions linked through one's `replaces` pointing at the other's id. */
const replaceLinked = (a: TrackedTransaction, b: TrackedTransaction): boolean =>
  a.id !== b.id && (a.replaces === b.id || b.replaces === a.id);
