import { decodeSparkAddress, encodeSparkAddress } from "@qntx/spark";
import type { SparkClient } from "@qntx/spark";
import type { UnlockFactor } from "@qntx/wallet";
import type { SparkAccountRef, SparkApproveIntent } from "@qntx/wallet/protocol";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import { categorize, SparkControllerError } from "./errors.ts";
import { sparkStore } from "./store.ts";

export type SparkAccountState = {
  readonly status: "locked" | "connecting" | "ready" | "error";
  readonly balanceSats?: number;
  readonly identityPublicKey?: string;
  readonly sparkAddress?: string;
  readonly errorCategory?: string;
};

export type SparkControllerState = {
  readonly accounts: Readonly<Record<string, SparkAccountState>>;
};

type SparkApis = {
  readonly signer: (ref: SparkAccountRef) => unknown;
  readonly approve: (params: {
    account: SparkAccountRef;
    intent: SparkApproveIntent;
    verify: UnlockFactor;
  }) => Promise<unknown>;
};

export type SparkClientFactory = (options: {
  readonly ref: SparkAccountRef;
  readonly store: ReturnType<typeof sparkStore>;
  readonly signer: unknown;
  readonly fetch: typeof globalThis.fetch;
}) => SparkClient;

export type SparkControllerOptions = {
  readonly spark: SparkApis;
  readonly fetch: typeof globalThis.fetch;
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
  readonly createClient: SparkClientFactory;
};

const key = (ref: SparkAccountRef): string => `${ref.walletId}:${ref.groupIndex}:${ref.network}`;

