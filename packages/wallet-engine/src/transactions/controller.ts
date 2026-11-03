/**
 * Transaction controller: orchestrates lifecycle, persistence and polling; each chain family routes
 * through its own module (`evm.ts`, `solana.ts`, `bitcoin.ts`). A rejected signature (wrong
 * password, cancelled presence) never broadcasts.
 */
import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm, normalizeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { Controller } from "../controller.ts";
import type { EngineStore } from "../store/port.ts";
import { createBitcoinRoute } from "./bitcoin.ts";
import { createEvmRoute } from "./evm.ts";
import type {
  AccountRef,
  DisplayIntent,
  Options,
  PrepareParams,
  PreparedMessage,
  PreparedRequest,
  ChainRequestInput,
  RouteContext,
  TrackedTransaction,
  TxState,
} from "./route.ts";
import { newId } from "./route.ts";
import { pollSolana, prepareSolana } from "./solana.ts";

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

type BtcRecord = NonNullable<TrackedTransaction["btc"]>;
const isBtcRecord = (v: unknown): v is BtcRecord => {
  if (!isObject(v)) {
    return false;
  }
  const { inputs, outputs, vsize, fee, feeRate } = v;
  return (
    Array.isArray(inputs) &&
    Array.isArray(outputs) &&
    typeof vsize === "number" &&
    typeof fee === "number" &&
    typeof feeRate === "number" &&
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

const isIntent = (v: unknown): v is DisplayIntent =>
  isObject(v) &&
  typeof v["summary"] === "string" &&
  Array.isArray(v["outflows"]) &&
  typeof v["verifiability"] === "string";

const decode = (raw: Uint8Array): TrackedTransaction | undefined => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
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
    replaces,
    parentId,
    btc,
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
  return {
    id,
    family,
    network,
    account,
    hash: typeof hash === "string" ? hash : undefined,
    state,
    intent: isIntent(intent) ? intent : undefined,
    nonce,
    ...(typeof replaces === "string" ? { replaces } : {}),
    ...(typeof parentId === "string" ? { parentId } : {}),
    ...(isBtcRecord(btc) ? { btc } : {}),
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
      const tx = raw === undefined ? undefined : decode(raw);
      if (tx === undefined) {
        continue;
      }
      this.update((s) => ({ ...s, txs: { ...s.txs, [tx.id]: tx } }));
      if ((tx.state === "submitted" || tx.state === "pending") && tx.hash !== undefined) {
        this.track(tx.id, tx.hash);
      }
    }
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
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
  ): Promise<TrackedTransaction> {
    const updated: TrackedTransaction = { ...tx, ...next };
    this.update((s) => ({ ...s, txs: { ...s.txs, [tx.id]: updated } }));
    await this.persist(updated);
    return updated;
  }

  private routeCtx(): RouteContext {
    return {
      options: this.options,
      transition: async (tx, next) => this.transition(tx, next),
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
  async prepareSend(params: PrepareParams, requestId: string): Promise<PreparedRequest> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const { account, network } = params;
    const info = this.options.networks.info(network);
    if (account.kind !== "hd") {
      throw new Error("imported accounts are not yet supported");
    }
    const ctx = this.routeCtx();
    if (info.family === "solana") {
      return prepareSolana(ctx, params);
    }
    if (info.family === "bitcoin") {
      return this.bitcoinRoute.prepare(ctx, params, requestId);
    }
    return this.evmRoute.prepare(ctx, params);
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
    if (account.kind !== "hd") {
      throw new Error("imported accounts are not yet supported");
    }
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
    return {
      account,
      network,
      intent: decodeEvm(normalized),
      checks: [],
      staleReason: () => undefined,
      release: () => undefined,
      submit: async (verify) => {
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
    input: Exclude<ChainRequestInput, { method: "send" }>,
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

  private track(id: string, hash: string): void {
    if (this.locked) {
      this.options.logger.warn(
        `transaction ${id} was broadcast after the vault locked; it is neither persisted nor tracked`,
      );
      return;
    }
    if (this.timers.has(id) || hash === "") {
      return;
    }
    const poll = this.options.pollMs ?? 4000;
    const stop = this.options.setTimer(poll, async () => {
      if (this.locked) {
        return;
      }
      try {
        const tx = this.getState().txs[id];
        if (tx === undefined) {
          return;
        }
        const ctx = this.routeCtx();
        const next =
          tx.family === "solana"
            ? await pollSolana(ctx, tx)
            : tx.family === "bitcoin"
              ? await this.bitcoinRoute.poll(ctx, tx)
              : await this.evmRoute.poll(ctx, tx);
        if (next === undefined) {
          return;
        }
        const updated = await this.transition(tx, { state: next });
        this.timers.delete(id);
        stop();
        // When one of a replace pair confirms, the sibling is `replaced`.
        const siblings = Object.values(this.getState().txs).filter(
          (t) =>
            t.id !== updated.id &&
            t.hash !== undefined &&
            t.state !== "replaced" &&
            ((updated.replaces !== undefined && t.id === updated.replaces) ||
              (t.replaces !== undefined && t.replaces === updated.id)) &&
            (t.state === "submitted" || t.state === "pending"),
        );
        await Promise.all(
          siblings.map(async (sibling) => {
            await this.transition(sibling, { state: "replaced" });
            const siblingStop = this.timers.get(sibling.id);
            this.timers.delete(sibling.id);
            siblingStop?.();
          }),
        );
      } catch (error) {
        this.options.logger.warn("tx status poll failed", error);
      }
    });
    this.timers.set(id, stop);
  }
}
