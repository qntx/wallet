/**
 * `createApps` — the app-enablement composition: a Hyperliquid provider wired to the request
 * pipeline, an `AppsController` that persists each group's terms flag and last-enabled agent
 * through lock/unlock, and the serialized lock lifecycle from engine.ts (`transition`/`schedule` on
 * `wallet.subscribe`).
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
import { HyperliquidError } from "./hyperliquid/errors.ts";
import { createHyperliquidProvider } from "./hyperliquid/provider.ts";
import type { HyperliquidProvider } from "./hyperliquid/provider.ts";
import type { AppFlow, AppGroup, AppGroupState, AppId, AppProvider, AppsState } from "./types.ts";

const COLLECTION = "apps";

const DEFAULT_GROUP: AppGroupState = {
  status: "disabled",
  termsAcknowledged: false,
  renewalDue: false,
};

/** What a group's record persists — nothing else is stable across sessions. */
type StoredGroup = {
  readonly termsAcknowledged: boolean;
  /** The last agent that reached `enabled` — `enabledAgent` chooses the reconciled status. */
  readonly enabledAgent?: string;
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

/** Exact keys only — a record with anything else reads as absent (logged by the caller). */
const parseRecord = (raw: Uint8Array): StoredGroup | undefined => {
  const value: unknown = readJson(raw);
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (Object.keys(value).some((k) => k !== "termsAcknowledged" && k !== "enabledAgent")) {
    return undefined;
  }
  if (!("termsAcknowledged" in value) || value.termsAcknowledged !== true) {
    return undefined;
  }
  if (
    "enabledAgent" in value &&
    (typeof value.enabledAgent !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.enabledAgent))
  ) {
    return undefined;
  }
  return {
    termsAcknowledged: true,
    ...("enabledAgent" in value && typeof value.enabledAgent === "string"
      ? { enabledAgent: value.enabledAgent }
      : {}),
  };
};

const isGroupState = (value: unknown): value is AppGroupState =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  (value.status === "disabled" ||
    value.status === "enabling" ||
    value.status === "enabled" ||
    value.status === "needs-reauthorization");

export type AppsControllerDeps = {
  readonly providers: ReadonlyMap<AppId, AppProvider>;
  readonly wallet: Wallet;
  readonly requests: Pick<RequestController, "reject">;
  readonly openStore: () => Promise<EngineStore>;
  readonly logger: EngineLogger;
};

/**
 * Per-group, per-app state machine owner. `init`/`lock` follow the engine's unlock lifecycle; host
 * calls run provider flows under a per-group generation so a superseding call or a lock drops stale
 * writes, and one flow per group+app runs at a time (`busy` otherwise).
 */