/** TransferId: idempotency key only — hex-random is fine; uuidv7 isn't exported by @qntx/spark. */
const transferId = (random: (n: number) => Uint8Array): string =>
  [...random(16)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class SparkController extends Controller<SparkControllerState> {
  private readonly options: SparkControllerOptions;
  private engineStore: EngineStore | undefined;
  private readonly accounts = new Map<string, SparkAccountRef>();
  private readonly clients = new Map<string, SparkClient>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(options: SparkControllerOptions) {
    super({ name: "spark", defaultState: () => ({ accounts: {} }) });
    this.options = options;
  }

  /** Engine calls this with the open store on unlock; `undefined` on lock. */
  setStore(store: EngineStore | undefined): void {
    this.engineStore = store;
  }

  addAccount(ref: SparkAccountRef): void {
    this.accounts.set(key(ref), ref);
  }

  removeAccount(ref: SparkAccountRef): void {
    const k = key(ref);
    this.accounts.delete(k);
    this.stopAccount(k);
  }

  async init(): Promise<void> {
    for (const ref of this.accounts.values()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- accounts start sequentially in order
      await this.startAccount(ref);
    }
  }

  async destroy(): Promise<void> {
    await this.lockAll();
  }

  private stopAccount(k: string): void {
    this.aborts.get(k)?.abort();
    this.aborts.delete(k);
    this.clients.get(k)?.close();
    this.clients.delete(k);
    this.update((s) => {
      if (!(k in s.accounts)) {
        return s;
      }
      const { [k]: _dropped, ...rest } = s.accounts;
      void _dropped;
      return { ...s, accounts: rest };
    });
  }

  /** Lock: abort every event loop, close every client, reset state. */
  async lockAll(): Promise<void> {
    for (const [k, client] of this.clients) {
      this.aborts.get(k)?.abort();
      client.close();
    }
    this.aborts.clear();
    this.clients.clear();
    this.engineStore = undefined;
    await Promise.resolve();
    this.update((s) =>
      Object.keys(s.accounts).length === 0
        ? s
        : {
            ...s,
            accounts: Object.fromEntries(
              Object.keys(s.accounts).map((k) => [k, { status: "locked" as const }]),
            ),
          },
    );
  }

  private async startAccount(ref: SparkAccountRef): Promise<void> {
    const k = key(ref);
    if (this.engineStore === undefined || this.clients.has(k)) {
      return;
    }
    this.patch(k, { status: "connecting" });
    try {
      const col = this.engineStore.collection(`spark-exit-chains:${k}`);
      const client = this.options.createClient({
        ref,
        store: sparkStore(col),
        signer: this.options.spark.signer(ref),
        fetch: this.options.fetch,
      });
      this.clients.set(k, client);
      await client.transfers.claimPending();
      const [balance, identity] = await Promise.all([client.balance(), client.identityPublicKey()]);
      const sparkAddress = encodeSparkAddress({
        network: ref.network,
        identityPublicKey: identity,
      });
      this.patch(k, {
        status: "ready",
        balanceSats: balance,
        identityPublicKey: [...identity].map((b) => b.toString(16).padStart(2, "0")).join(""),
        sparkAddress,
      });
      const abort = new AbortController();
      this.aborts.set(k, abort);
      this.runEvents(k, client, abort.signal);
    } catch (error) {
      this.patch(k, { status: "error", errorCategory: categorize(error) });
      this.options.logger.warn("spark account failed to start", error);
    }
  }

  private runEvents(k: string, client: SparkClient, signal: AbortSignal): void {
    const loop = async (): Promise<void> => {
      try {
        for await (const event of client.events(signal)) {
          if (event.type === "transfer") {
            if (event.direction === "incoming") {
              await client.transfers.claimPending();
            }
            const balance = await client.balance();
            this.patch(k, { balanceSats: balance });
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          this.patch(k, { status: "error", errorCategory: categorize(error) });
        }
      }
    };
    void loop();
  }

  private patch(k: string, delta: Partial<SparkAccountState>): void {
    this.update((s) => ({
      ...s,
      accounts: { ...s.accounts, [k]: { status: "locked" as const, ...s.accounts[k], ...delta } },
    }));
  }

  private clientFor(ref: SparkAccountRef): SparkClient {
    const client = this.clients.get(key(ref));
    if (client === undefined) {
      throw new SparkControllerError("internal", "account is not connected");
    }
    return client;
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SparkControllerError) {
        throw error;
      }
      throw new SparkControllerError(categorize(error), "spark action failed");
    }
  }

  async send(
    ref: SparkAccountRef,
    params: {
      receiver: string;
      amountSats: number;
      verify: UnlockFactor;
    },
  ): Promise<unknown> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      const identity = decodeSparkAddress(params.receiver).identityPublicKey;
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "transfer",
          receivers: [{ identityPublicKey: identity, amountSats: params.amountSats }],
        },
        verify: params.verify,
      });
      return client.transfers.send({
        receiver: params.receiver,
        amountSats: params.amountSats,
        transferId: transferId(this.options.random),
      });
    });
  }

  async payInvoice(
    ref: SparkAccountRef,
    params: {
      invoice: string;
      amountSats?: number;
      maxFeeSats: number;
      verify: UnlockFactor;
    },
  ): Promise<unknown> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "lightning",
          invoice: params.invoice,
          ...(params.amountSats === undefined ? {} : { amountSats: params.amountSats }),
          maxFeeSats: params.maxFeeSats,
        },
        verify: params.verify,
      });
      return client.lightning.pay({
        invoice: params.invoice,
        maxFeeSats: params.maxFeeSats,
        ...(params.amountSats === undefined ? {} : { amountSats: params.amountSats }),
        transferId: transferId(this.options.random),
      });
    });
  }

  async createInvoice(
    ref: SparkAccountRef,
    params: { amountSats: number; memo?: string },
  ): Promise<unknown> {
    return this.guarded(async () =>
      this.clientFor(ref).lightning.createInvoice({
        amountSats: params.amountSats,
        ...(params.memo === undefined ? {} : { memo: params.memo }),
      }),
    );
  }

  async receiveAddress(ref: SparkAccountRef): Promise<string | undefined> {
    const state = this.getState().accounts[key(ref)];
    await Promise.resolve();
    return state?.sparkAddress;
  }

  async withdraw(
    ref: SparkAccountRef,
    params: {
      address: string;
      amountSats?: number;
      speed: "FAST" | "MEDIUM" | "SLOW";
      maxFeeSats?: number;
      verify: UnlockFactor;
    },
  ): Promise<unknown> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      const amountSats = params.amountSats ?? (await client.balance());
      const quote = await client.withdrawals.quoteCooperativeExit({
        address: params.address,
        amountSats,
      });
      const quoteFee =
        quote.fees[
          params.speed === "FAST" ? "fast" : params.speed === "MEDIUM" ? "medium" : "slow"
        ];
      const fee =
        params.maxFeeSats === undefined ? quoteFee : Math.min(params.maxFeeSats, quoteFee);
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "exit",
          address: params.address,
          amountSats,
          maxFeeSats: fee,
        },
        verify: params.verify,
      });
      return client.withdrawals.cooperativeExit({
        address: params.address,
        speed: params.speed,
        maxFeeSats: fee,
        amountSats,
        transferId: transferId(this.options.random),
      });
    });
  }
}
