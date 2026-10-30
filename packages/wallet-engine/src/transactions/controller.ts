import type { Wallet } from "@qntx/wallet";
/**
 * Transaction controller: `send` runs build → fee → intent decode → sign → broadcast → track.
 * Tracked transactions persist in the EngineStore on every transition and non-terminal ones resume
 * polling on unlock; all timers stop on lock. A rejected signature (wrong password, cancelled
 * presence) never broadcasts.
 */
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { EvmChainAdapter } from "../chains/evm.ts";
import type { EvmFeeTier } from "../chains/evm.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { EngineStore } from "../store/port.ts";

type SignParams = Parameters<ReturnType<typeof chains>["sign"]>[0];
type AccountRef = SignParams["request"]["account"];
type DisplayIntent = ReturnType<typeof decodeEvm>;

export type TxState =
  | "draft"
  | "signed"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "rejected";

export type TrackedTransaction = {
  readonly id: string;
  readonly family: "evm";
  readonly network: string;
  readonly account: string;
  readonly hash: string | undefined;
  readonly state: TxState;
  readonly intent: DisplayIntent | undefined;
  readonly nonce: number;
  readonly submittedAt: number;
  readonly error: string | undefined;
};

export type SendParams = {
  readonly account: AccountRef;
  readonly network: string;
  readonly to: string;
  readonly amount: bigint;
  readonly fee: EvmFeeTier;
  readonly verify: SignParams["verify"];
};

export type TransactionControllerState = {
  readonly txs: Record<string, TrackedTransaction>;
};

type Options = {
  readonly wallet: Wallet;
  readonly networks: NetworkController;
  readonly openStore: () => Promise<EngineStore>;
  readonly random: (n: number) => Uint8Array;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly pollMs?: number;
  /** Test seam — defaults to the wallet's real chains proxy. */
  readonly chains?: ReturnType<typeof chains>;
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
]);

const isTxState = (v: unknown): v is TxState => typeof v === "string" && TX_STATES.has(v);

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
  const { id, family, network, account, hash, state, intent, nonce, submittedAt, error } = parsed;
  if (
    typeof id !== "string" ||
    family !== "evm" ||
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
    submittedAt,
    error: typeof error === "string" ? error : undefined,
  };
};

export class TransactionController extends Controller<TransactionControllerState> {
  private readonly options: Options;
  private readonly evm = new EvmChainAdapter();
  private engineStore?: EngineStore | undefined;
  private readonly timers = new Map<string, () => void>();
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
        this.track(tx.id, tx.hash, tx.network);
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

  async send(params: SendParams): Promise<TrackedTransaction> {
    if (this.locked) {
      throw new Error("transactions require an unlocked vault");
    }
    const { account, network, to, amount, fee, verify } = params;
    const { networks } = this.options;
    const client = networks.client(network);
    const info = networks.info(network);
    if (account.kind !== "hd") {
      throw new Error("imported accounts are not yet supported");
    }
    const apis = this.options.chains ?? chains(this.options.wallet);
    const evmAccount = await apis.account({
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template: "evm.bip44",
      network,
    });
    const from = "address" in evmAccount ? evmAccount.address : "";
    const id = `tx-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const unsigned = await this.evm.build(client, network, from, to, amount);
    const quotes = await this.evm.estimateFee(client);
    const quote = quotes.find((q) => q.tier === fee) ?? quotes[1];
    if (quote === undefined) {
      throw new Error("no fee quote");
    }
    const request = this.evm.toSignRequest(
      this.evm.applyFee(unsigned, quote),
      account,
      info.chainId,
    );
    const intent = decodeEvm(request);
    let tx: TrackedTransaction = {
      id,
      family: "evm",
      network,
      account: account.walletId,
      hash: undefined,
      state: "draft",
      intent,
      nonce: unsigned.nonce,
      submittedAt: this.options.now(),
      error: undefined,
    };
    tx = await this.transition(tx, {});
    let signed: Awaited<ReturnType<ReturnType<typeof chains>["sign"]>>;
    try {
      const result = await apis.sign({ request, verify });
      tx = await this.transition(tx, { state: "signed" });
      signed = result;
    } catch (error) {
      await this.transition(tx, {
        state: "rejected",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    try {
      const raw = this.evm.finalize(unsigned, signed);
      const hash = await this.evm.broadcast(client, raw);
      tx = await this.transition(tx, { state: "submitted", hash, submittedAt: this.options.now() });
      this.track(tx.id, hash, network);
      return tx;
    } catch (error) {
      await this.transition(tx, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private track(id: string, hash: string, network: string): void {
    if (this.timers.has(id) || hash === "") {
      return;
    }
    const poll = this.options.pollMs ?? 4000;
    const stop = this.options.setTimer(poll, async () => {
      if (this.locked) {
        return;
      }
      try {
        const state = await this.evm.status(this.options.networks.client(network), hash);
        if (state === "pending") {
          return;
        }
        const tx = this.getState().txs[id];
        if (tx === undefined) {
          return;
        }
        const next: TxState = state === "finalized" ? "confirmed" : state;
        await this.transition(tx, { state: next });
        this.timers.delete(id);
        stop();
      } catch (error) {
        this.options.logger.warn("tx status poll failed", error);
      }
    });
    this.timers.set(id, stop);
  }
}
