/**
 * `createApps` — the app-enablement composition: a Hyperliquid provider wired to the request
 * pipeline, an `AppsController` that persists each group's app state through lock/unlock, and the
 * serialized lock lifecycle from engine.ts (`transition`/`schedule` on `wallet.subscribe`).
 */
import type { Wallet } from "@qntx/wallet";
import type { HyperliquidNetwork } from "@qntx/wallet/protocol";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { RequestController } from "../requests/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import type { SetTimer } from "../timer.ts";
import type { HyperliquidGroup } from "./hyperliquid/agents.ts";
import { createHyperliquidEnable } from "./hyperliquid/enable.ts";
import { createHyperliquidProvider } from "./hyperliquid/provider.ts";
import type { HyperliquidProvider } from "./hyperliquid/provider.ts";
import type { AppFlow, AppGroup, AppGroupState, AppId, AppProvider, AppsState } from "./types.ts";

const COLLECTION = "apps";

const DEFAULT_GROUP: AppGroupState = {
  status: "disabled",
  termsAcknowledged: false,
  renewalDue: false,
};

export type AppsBuilderConfig = {
  /** The builder address the trades attach once `maxBuilderFee` confirms `feeRateTenthsBps`. */
  readonly address: string;
  /** Tenths of a basis point: 1..100 (the perps cap is 0.1 %). */
  readonly feeRateTenthsBps: number;
};

export type AppsHyperliquidConfig = {
  readonly network: HyperliquidNetwork;
  /** The agent name — `^[A-Za-z0-9._-]{1,16}$`, the exchange's limit. */
  readonly agentName: string;
  readonly builder?: AppsBuilderConfig;
};

export type CreateAppsOptions = {
  readonly wallet: Wallet;
  readonly requests: Pick<RequestController, "prepare" | "outcome" | "reject">;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  readonly random: (length: number) => Uint8Array;
  readonly logger: EngineLogger;
  readonly openStore: () => Promise<EngineStore>;
  readonly hyperliquid: AppsHyperliquidConfig;
};

const recordKey = (group: AppGroup, app: AppId): string =>
  `${group.walletId}/${group.groupIndex}/${app}`;

const groupKey = (group: AppGroup): string => `${group.walletId}/${group.groupIndex}`;

const isGroupState = (value: unknown): value is AppGroupState =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  (value.status === "disabled" ||
    value.status === "enabling" ||
    value.status === "enabled" ||
    value.status === "needs-reauthorization");

const parseRecord = (raw: Uint8Array): AppGroupState | undefined => {
  const value: unknown = readJson(raw);
  /* Strict enough to resume: unknown fields are tolerated (forward records), required ones are
     re-derived by the next reconcile. */
  return isGroupState(value) ? { ...DEFAULT_GROUP, ...value } : undefined;
};

export type AppsControllerDeps = {
  readonly providers: ReadonlyMap<AppId, AppProvider>;
  readonly wallet: Wallet;
  readonly requests: Pick<RequestController, "reject">;
  readonly openStore: () => Promise<EngineStore>;
  readonly logger: EngineLogger;
};

/**
 * Per-group, per-app state machine owner. `init`/`lock` follow the engine's unlock lifecycle; host
 * calls run provider flows under a per-group generation so a new call supersedes an in-flight one
 * and a lock drops every write.
 */
export class AppsController extends Controller<AppsState> {
  private readonly deps: AppsControllerDeps;
  private engineStore: EngineStore | undefined;
  private generation = 0;
  private readonly flowGen = new Map<string, number>();
  /** Request ids the controller's flows opened and have not resolved — rejected on lock. */
  private readonly pendingRequests = new Set<string>();

  constructor(deps: AppsControllerDeps) {
    super({ name: "apps", defaultState: () => ({ locked: true, groups: {} }) });
    this.deps = deps;
  }

