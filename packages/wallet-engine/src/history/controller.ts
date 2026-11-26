import * as z from "zod/mini";

import type { ChainTemplate, SparkNetwork } from "@qntx/wallet/protocol";

import type { AddressBookController } from "../addresses/controller.ts";
import { isTombstone } from "../addresses/record.ts";
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { NetworkController } from "../networks/controller.ts";
import { independentTrusted } from "../networks/controller.ts";
import type { SparkController } from "../spark/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import type { SetTimer } from "../timer.ts";
import type { TransactionController } from "../transactions/controller.ts";
import { bitcoinHistoryStream } from "./bitcoin.ts";
import { evmHistoryStream } from "./evm.ts";
import { localEntry } from "./local.ts";
import type { GroupAddresses, HistoryGroup } from "./local.ts";
import { compose, OrderedMerge } from "./merge.ts";
import type { Stream } from "./merge.ts";
import { solanaHistoryStream } from "./solana.ts";
import { sparkHistoryStream, sparkRecordEntries, sparkRecordsChanged } from "./spark.ts";
import { tronHistoryStream } from "./tron.ts";
import type { HistoryEntry } from "./types.ts";

const PAGE = 25;
const PERSIST_MAX = 200;
const COLLECTION = "history";
const RECIPIENT_STATES = new Set(["submitted", "pending", "confirmed"]);

export type GroupHistory = {
  readonly status: "loading" | "ready";
  readonly entries: ReadonlyArray<HistoryEntry>;
  readonly hasMore: boolean;
  /** Shown from the persisted cache; fresh load pending. */
  readonly stale: boolean;
  /** Source id → error message; the other sources still list their entries. */
  readonly errors: Readonly<Record<string, string>>;
  /** Networks whose provider omitted entries it could not page — the list has gaps there. */
  readonly truncated: ReadonlyArray<string>;
  /** Networks the gateway has no history for — the entry list is complete for the others. */
  readonly unsupported: ReadonlyArray<string>;
};

export type HistoryState = {
  readonly groups: Readonly<Record<string, GroupHistory>>;
};

