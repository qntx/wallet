import { decodeSparkAddress, encodeSparkAddress, SparkInputError, uuidv7 } from "@qntx/spark";
import type {
  CooperativeExitResult,
  LightningInvoice,
  LightningPayment,
  SparkClient,
  SparkTransfer,
} from "@qntx/spark";
import { registerLightningAddress, unregisterLightningAddress } from "@qntx/spark/lnurl";
import type { UnlockFactor } from "@qntx/wallet";
import type { SparkAccountRef, SparkApproveIntent } from "@qntx/wallet/protocol";
import type { SparkSigner } from "@qntx/wallet/spark";

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
  readonly signer: (ref: SparkAccountRef) => SparkSigner;
  readonly approve: (params: {
    account: SparkAccountRef;
    intent: SparkApproveIntent;
    verify: UnlockFactor;
  }) => Promise<unknown>;
};

export type SparkClientFactory = (options: {
  readonly ref: SparkAccountRef;
  readonly store: ReturnType<typeof sparkStore>;
  readonly signer: SparkSigner;
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

/** TransferId: the client and SO expect a UUIDv7 — mint it from the injected clock+random. */
const transferId = (random: (n: number) => Uint8Array, now: () => number): string =>
  uuidv7(random, now);

/** Catch-up sync for one pass: claim every pending transfer, then read balance and identity. */
async function resync(
  client: SparkClient,
  log: (transferId: string, error: unknown) => void,
): Promise<{ balance: number; identity: Uint8Array }> {
  const { failures } = await client.transfers.claimPending();
  for (const failure of failures) {
    log(failure.transferId, failure.error);
  }
  const [balance, identity] = await Promise.all([client.balance(), client.identityPublicKey()]);
  return { balance, identity };
}

/** Abortable backoff — resolves early when the signal aborts; removes its listener. */
async function eventsBackoff(failures: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(2 ** failures, 30) * 1000,
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
    const k = key(ref);
    this.accounts.set(k, ref);
    this.patch(k, { status: "locked" });
    if (this.engineStore !== undefined) {
      this.startAccount(ref);
    }
  }

  removeAccount(ref: SparkAccountRef): void {
    const k = key(ref);
    this.accounts.delete(k);
    this.stopAccount(k);
  }

  async init(): Promise<void> {
    for (const ref of this.accounts.values()) {
      this.startAccount(ref);
    }
    await Promise.resolve();
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

  private startAccount(ref: SparkAccountRef): void {
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
      const abort = new AbortController();
      this.aborts.set(k, abort);
      // The initial sync lives in the event loop's catch-up pass: a transient failure at
      // account start retries through the loop's backoff instead of leaving the account dead
      // in "error".
      this.runEvents(k, client, abort.signal, ref.network);
    } catch (error) {
      this.patch(k, { status: "error", errorCategory: categorize(error) });
      this.options.logger.warn("spark account failed to start", error);
    }
  }

  private runEvents(
    k: string,
    client: SparkClient,
    signal: AbortSignal,
    network: SparkAccountRef["network"],
  ): void {
    // Every pass resyncs before streaming: the catch-up claim retries anything a previous
    // pass failed on and covers events missed while disconnected — a failed claim is never
    // lost, only deferred one pass. Any throw or a clean stream end backs off (exponential,
    // abortable) and starts a new pass.
    const loop = async (): Promise<void> => {
      let failures = 0;
      while (!signal.aborted) {
        try {
          // Catch-up: claim pending transfers and refresh the balance snapshot. Per-transfer
          // failures are logged, not fatal — one poisoned transfer must not fail the pass.
          // oxlint-disable-next-line no-await-in-loop -- catch-up sync must precede streaming
          const { balance, identity } = await resync(client, (transferId, error) => {
            this.options.logger.warn(
              `spark catch-up claim failed for ${transferId} (${categorize(error)})`,
            );
          });
          this.patch(k, {
            balanceSats: balance,
            status: "ready",
            identityPublicKey: [...identity].map((b) => b.toString(16).padStart(2, "0")).join(""),
            sparkAddress: encodeSparkAddress({
              network,
              identityPublicKey: identity,
            }),
          });
          const iterator = client.events(signal)[Symbol.asyncIterator]();
          let open = true;
          while (open) {
            // oxlint-disable-next-line no-await-in-loop -- events arrive in stream order
            const item = await iterator.next();
            if (item.done === true) {
              open = false;
            } else {
              const event = item.value;
              if (event.type === "transfer") {
                try {
                  // oxlint-disable-next-line no-await-in-loop -- claims are ordered per event
                  await this.handleTransfer(client, event, signal, k);
                  failures = 0;
                } catch (error) {
                  // A terminal status (expired, returned…) is not a stream failure — log the
                  // transfer and keep consuming the stream.
                  if (!(error instanceof SparkInputError)) {
                    throw error;
                  }
                  this.options.logger.warn(
                    `spark claim of ${event.transferId} rejected (${categorize(error)})`,
                  );
                  failures = 0;
                }
              }
            }
          }
          // A clean end is abnormal for a permanent stream — back off like a failure.
          failures += 1;
          this.options.logger.warn("spark event stream ended — resubscribing");
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          failures += 1;
          if (failures === 1) {
            this.patch(k, { status: "error", errorCategory: categorize(error) });
          }
          this.options.logger.warn("spark event stream failed — resubscribing", error);
        }
        // oxlint-disable-next-line no-await-in-loop -- the backoff bounds resubscribe pace
        await eventsBackoff(failures, signal);
      }
    };
    void loop();
  }

  private async handleTransfer(
    client: SparkClient,
    event: { readonly direction: "incoming" | "outgoing"; readonly transferId: string },
    signal: AbortSignal,
    k: string,
  ): Promise<void> {
    if (event.direction === "incoming") {
      // claim(id) re-queries until the transfer turns claimable — it owns the protocol-level
      // wait for the SSP's claimable window, so no extra delay or pending-list scan here.
      await client.transfers.claim(event.transferId, { signal });
    }
    this.patch(k, { balanceSats: await client.balance() });
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
  ): Promise<SparkTransfer> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      const receiver = decodeSparkAddress(params.receiver);
      if (receiver.network !== ref.network) {
        throw new SparkControllerError("rejected", "receiver address is on a different network");
      }
      const identity = receiver.identityPublicKey;
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
        transferId: transferId(this.options.random, this.options.now),
      });
    });
  }

  async registerLightningAddress(
    ref: SparkAccountRef,
    params: { serverUrl: string; domain: string; username: string; description: string },
  ): Promise<{ lnurl: string; lightningAddress: string }> {
    const signer = this.options.spark.signer(ref);
    try {
      return await registerLightningAddress({ ...params, fetch: this.options.fetch, signer });
    } catch (error) {
      throw error instanceof SparkControllerError
        ? error
        : new SparkControllerError("internal", "registration failed");
    }
  }

  async unregisterLightningAddress(
    ref: SparkAccountRef,
    params: { serverUrl: string; domain: string; username: string },
  ): Promise<void> {
    const signer = this.options.spark.signer(ref);
    try {
      await unregisterLightningAddress({ ...params, fetch: this.options.fetch, signer });
    } catch (error) {
      throw error instanceof SparkControllerError
        ? error
        : new SparkControllerError("internal", "unregistration failed");
    }
  }

  async payInvoice(
    ref: SparkAccountRef,
    params: {
      invoice: string;
      amountSats?: number;
      maxFeeSats: number;
      verify: UnlockFactor;
    },
  ): Promise<LightningPayment> {
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
        transferId: transferId(this.options.random, this.options.now),
      });
    });
  }

  async createInvoice(
    ref: SparkAccountRef,
    params: { amountSats: number; memo?: string },
  ): Promise<LightningInvoice> {
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

  /**
   * Cooperative exit to an L1 address. The client exits `amountSats` of leaves and the payout is
   * `amountSats - fee`, so the approval intent carries the PAYOUT: `amountSats: exit - fee` and
   * `maxFeeSats: fee` — the kernel matches the exit output against the intent, not the leaf total.
   */
  async withdraw(
    ref: SparkAccountRef,
    params: {
      address: string;
      amountSats?: number;
      speed: "FAST" | "MEDIUM" | "SLOW";
      maxFeeSats?: number;
      verify: UnlockFactor;
    },
  ): Promise<CooperativeExitResult> {
    return this.guarded(async () => {
      const client = this.clientFor(ref);
      const exitAmount = params.amountSats ?? (await client.balance());
      const quote = await client.withdrawals.quoteCooperativeExit({
        address: params.address,
        amountSats: exitAmount,
      });
      const fee =
        quote.fees[
          params.speed === "FAST" ? "fast" : params.speed === "MEDIUM" ? "medium" : "slow"
        ];
      if (params.maxFeeSats !== undefined && params.maxFeeSats < fee) {
        throw new SparkControllerError("rejected", "maxFeeSats below the quoted fee");
      }
      if (fee >= exitAmount) {
        throw new SparkControllerError(
          "insufficient-funds",
          "exit fee meets or exceeds the amount",
        );
      }
      await this.options.spark.approve({
        account: ref,
        intent: {
          kind: "exit",
          address: params.address,
          amountSats: exitAmount - fee,
          maxFeeSats: fee,
        },
        verify: params.verify,
      });
      return client.withdrawals.cooperativeExit({
        address: params.address,
        speed: params.speed,
        maxFeeSats: fee,
        amountSats: exitAmount,
        transferId: transferId(this.options.random, this.options.now),
      });
    });
  }
}