  async init(): Promise<void> {
    this.engineStore = await this.deps.openStore();
    const collection = this.engineStore.collection(COLLECTION);
    const keys = await collection.list();
    const groups: AppsState["groups"] = {};
    for (const key of keys) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- records load sequentially on unlock.
      const raw = await collection.get(key);
      const state = raw === undefined ? undefined : parseRecord(raw);
      const slash = key.lastIndexOf("/");
      const group = key.slice(0, slash);
      const app = key.slice(slash + 1) === "hyperliquid" ? ("hyperliquid" as const) : undefined;
      if (state === undefined || app === undefined) {
        this.deps.logger.warn(`apps record ${key} skipped: malformed`);
      } else {
        groups[group] = { ...groups[group], [app]: state };
      }
    }
    this.update(() => ({ locked: false, groups }));
    /* Re-derive every recorded group: kernel agents may have expired or been cleaned while the
       session was closed. */
    await Promise.all(
      Object.keys(groups).map(async (key) => {
        const slash = key.lastIndexOf("/");
        const group = {
          walletId: key.slice(0, slash),
          groupIndex: Number(key.slice(slash + 1)),
        };
        await this.reconcile(group);
      }),
    );
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  lock(): void {
    this.generation += 1;
    this.flowGen.clear();
    for (const id of this.pendingRequests) {
      this.deps.requests.reject(id);
    }
    this.pendingRequests.clear();
    this.engineStore = undefined;
    this.update((state) => ({ ...state, locked: true }));
  }

  private providerFor(app: AppId): AppProvider {
    const provider = this.deps.providers.get(app);
    if (provider === undefined) {
      throw new Error(`app ${app} is not implemented`);
    }
    return provider;
  }

  /** A flow for `group`/`app`: the captured generation makes a lock or a superseding call stale. */
  private flowFor(group: AppGroup, app: AppId): AppFlow {
    const key = recordKey(group, app);
    const gkey = groupKey(group);
    const gen = (this.flowGen.get(gkey) ?? 0) + 1;
    this.flowGen.set(gkey, gen);
    const { generation } = this;
    const stale = (): boolean =>
      generation !== this.generation || gen !== this.flowGen.get(gkey) || this.getState().locked;
    const current = (): AppGroupState => this.getState().groups[gkey]?.[app] ?? DEFAULT_GROUP;
    const persist = (state: AppGroupState): void => {
      const { engineStore } = this;
      void (async (): Promise<void> => {
        try {
          await engineStore
            ?.collection(COLLECTION)
            .put(key, new TextEncoder().encode(JSON.stringify(state)));
        } catch (error) {
          this.deps.logger.warn(`apps record ${key} write failed`, error);
        }
      })();
    };
    return {
      current,
      stale,
      write: (patch) => {
        if (stale()) {
          return;
        }
        /* `undefined` in a patch deletes the field: the spread puts it last, and the rebuild
           drops every undefined value. */
        const merged: Record<string, unknown> = {};
        for (const [field, value] of Object.entries({ ...current(), ...patch })) {
          if (value !== undefined) {
            merged[field] = value;
          }
        }
        const next = isGroupState(merged) ? merged : current();
        if (patch.requestId !== undefined) {
          this.pendingRequests.add(patch.requestId);
        }
        if (current().requestId !== undefined && patch.requestId !== current().requestId) {
          this.pendingRequests.delete(current().requestId ?? "");
        }
        this.update((state) => ({
          ...state,
          groups: { ...state.groups, [gkey]: { ...state.groups[gkey], [app]: next } },
        }));
        persist(next);
      },
    };
  }

  private groupOf(group: AppGroup): AppGroup {
    return { walletId: group.walletId, groupIndex: group.groupIndex };
  }

  /** Persisted terms acknowledgement — survives lock/unlock (stored in the group's record). */
  async acknowledgeTerms(group: HyperliquidGroup, app: AppId): Promise<void> {
    const flow = this.flowFor(this.groupOf(group), app);
    flow.write({ termsAcknowledged: true });
    await Promise.resolve();
  }

  async enable(group: HyperliquidGroup, app: AppId): Promise<void> {
    const flow = this.flowFor(this.groupOf(group), app);
    await this.providerFor(app).enable(this.groupOf(group), flow);
  }

  async renew(group: HyperliquidGroup, app: AppId): Promise<void> {
    const flow = this.flowFor(this.groupOf(group), app);
    await this.providerFor(app).renew(this.groupOf(group), flow);
  }

