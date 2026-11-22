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
import { eligibility as eligibilityContract } from "../gateway/contract/eligibility.ts";
import type { AppAvailability, EligibilityResponse } from "../gateway/contract/eligibility.ts";
import { parseWith } from "../gateway/contract/endpoint.ts";
import { CLIENT_ID_HEADER } from "../gateway/contract/primitives.ts";
import { gatewaySession } from "../gateway/session.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { RequestController } from "../requests/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import type { SetTimer } from "../timer.ts";
import type { HyperliquidGroup } from "./hyperliquid/agents.ts";
import { createHyperliquidEnable } from "./hyperliquid/enable.ts";
import { HyperliquidError } from "./hyperliquid/errors.ts";
import { createHyperliquidProvider } from "./hyperliquid/provider.ts";
import type { HyperliquidProvider } from "./hyperliquid/provider.ts";
import { createHyperliquidSocket } from "./hyperliquid/socket.ts";
import type { AppSocket } from "./hyperliquid/socket.ts";
import { isAppId } from "./types.ts";
import type {
  AppFlow,
  AppGroup,
  AppGroupState,
  AppId,
  AppProvider,
  AppRequests,
  AppsState,
} from "./types.ts";

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
  /** The user declined the builder approval — persisted while `builder` is `declined`. */
  readonly builderDeclined?: true;
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
  /** The chain clients `hyperliquid.fund.deposit` reads CCTP allowance/burn limits through. */
  readonly networks: Pick<NetworkController, "client">;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  readonly random: (length: number) => Uint8Array;
  readonly logger: EngineLogger;
  readonly openStore: () => Promise<EngineStore>;
  /**
   * The WebSocket factory live views stream over — `(url) => new WebSocket(url)` on any runtime
   * (browser, RN, Node ≥ 22). One socket serves every subscription.
   */
  readonly socket: (url: string) => AppSocket;
  /** The gateway base URL — eligibility is fetched through the engine's gateway client. */
  readonly gateway: { readonly url: string };
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
  if (
    Object.keys(value).some(
      (k) => k !== "termsAcknowledged" && k !== "enabledAgent" && k !== "builderDeclined",
    )
  ) {
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
  if ("builderDeclined" in value && value.builderDeclined !== true) {
    return undefined;
  }
  return {
    termsAcknowledged: true,
    ...("enabledAgent" in value && typeof value.enabledAgent === "string"
      ? { enabledAgent: value.enabledAgent }
      : {}),
    ...("builderDeclined" in value && value.builderDeclined === true
      ? { builderDeclined: true as const }
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
    value.status === "needs-reauthorization" ||
    value.status === "unavailable");

export type AppsControllerDeps = {
  readonly providers: ReadonlyMap<AppId, AppProvider>;
  readonly wallet: Wallet;
  readonly requests: Pick<RequestController, "reject">;
  readonly openStore: () => Promise<EngineStore>;
  /** `GET /v1/eligibility` through the gateway client — throws on transport/malformed answers. */
  readonly fetchEligibility: () => Promise<EligibilityResponse>;
  readonly now: () => number;
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
  /** Records whose builder approval the user declined — reconcile's declined-state hint. */
  private readonly declinedBuilders = new Set<string>();

  constructor(deps: AppsControllerDeps) {
    super({
      name: "apps",
      defaultState: () => ({ locked: true, groups: {}, eligibility: { status: "unknown" } }),
    });
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
        if (stored.builderDeclined === true) {
          this.declinedBuilders.add(key);
        }
      }
    }
    this.update((state) => ({ ...state, locked: false, groups }));
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
      /* A lock mid-init turns the kernel enumeration into an error — groups() fails closed and
         the post-init vault check (transition) runs the lock path. */
      // oxlint-disable-next-line eslint/no-await-in-loop -- providers enumerate in order.
      const discovered = await provider.groups().catch((error: unknown): AppGroup[] => {
        this.deps.logger.warn(`apps groups ${provider.id} failed`, error);
        return [];
      });
      for (const group of discovered) {
        union.set(groupKey(group), group);
      }
    }
    /* Eligibility lands before reconcile so the overlay applies during group derivation. */
    await this.refreshEligibility();
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

  /** The app's availability under the last ready eligibility answer — undefined otherwise. */
  private availability(app: AppId): AppAvailability | undefined {
    const { eligibility } = this.getState();
    return eligibility.status === "ready" ? eligibility.apps?.[app] : undefined;
  }

  /**
   * `enable`/`renew` gate: unless eligibility is `ready` and the app is `available`, the flow must
   * not start — `unknown`/`error` refuse too (a jurisdiction gate fails closed). This is a UI
   * boundary only: `disable`/`cancel`/trading are not gated, and the platform enforces its own
   * restrictions.
   */
  private requireAvailable(app: AppId): void {
    const availability = this.availability(app);
    if (availability !== "available") {
      const { country, region } = this.getState().eligibility;
      const where =
        country === undefined || country === null
          ? "an unverified"
          : `your (${[country, region].filter(Boolean).join("-")})`;
      throw new HyperliquidError(
        "unavailable",
        `this app is not available in ${where} jurisdiction`,
      );
    }
  }

  /**
   * Refetch `/v1/eligibility` and apply the overlay: `disabled` groups in a blocked jurisdiction
   * read `unavailable`; groups that were only overlaid revert when the app is no longer blocked.
   * Called on every unlock; hosts should call it on foreground too.
   */
  async refreshEligibility(): Promise<void> {
    if (this.getState().locked) {
      return;
    }
    try {
      const answer = await this.deps.fetchEligibility();
      this.update((state) => ({
        ...state,
        eligibility: {
          status: "ready",
          apps: answer.apps,
          country: answer.country,
          region: answer.region,
          checkedAt: this.deps.now(),
        },
      }));
    } catch (error) {
      this.deps.logger.warn("apps eligibility fetch failed", error);
      this.update((state) => ({
        ...state,
        eligibility: { status: "error", checkedAt: this.deps.now() },
      }));
    }
    /* Sweep: apply or lift the overlay on groups already written — `disabled` ↔ `unavailable`
       only; other statuses are never rewritten. */
    const { groups, eligibility } = this.getState();
    const patched: AppsState["groups"] = { ...groups };
    let changed = false;
    for (const [gkey, apps] of Object.entries(groups)) {
      for (const [app, group] of Object.entries(apps)) {
        const blocked =
          isAppId(app) && eligibility.status === "ready" && eligibility.apps?.[app] === "blocked";
        if (group?.status === "disabled" && blocked) {
          patched[gkey] = { ...patched[gkey], [app]: { ...group, status: "unavailable" } };
          changed = true;
        } else if (group?.status === "unavailable" && eligibility.status === "ready" && !blocked) {
          patched[gkey] = { ...patched[gkey], [app]: { ...group, status: "disabled" } };
          changed = true;
        }
      }
    }
    if (changed) {
      this.update((state) => ({ ...state, groups: patched }));
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
      wasBuilderDeclined: () => this.declinedBuilders.has(key),
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
        const next: AppGroupState =
          merged.status === "disabled" && this.availability(app) === "blocked"
            ? /* The eligibility overlay: `disabled` under a ready-blocked jurisdiction reads
                 `unavailable` — `enabled`/`enabling` are never rewritten. */
              { ...merged, status: "unavailable" }
            : merged;
        if (patch.requestId !== undefined) {
          this.pendingRequests.add(patch.requestId);
        }
        if (current().requestId !== undefined && patch.requestId !== current().requestId) {
          this.pendingRequests.delete(current().requestId ?? "");
        }
        /* The persisted record keeps only the terms flag and the last enabled agent. */
        if (next.status === "enabled" && next.agent !== undefined) {
          this.enabledAgents.set(key, next.agent.address);
        } else if (next.status === "disabled" || next.status === "unavailable") {
          this.enabledAgents.delete(key);
        }
        this.update((state) => ({
          ...state,
          groups: { ...state.groups, [gkey]: { ...state.groups[gkey], [app]: next } },
        }));
        /* The decline survives `enabling` rewrites until an approval replaces it. */
        if (next.builder === "declined") {
          this.declinedBuilders.add(key);
        } else if (next.builder === "approved") {
          this.declinedBuilders.delete(key);
        }
        const enabledAgent = this.enabledAgents.get(key);
        persist({
          termsAcknowledged: next.termsAcknowledged,
          ...(enabledAgent === undefined ? {} : { enabledAgent }),
          ...(this.declinedBuilders.has(key) ? { builderDeclined: true as const } : {}),
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
    this.requireAvailable(app);
    await this.flow(group, app, async (provider, view) => provider.enable(group, view));
  }

  async renew(group: HyperliquidGroup, app: AppId): Promise<void> {
    this.requireAvailable(app);
    await this.flow(group, app, async (provider, view) => provider.renew(group, view));
  }

  /** Ask an enabled group for the builder fee approval — the provider refuses when none exists. */
  async approveBuilder(group: HyperliquidGroup, app: AppId): Promise<void> {
    await this.flow(group, app, async (provider, view) => {
      if (view.current().status !== "enabled") {
        throw new HyperliquidError("invalid-input", "the group is not enabled");
      }
      await provider.approveBuilder(group, view);
    });
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
  const socket = createHyperliquidSocket({
    network,
    socket: options.socket,
    setTimer: options.setTimer,
    random: options.random,
  });
  /* Requests the app opens are attributed to it — a provider cannot choose its origin. */
  const appRequests: AppRequests = {
    prepare: async (input) => options.requests.prepare(input, { kind: "app", id: "hyperliquid" }),
    outcome: async (id) => options.requests.outcome(id),
    reject: (id) => options.requests.reject(id),
  };
  const provider = createHyperliquidProvider({
    wallet: options.wallet,
    network,
    fetch: options.fetch,
    setTimer: options.setTimer,
    now: options.now,
    random: options.random,
    logger: options.logger,
    requests: appRequests,
    networks: options.networks,
    socket,
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
    requests: appRequests,
    network,
    agentName,
    ...(builder === undefined ? {} : { builder }),
    now: options.now,
    setTimer: options.setTimer,
    logger: options.logger,
  });
  /* `gatewayScope("/v1/eligibility")` is "service" — a fixed client id keeps the whole contract
     table (which `gatewayFetch` needs for per-route scopes) out of this entry. */
  const clientId = gatewaySession(options.gateway.url, options.random).clientIds.service;
  const eligibilityFetch = async (input: URL): Promise<Response> =>
    options.fetch(input, { headers: { [CLIENT_ID_HEADER]: clientId } });
  const controller = new AppsController({
    providers: new Map<AppId, AppProvider>([["hyperliquid", enable]]),
    wallet: options.wallet,
    fetchEligibility: async (): Promise<EligibilityResponse> => {
      const url = new URL(eligibilityContract.path, options.gateway.url);
      const response = await eligibilityFetch(url);
      if (!response.ok) {
        throw new Error(`eligibility answered ${response.status}`);
      }
      const parsed = parseWith(eligibilityContract.response, await response.json());
      if (parsed === undefined) {
        throw new Error("malformed eligibility response");
      }
      return parsed;
    },
    now: options.now,
    requests: options.requests,
    openStore: options.openStore,
    logger: options.logger,
  });
  controllerRef.current = controller;

  /* Serialized lifecycle: every wallet status change queues behind the previous one, so a lock
     during an unlock's init cannot interleave. */
  let started = false;
  let chain: Promise<void> = Promise.resolve();
  const unlocked = (): boolean => options.wallet.getSnapshot().vault === "unlocked";
  const transition = async (): Promise<void> => {
    if (unlocked() && !started) {
      started = true;
      try {
        await provider.agents.refresh();
        await controller.init();
      } catch (error) {
        started = false;
        options.logger.warn("apps init failed", error);
      }
    }
    /* Not `else if`: a lock that lands while init is in flight must still close the store —
       init observes the lock only through its own failure, so the vault is re-read here. */
    if (!unlocked() && started) {
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
      socket.close();
      await controller.lock();
      await chain;
    },
  };
}