export type HistoryControllerOptions = {
  readonly networks: Pick<
    NetworkController,
    | "enabled"
    | "client"
    | "gatewayFirst"
    | "independentClient"
    | "independentSolanaRpc"
    | "independentEsplora"
    | "independentTronApi"
    | "solanaRpc"
    | "tronApi"
    | "esplora"
  >;
  readonly chains: {
    readonly account: (params: {
      readonly walletId: string;
      readonly groupIndex: number;
      readonly template: ChainTemplate;
      readonly network: string;
    }) => Promise<
      { readonly address: string } | { readonly xpub: string; readonly changeMark: number }
    >;
  };
  readonly spark: Pick<SparkController, "history" | "store">;
  readonly sparkNetwork: SparkNetwork;
  readonly transactions: Pick<TransactionController, "store">;
  readonly addressBook: Pick<AddressBookController, "store">;
  readonly gateway: { readonly url: string; readonly fetch: typeof globalThis.fetch } | undefined;
  /** The session EngineStore — the engine opens it once per unlock and closes it on lock. */
  readonly openStore: () => Promise<EngineStore>;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

const changeSchema = z.looseObject({
  direction: z.enum(["in", "out"]),
  asset: z.string(),
  amount: z.string(),
  decimals: z.optional(z.int()),
  symbol: z.optional(z.string()),
  tokenId: z.optional(z.string()),
  listed: z.boolean(),
});

const entrySchema = z.looseObject({
  id: z.string(),
  family: z.enum(["evm", "solana", "bitcoin", "spark"]),
  network: z.string(),
  hash: z.string(),
  direction: z.enum(["in", "out", "self", "mixed"]),
  counterparties: z.array(z.string()),
  changes: z.array(changeSchema),
  fee: z.optional(z.string()),
  status: z.enum(["pending", "confirmed", "failed", "dropped", "replaced"]),
  timestamp: z.optional(z.number()),
  block: z.optional(z.number()),
  verified: z.boolean(),
  origin: z.enum(["chain", "provider", "local"]),
  flags: z.array(
    z.enum([
      "zero-value-transfer",
      "token-impersonation",
      "suspicious-token-symbol",
      "lookalike-counterparty",
      "chain-mismatch",
    ]),
  ),
  localTxId: z.optional(z.string()),
});

const persistedSchema = z.looseObject({ entries: z.array(entrySchema) });

/** A schema-checked row narrowed to HistoryEntry — optional props stay absent, not undefined. */
const toEntry = (parsed: z.output<typeof entrySchema>): HistoryEntry => ({
  id: parsed.id,
  family: parsed.family,
  network: parsed.network,
  hash: parsed.hash,
  direction: parsed.direction,
  counterparties: parsed.counterparties,
  changes: parsed.changes.map((change) => ({
    direction: change.direction,
    asset: change.asset,
    amount: change.amount,
    ...(change.decimals === undefined ? {} : { decimals: change.decimals }),
    ...(change.symbol === undefined ? {} : { symbol: change.symbol }),
    ...(change.tokenId === undefined ? {} : { tokenId: change.tokenId }),
    listed: change.listed,
  })),
  ...(parsed.fee === undefined ? {} : { fee: parsed.fee }),
  status: parsed.status,
  ...(parsed.timestamp === undefined ? {} : { timestamp: parsed.timestamp }),
  ...(parsed.block === undefined ? {} : { block: parsed.block }),
  verified: parsed.verified,
  origin: parsed.origin,
  flags: parsed.flags,
  ...(parsed.localTxId === undefined ? {} : { localTxId: parsed.localTxId }),
});

const groupKey = (group: HistoryGroup): string => `${group.walletId}:${group.groupIndex}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type GroupRuntime = {
  /** The group this runtime serves — recompositions look it up here, not by re-parsing the key. */
  readonly group: HistoryGroup;
  /** Serializes load/loadMore for this group. */
  tail: Promise<void>;
  /** Bumped by every load — a stale load never overwrites a newer one's result. */
  seq: number;
  merge?: OrderedMerge<HistoryEntry>;
  emitted: HistoryEntry[];
  mergeDone: boolean;
  own: GroupAddresses;
  errors: Record<string, string>;
  /** Networks that reported a truncated page during this load. */
  truncated: Set<string>;
  /** Networks the gateway answered `unsupported` during this load. */
  unsupported: Set<string>;
};

const newRuntime = (group: HistoryGroup): GroupRuntime => ({
  group,
  tail: Promise.resolve(),
  seq: 0,
  emitted: [],
  mergeDone: false,
  own: { bitcoin: new Set() },
  errors: {},
  truncated: new Set(),
  unsupported: new Set(),
});

/**
 * Per-account-group activity: every enabled chain family plus local tracked sends, merged
 * newest-first, persisted bounded. The controller holds no chain or secret access itself — all I/O
 * is injected, and the only state it ever writes is its own store and the history collection.
 */
export class HistoryController extends Controller<HistoryState> {
  private readonly options: HistoryControllerOptions;
  private engineStore: EngineStore | undefined;
  private generation = 0;
  private readonly runtimes = new Map<string, GroupRuntime>();
  private unsubscribes: ReadonlyArray<() => void> = [];

  constructor(options: HistoryControllerOptions) {
    super({ name: "history", defaultState: () => ({ groups: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.engineStore !== undefined) {
      return;
    }
    this.engineStore = await this.options.openStore();
    const recompose = (): void => this.recomposeAll();
    this.unsubscribes = [
      this.options.transactions.store.subscribe(recompose),
      this.options.addressBook.store.subscribe(recompose),
      this.options.spark.store.subscribe((next, previous) => {
        if (sparkRecordsChanged(next, previous)) {
          recompose();
        }
      }),
    ];
  }

  lock(): void {
    this.generation += 1;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    this.runtimes.clear();
    this.engineStore = undefined;
    this.update(() => ({ groups: {} }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  private runtime(group: HistoryGroup): GroupRuntime {
    const key = groupKey(group);
    let runtime = this.runtimes.get(key);
    if (runtime === undefined) {
      runtime = newRuntime(group);
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  /** Serialized per group; the queue survives a rejected task. */
  private async enqueue<T>(runtime: GroupRuntime, task: () => Promise<T>): Promise<T> {
    const { tail } = runtime;
    const result = (async () => {
      await tail;
      return task();
    })();
    runtime.tail = (async () => {
      try {
        await result;
      } catch {
        // A rejected task fails its own caller, not the queue behind it.
      }
    })();
    return result;
  }

  private writeGroup(
    key: string,
    patch: Partial<GroupHistory> & Pick<GroupHistory, "status" | "entries">,
  ): void {
    this.update((state) => {
      const current = state.groups[key];
      const next: GroupHistory = {
        status: patch.status,
        entries: patch.entries,
        hasMore: patch.hasMore ?? current?.hasMore ?? true,
        stale: patch.stale ?? current?.stale ?? false,
        errors: patch.errors ?? current?.errors ?? {},
        truncated: patch.truncated ?? current?.truncated ?? [],
        unsupported: patch.unsupported ?? current?.unsupported ?? [],
      };
      return { ...state, groups: { ...state.groups, [key]: next } };
    });
  }

  private locals(group: HistoryGroup, own: GroupAddresses): ReadonlyArray<HistoryEntry> {
    const { txs } = this.options.transactions.store.getState();
    return [
      ...Object.values(txs).flatMap((tx) => {
        const entry = localEntry(tx, group, own);
        return entry === undefined ? [] : [entry];
      }),
      ...sparkRecordEntries(this.options.spark.store.getState(), this.options.sparkNetwork, group),
    ];
  }

  /** Book entries + recipients of live tracked sends + the group's own addresses — never history. */
  private known(own: GroupAddresses): Record<HistoryEntry["family"], ReadonlyArray<string>> {
    const by: Record<HistoryEntry["family"], Set<string>> = {
      evm: new Set(),
      solana: new Set(),
      bitcoin: new Set(),
      tron: new Set(),
      spark: new Set(),
    };
    for (const record of Object.values(this.options.addressBook.store.getState().entries)) {
      if (!isTombstone(record)) {
        by[record.family].add(record.address);
      }
    }
    for (const tx of Object.values(this.options.transactions.store.getState().txs)) {
      if (RECIPIENT_STATES.has(tx.state)) {
        for (const flow of tx.intent?.outflows ?? []) {
          by[tx.family].add(flow.to);
        }
      }
    }
    if (own.evm !== undefined) {
      by["evm"].add(own.evm);
    }
    if (own.solana !== undefined) {
      by["solana"].add(own.solana);
    }
    if (own.tron !== undefined) {
      by["tron"].add(own.tron);
    }
    for (const address of own.bitcoin) {
      by["bitcoin"].add(address);
    }
    return {
      evm: [...by["evm"]],
      solana: [...by["solana"]],
      bitcoin: [...by["bitcoin"]],
      tron: [...by["tron"]],
      spark: [...by["spark"]],
    };
  }

  private entries(runtime: GroupRuntime, group: HistoryGroup): ReadonlyArray<HistoryEntry> {
    return compose(
      runtime.emitted,
      this.locals(group, runtime.own),
      this.known(runtime.own),
      runtime.mergeDone,
    );
  }

  /** Re-derive every loaded group's view — local sends and the known set move under it. */
  private recomposeAll(): void {
    const { groups } = this.getState();
    for (const [key, runtime] of this.runtimes) {
      const group = groups[key];
      if (group === undefined) {
        continue;
      }
      this.writeGroup(key, {
        status: group.status,
        entries: this.entries(runtime, runtime.group),
      });
    }
  }

  private async readPersisted(key: string): Promise<ReadonlyArray<HistoryEntry>> {
    const raw = await this.engineStore?.collection(COLLECTION).get(key);
    if (raw === undefined) {
      return [];
    }
    const parsed = persistedSchema.safeParse(readJson(raw));
    return parsed.success ? parsed.data.entries.map(toEntry) : [];
  }

  /** The newest PERSIST_MAX non-local entries — local sends are reconstructed, not stored. */
  private async persist(key: string, emitted: ReadonlyArray<HistoryEntry>): Promise<void> {
    try {
      const entries = emitted.filter((entry) => entry.origin !== "local").slice(0, PERSIST_MAX);
      await this.engineStore
        ?.collection(COLLECTION)
        .put(key, new TextEncoder().encode(JSON.stringify({ entries })));
    } catch (error) {
      this.options.logger.warn("history persist failed", error);
    }
  }

  /** The group's own addresses on every family — the sender side of every source and local match. */
  private async resolveOwn(group: HistoryGroup, own: GroupAddresses): Promise<void> {
    const [evmNetwork] = this.options.networks.enabled("evm");
    const [solanaNetwork] = this.options.networks.enabled("solana");
    const [tronNetwork] = this.options.networks.enabled("tron");
    const [evmAccount, solanaAccount, tronAccount] = await Promise.all([
      evmNetwork === undefined
        ? undefined
        : this.options.chains.account({ ...group, template: "evm.bip44", network: evmNetwork }),
      solanaNetwork === undefined
        ? undefined
        : this.options.chains.account({
            ...group,
            template: "solana.bip44-change",
            network: solanaNetwork,
          }),
      tronNetwork === undefined
        ? undefined
        : this.options.chains.account({
            ...group,
            template: "tron.bip44",
            network: tronNetwork,
          }),
    ]);
    if (evmAccount !== undefined && "address" in evmAccount) {
      own.evm = evmAccount.address;
    }
    if (solanaAccount !== undefined && "address" in solanaAccount) {
      own.solana = solanaAccount.address;
    }
    if (tronAccount !== undefined && "address" in tronAccount) {
      own.tron = tronAccount.address;
    }
  }

  private streams(
    group: HistoryGroup,
    own: GroupAddresses,
    cached: ReadonlyMap<string, HistoryEntry>,
    runtime: GroupRuntime,
  ): ReadonlyArray<Stream<HistoryEntry>> {
    const { networks, gateway } = this.options;
    const streams: Array<Stream<HistoryEntry>> = [];
    if (gateway !== undefined && own.evm !== undefined) {
      for (const network of networks.enabled("evm")) {
        // The indexer feed is gateway-only; a network the gateway doesn't head is skipped.
        if (!networks.gatewayFirst(network)) {
          continue;
        }
        const address = own.evm;
        streams.push(
          evmHistoryStream(
            { gateway, networks, setTimer: this.options.setTimer },
            network,
            address,
            cached,
            () => {
              runtime.truncated.add(network);
            },
            () => {
              runtime.unsupported.add(network);
            },
          ),
        );
      }
    }
    if (own.solana !== undefined) {
      for (const network of networks.enabled("solana")) {
        const independent = networks.independentSolanaRpc(network);
        streams.push(
          solanaHistoryStream(
            {
              rpc:
                independent.kind === "available" ? independent.client : networks.solanaRpc(network),
              network,
              owner: own.solana,
              trusted: independentTrusted(independent),
            },
            (id, error) => {
              runtime.errors[id] = errorMessage(error);
            },
          ),
        );
      }
    }
    if (gateway !== undefined && own.tron !== undefined) {
      for (const network of networks.enabled("tron")) {
        // The indexer feed is gateway-only; a network the gateway doesn't head is skipped.
        if (!networks.gatewayFirst(network)) {
          continue;
        }
        const address = own.tron;
        streams.push(
          tronHistoryStream(
            { gateway, networks, setTimer: this.options.setTimer },
            network,
            address,
            cached,
            () => {
              runtime.truncated.add(network);
            },
          ),
        );
      }
    }
    for (const network of networks.enabled("bitcoin")) {
      const independent = networks.independentEsplora(network);
      streams.push(
        bitcoinHistoryStream(
          {
            esplora:
              independent.kind === "available"
                ? () => independent.client
                : (n) => networks.esplora(n),
            account: async (params) => this.options.chains.account(params),
            trusted: independentTrusted(independent),
          },
          network,
          group,
          (bitcoin) => {
            for (const address of bitcoin) {
              own.bitcoin.add(address);
            }
          },
        ),
      );
    }
    streams.push(
      sparkHistoryStream(
        async (ref, page) => this.options.spark.history(ref, page),
        this.options.sparkNetwork,
        group,
      ),
    );
    return streams;
  }

  async load(group: HistoryGroup): Promise<void> {
    if (this.engineStore === undefined) {
      throw new Error("history requires an unlocked vault");
    }
    const key = groupKey(group);
    const runtime = this.runtime(group);
    runtime.seq += 1;
    const { seq } = runtime;
    const { generation } = this;
    await this.enqueue(runtime, async () => {
      const alive = (): boolean => this.generation === generation && runtime.seq === seq;
      if (this.getState().groups[key] === undefined) {
        const cached = await this.readPersisted(key);
        if (!alive()) {
          return;
        }
        runtime.emitted = [...cached];
        this.writeGroup(key, {
          status: "loading",
          entries: this.entries(runtime, group),
          stale: cached.length > 0,
        });
      }
      try {
        await this.resolveOwn(group, runtime.own);
      } catch (error) {
        runtime.errors["accounts"] = errorMessage(error);
        if (alive()) {
          this.writeGroup(key, {
            status: "ready",
            entries: this.entries(runtime, group),
            errors: { ...runtime.errors },
          });
        }
        return;
      }
      const persisted = new Map(runtime.emitted.map((entry) => [entry.id, entry]));
      runtime.errors = {};
      runtime.truncated.clear();
      runtime.unsupported.clear();
      runtime.merge = new OrderedMerge(
        this.streams(group, runtime.own, persisted, runtime),
        (entry) => entry.timestamp ?? Number.MAX_SAFE_INTEGER,
        (entry) => entry.id,
        (id, error) => {
          runtime.errors[id] = errorMessage(error);
        },
      );
      // `emitted` keeps the cached view until the fresh page lands — a mid-load recompose must
      // not blank the list.
      runtime.mergeDone = false;
      try {
        const page = await runtime.merge.take(PAGE);
        if (!alive()) {
          return;
        }
        runtime.emitted = [...page.items];
        runtime.mergeDone = page.done;
        this.writeGroup(key, {
          status: "ready",
          entries: this.entries(runtime, group),
          hasMore: !page.done,
          stale: false,
          errors: { ...runtime.errors },
          truncated: [...runtime.truncated].sort(),
          unsupported: [...runtime.unsupported].sort(),
        });
        await this.persist(key, runtime.emitted);
      } catch (error) {
        this.options.logger.warn(`history load ${key} failed`, error);
        if (alive()) {
          this.writeGroup(key, {
            status: "ready",
            entries: this.entries(runtime, group),
            errors: { ...runtime.errors },
          });
        }
      }
    });
  }

  async loadMore(group: HistoryGroup): Promise<void> {
    if (this.engineStore === undefined) {
      throw new Error("history requires an unlocked vault");
    }
    const key = groupKey(group);
    const runtime = this.runtimes.get(key);
    if (runtime === undefined) {
      return;
    }
    const { seq } = runtime;
    const { generation } = this;
    await this.enqueue(runtime, async () => {
      const { merge } = runtime;
      if (merge === undefined || this.getState().groups[key] === undefined) {
        return;
      }
      const page = await merge.take(PAGE);
      if (this.generation !== generation || runtime.seq !== seq) {
        return;
      }
      runtime.emitted = [...runtime.emitted, ...page.items];
      runtime.mergeDone = page.done;
      this.writeGroup(key, {
        status: "ready",
        entries: this.entries(runtime, group),
        hasMore: !page.done,
        stale: false,
        errors: { ...runtime.errors },
        truncated: [...runtime.truncated].sort(),
        unsupported: [...runtime.unsupported].sort(),
      });
      await this.persist(key, runtime.emitted);
    });
  }
}
