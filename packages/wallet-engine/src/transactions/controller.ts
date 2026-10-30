/**
 * Transaction controller: orchestrates lifecycle, persistence and polling; each chain family routes
 * through its own module (`evm.ts`, `solana.ts`, `bitcoin.ts`). A rejected signature (wrong
 * password, cancelled presence) never broadcasts.
 */
import { Controller } from "../controller.ts";
import type { EngineStore } from "../store/port.ts";
import { createBitcoinRoute } from "./bitcoin.ts";
import { createEvmRoute } from "./evm.ts";
import type {
  DisplayIntent,
  Options,
  RouteContext,
  SendParams,
  TrackedTransaction,
  TxState,
} from "./route.ts";
import { newId } from "./route.ts";
import { pollSolana, sendSolana } from "./solana.ts";

export type { SendParams, TrackedTransaction, TxState } from "./route.ts";
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
  private readonly bitcoinRoute = createBitcoinRoute();
  private locked = true;

  constructor(options: Options) {
    super({ name: "transactions", defaultState: () => ({ txs: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    this.locked = false;
    this.engineStore = await this.options.openStore();
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
  }

  private async persist(tx: TrackedTransaction): Promise<void> {
    const store = this.engineStore;
    if (store !== undefined) {
      await store.collection("transactions").put(tx.id, encode(tx));
    }
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
      newId: () => newId(this.options.random),
    };
  }

  async send(params: SendParams): Promise<TrackedTransaction> {
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
      return sendSolana(ctx, params);
    }
    if (info.family === "bitcoin") {
      return this.bitcoinRoute.send(ctx, params);
    }
    return this.evmRoute.send(ctx, params);
  }

  /**
   * Speed up or cancel a pending/submitted EVM transaction at the same nonce — a fresh signature is
   * required and a rejection leaves the original untouched.
   */
  async replace(
    id: string,
    mode: "speed-up" | "cancel",
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const old = this.getState().txs[id];
    if (old === undefined) {
      throw new Error(`unknown transaction ${id}`);
    }
    if (old.family === "bitcoin") {
      return this.bitcoinRoute.replace(this.routeCtx(), old, mode, verify);
    }
    if (old.family !== "evm") {
      throw new Error("replace is EVM-only in this layer");
    }
    if (old.state !== "pending" && old.state !== "submitted") {
      throw new Error(`cannot replace a ${old.state} transaction`);
    }
    return this.evmRoute.replace(this.routeCtx(), old, mode, verify);
  }

  /**
   * CPFP — spend an unconfirmed tx's own outputs into a higher-fee child so the package mines.
   * Bitcoin only; the child is linked via `parentId`.
   */
  async bumpChild(
    id: string,
    targetRate: number,
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const old = this.getState().txs[id];
    if (old === undefined) {
      throw new Error(`unknown transaction ${id}`);
    }
    if (old.family !== "bitcoin") {
      throw new Error("bumpChild is Bitcoin-only in this layer");
    }
    if (old.state !== "pending" && old.state !== "submitted") {
      throw new Error(`cannot bump a ${old.state} transaction`);
    }
    return this.bitcoinRoute.bumpChild(this.routeCtx(), old, targetRate, verify);
  }

  private track(id: string, hash: string): void {
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