export class AppsController extends Controller<AppsState> {
  private readonly deps: AppsControllerDeps;
  private engineStore: EngineStore | undefined;
  private generation = 0;
  private readonly flowGen = new Map<string, number>();
  /** Groups with a flow in flight — a second enable/renew/disable is `busy`. */
  private readonly busy = new Set<string>();
  /** Request ids the flows opened and have not resolved — rejected on lock/cancel. */
  private readonly pendingRequests = new Set<string>();
  /** The last agent each record saw reach `enabled` — reconcile's status hint. */
  private readonly enabledAgents = new Map<string, string>();

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
      const stored = raw === undefined ? undefined : parseRecord(raw);
      const slash = key.lastIndexOf("/");
      const group = key.slice(0, slash);
      const app = key.slice(slash + 1) === "hyperliquid" ? ("hyperliquid" as const) : undefined;
      if (stored === undefined || app === undefined) {
        this.deps.logger.warn(`apps record ${key} skipped: malformed`);
      } else {
        groups[group] = {
          ...groups[group],
          [app]: { ...DEFAULT_GROUP, termsAcknowledged: stored.termsAcknowledged },
        };
        if (stored.enabledAgent !== undefined) {
          this.enabledAgents.set(key, stored.enabledAgent);
        }
      }
    }
    this.update(() => ({ locked: false, groups }));
    /* Re-derive every group that can carry state: persisted records and every group with a
       kernel agent on this network. */
    const union = new Map<string, AppGroup>();
    for (const key of Object.keys(groups)) {
      const slash = key.lastIndexOf("/");
      union.set(key, {
        walletId: key.slice(0, slash),
        groupIndex: Number(key.slice(slash + 1)),
      });
    }
    for (const provider of this.deps.providers.values()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- providers enumerate in order.
      for (const group of await provider.groups()) {
        union.set(groupKey(group), group);
      }
    }
    for (const group of union.values()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- groups reconcile sequentially.
      await this.reconcile(group);
    }
  }

  async destroy(): Promise<void> {
    await this.lock();
  }

  async lock(): Promise<void> {
    this.generation += 1;
    this.flowGen.clear();
    for (const id of this.pendingRequests) {
      this.deps.requests.reject(id);
    }
    this.pendingRequests.clear();
    const store = this.engineStore;
    this.engineStore = undefined;
    this.update((state) => ({ ...state, locked: true }));
    await store?.close();
  }

  private providerFor(app: AppId): AppProvider {
    const provider = this.deps.providers.get(app);
    if (provider === undefined) {
      throw new Error(`app ${app} is not implemented`);
    }
    return provider;
  }

  private requireUnlocked(): void {
    if (this.getState().locked) {
      throw new HyperliquidError("unlock-required", "the vault is locked");
    }
  }

  /**
   * A state view for `group`/`app` — `write` merges unless the captured generations went stale.
   * `acknowledgeTerms` and `reconcile` share it without starting a flow generation.
   */
  private view(group: AppGroup, app: AppId): AppFlow {
    const key = recordKey(group, app);
    const gkey = groupKey(group);
    const { generation } = this;
    /* The flow generation captured at creation — a `start` bump or a lock makes it stale. */
    const myGen = this.flowGen.get(gkey) ?? 0;
    const current = (): AppGroupState => this.getState().groups[gkey]?.[app] ?? DEFAULT_GROUP;
    const stale = (): boolean =>
      generation !== this.generation ||
      (this.flowGen.get(gkey) ?? 0) !== myGen ||
      this.getState().locked;
    const persist = (record: StoredGroup): void => {
      const { engineStore } = this;
      void (async (): Promise<void> => {
        try {
          await engineStore
            ?.collection(COLLECTION)
            .put(key, new TextEncoder().encode(JSON.stringify(record)));
        } catch (error) {
          this.deps.logger.warn(`apps record ${key} write failed`, error);
        }
      })();
    };
    return {
      current,
      stale,
      wasEnabledAgent: () => this.enabledAgents.get(key),
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
        if (!isGroupState(merged)) {
          return;
        }
        const next = merged;
        if (patch.requestId !== undefined) {
          this.pendingRequests.add(patch.requestId);
        }
        if (current().requestId !== undefined && patch.requestId !== current().requestId) {
          this.pendingRequests.delete(current().requestId ?? "");
        }
        /* The persisted record keeps only the terms flag and the last enabled agent. */
        if (next.status === "enabled" && next.agent !== undefined) {
          this.enabledAgents.set(key, next.agent.address);
        } else if (next.status === "disabled") {
          this.enabledAgents.delete(key);
        }
        this.update((state) => ({
          ...state,
          groups: { ...state.groups, [gkey]: { ...state.groups[gkey], [app]: next } },
        }));
        const enabledAgent = this.enabledAgents.get(key);
        persist({
          termsAcknowledged: next.termsAcknowledged,
          ...(enabledAgent === undefined ? {} : { enabledAgent }),
        });
      },
    };
  }

  private groupOf(group: AppGroup): AppGroup {
    return { walletId: group.walletId, groupIndex: group.groupIndex };
  }

  /** Bump the group's flow generation — a running flow's writes go stale — then hand out a view. */
  private start(group: AppGroup, app: AppId): AppFlow {
    const gkey = groupKey(group);
    this.flowGen.set(gkey, (this.flowGen.get(gkey) ?? 0) + 1);
    return this.view(group, app);
  }

  /** Persisted terms acknowledgement — survives lock/unlock; never supersedes a running flow. */
  async acknowledgeTerms(group: HyperliquidGroup, app: AppId): Promise<void> {
    this.requireUnlocked();
    this.view(this.groupOf(group), app).write({ termsAcknowledged: true });
    await Promise.resolve();
  }

  private async flow(
    group: HyperliquidGroup,
    app: AppId,
    run: (provider: AppProvider, flow: AppFlow) => Promise<void>,
  ): Promise<void> {
    this.requireUnlocked();
    const gkey = groupKey(group);
    if (this.busy.has(gkey)) {
      throw new HyperliquidError("busy", "an enablement flow is already running");
    }
    const provider = this.providerFor(app);
    const view = this.start(this.groupOf(group), app);
    this.busy.add(gkey);
    try {
      await run(provider, view);
    } finally {
      this.busy.delete(gkey);
    }
  }

  async enable(group: HyperliquidGroup, app: AppId): Promise<void> {
    await this.flow(group, app, async (provider, view) => provider.enable(group, view));
  }

  async renew(group: HyperliquidGroup, app: AppId): Promise<void> {
    await this.flow(group, app, async (provider, view) => provider.renew(group, view));
  }

  async disable(group: HyperliquidGroup, app: AppId, options: { revoke: boolean }): Promise<void> {
    await this.flow(group, app, async (provider, view) => provider.disable(group, options, view));
  }

  /** Abort the running flow: supersede it (its writes die), then reject and clean up. */
  async cancel(group: HyperliquidGroup, app: AppId): Promise<void> {
    this.requireUnlocked();
    const provider = this.providerFor(app);
    const view = this.start(this.groupOf(group), app);
    await provider.cancel(this.groupOf(group), view);
  }

  /** Re-derive the group's state from the kernel and Hyperliquid — never a flow. */
  async reconcile(group: AppGroup): Promise<void> {
    if (this.getState().locked) {
      return;
    }
    for (const [app, provider] of this.deps.providers) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- providers reconcile in order.
      await provider
        .reconcile(this.groupOf(group), this.view(this.groupOf(group), app))
        .catch((error: unknown) => {
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
      /* Trades carry the builder only while the controller confirmed the fee this session —
         a lock or a stale approval makes it return undefined and the field is omitted. */
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
      /* Session marks (enabled/rejected) are per-unlock — the next reconcile re-derives. */
      provider.agents.reset();
      await controller.lock();
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
      await controller.lock();
      await chain;
    },
  };
}