  async disable(group: HyperliquidGroup, app: AppId, options: { revoke: boolean }): Promise<void> {
    const flow = this.flowFor(this.groupOf(group), app);
    await this.providerFor(app).disable(this.groupOf(group), options, flow);
  }

  async cancel(group: HyperliquidGroup, app: AppId): Promise<void> {
    const flow = this.flowFor(this.groupOf(group), app);
    await this.providerFor(app).cancel(this.groupOf(group), flow);
  }

  private async reconcile(group: AppGroup): Promise<void> {
    for (const [app, provider] of this.deps.providers) {
      const flow = this.flowFor(group, app);
      // oxlint-disable-next-line eslint/no-await-in-loop -- providers reconcile in order.
      await provider.reconcile(group, flow).catch((error: unknown) => {
        this.deps.logger.warn(`apps reconcile ${app} failed`, error);
      });
    }
  }
}

/**
 * The apps composition: validates `hyperliquid` config, builds the provider, and drives the
 * controller's lifecycle off the wallet's lock state — the same `transition`/`schedule` chain
 * engine.ts serializes on `wallet.subscribe`.
 */
export function createApps(options: CreateAppsOptions): {
  readonly controller: AppsController;
  readonly hyperliquid: HyperliquidProvider;
  readonly destroy: () => Promise<void>;
} {
  const { network, agentName, builder } = options.hyperliquid;
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(agentName)) {
    throw new Error("hyperliquid agentName must match ^[A-Za-z0-9._-]{1,16}$");
  }
  if (builder !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(builder.address)) {
      throw new Error("hyperliquid builder.address must be a 20-byte hex address");
    }
    if (
      !Number.isInteger(builder.feeRateTenthsBps) ||
      builder.feeRateTenthsBps < 1 ||
      builder.feeRateTenthsBps > 100
    ) {
      throw new Error("hyperliquid builder.feeRateTenthsBps must be an integer in 1..100");
    }
  }

  const controllerRef: { current: AppsController | undefined } = { current: undefined };
  const provider = createHyperliquidProvider({
    wallet: options.wallet,
    network,
    fetch: options.fetch,
    setTimer: options.setTimer,
    now: options.now,
    random: options.random,
    logger: options.logger,
    requests: options.requests,
    builderFor: (group) => {
      /* Trades carry the builder only while the controller confirmed the fee — a lock or a
         stale approval makes it return undefined and the field is omitted. */
      if (builder === undefined) {
        return undefined;
      }
      const state = controllerRef.current?.getState().groups[groupKey(group)]?.hyperliquid;
      return state?.builder === "approved" ? builder : undefined;
    },
  });
  const enable = createHyperliquidEnable({
    wallet: options.wallet,
    provider,
    userSigned: provider.userSigned,
    requests: options.requests,
    network,
    agentName,
    ...(builder === undefined ? {} : { builder }),
    now: options.now,
    setTimer: options.setTimer,
    logger: options.logger,
  });
  const controller = new AppsController({
    providers: new Map<AppId, AppProvider>([["hyperliquid", enable]]),
    wallet: options.wallet,
    requests: options.requests,
    openStore: options.openStore,
    logger: options.logger,
  });
  controllerRef.current = controller;

  /* Serialized lifecycle: every wallet status change queues behind the previous one, so a lock
     during an unlock's init cannot interleave. */
  let started = false;
  let chain: Promise<void> = Promise.resolve();
  const transition = async (): Promise<void> => {
    const unlocked = options.wallet.getSnapshot().vault === "unlocked";
    if (unlocked && !started) {
      started = true;
      try {
        await provider.agents.refresh();
        await controller.init();
      } catch (error) {
        started = false;
        options.logger.warn("apps init failed", error);
      }
    } else if (!unlocked && started) {
      started = false;
      controller.lock();
    }
  };
  const schedule = (): void => {
    const previous = chain;
    chain = (async () => {
      try {
        await previous;
        await transition();
      } catch (error) {
        options.logger.warn("apps lock transition failed", error);
      }
    })();
  };
  const unsubscribe = options.wallet.subscribe(schedule);
  schedule();
  return {
    controller,
    hyperliquid: provider,
    destroy: async () => {
      unsubscribe();
      controller.lock();
      await chain;
    },
  };
}
