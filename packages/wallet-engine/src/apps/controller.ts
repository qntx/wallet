/**
 * `createApps` — the app-enablement composition: the host lists the app definitions it wants, each
 * built over one shared `AppContext`; an `AppsController` persists each group's terms flag through
 * lock/unlock; and the serialized lock lifecycle from engine.ts (`transition`/`schedule` on
 * `wallet.subscribe`) drives every app's `unlock`/`lock`/`close` hooks.
 */
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { ChainsApi } from "@qntx/wallet/chains";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { APP_ID, eligibility as eligibilityContract } from "../gateway/contract/eligibility.ts";
import type { AppAvailability, EligibilityResponse } from "../gateway/contract/eligibility.ts";
import { parseWith } from "../gateway/contract/endpoint.ts";
import { CLIENT_ID_HEADER } from "../gateway/contract/primitives.ts";
import { gatewaySession } from "../gateway/session.ts";
import type { RequestController } from "../requests/controller.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import type { SetTimer } from "../timer.ts";
import type { AppSocket } from "./socket.ts";
import { createAppStorage } from "./storage.ts";
import type {
  AppApis,
  AppAuthority,
  AppContext,
  AppDefinition,
  AppError,
  AppFlow,
  AppGroup,
  AppGroups,
  AppGroupState,
  AppId,
  AppInstance,
  AppNetworks,
  AppProvider,
  AppsState,
  AppStates,
} from "./types.ts";

const COLLECTION = "apps";

/** One row of `AppsController.authorities`: an app's authority, or its own read failure. */
export type AppAuthorityRow = { readonly app: AppId } & (
  | { readonly authority: AppAuthority }
  | { readonly error: AppError }
);

/* The app's own error type carries `category`; an unexpected throw reads as `unavailable`. */
const authorityError = (error: unknown): AppError =>
  error instanceof Error && "category" in error && typeof error.category === "string"
    ? { category: error.category, message: error.message }
    : {
        category: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };

const DEFAULT_GROUP: AppGroupState = {
  status: "disabled",
  termsAcknowledged: false,
};

/** What a group's record persists — the terms flag alone; nothing else is stable across sessions. */
type StoredGroup = {
  readonly termsAcknowledged: true;
};

export type CreateAppsOptions = {
  readonly wallet: Wallet;
  /**
   * The account derivation seam every app shares — the engine's `signers.apis.account` (or the
   * `chains` account api for a host composing apps without the engine).
   */
  readonly account: ChainsApi["account"];
  readonly requests: Pick<RequestController, "prepare" | "outcome" | "reject">;
  /** The chain clients an app's deposit path reads allowance/burn limits through. */
  readonly networks: AppNetworks;
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
  if (Object.keys(value).some((k) => k !== "termsAcknowledged")) {
    return undefined;
  }
  if (!("termsAcknowledged" in value) || value.termsAcknowledged !== true) {
    return undefined;
  }
  return { termsAcknowledged: true };
};

const isGroupState = (value: unknown): value is AppGroupState =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  (value.status === "disabled" ||
    value.status === "enabling" ||
    value.status === "enabled" ||
    value.status === "needs-reauthorization" ||
    value.status === "needs-migration" ||
    value.status === "unavailable");

/**
 * Merge `next` under `app` into the group's row — the `Partial<G>` map is built dynamically from
 * base `AppGroupState` values under registered ids, exactly the shape `G`'s key space declares.
 */
const mergeGroup = <G extends AppGroups>(
  apps: Readonly<Partial<G>> | undefined,
  app: AppId,
  next: AppGroupState,
): Readonly<Partial<G>> => {
  const merged: Record<string, AppGroupState | undefined> = { ...apps, [app]: next };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `merged` holds only base states under app ids, the same shape `Partial<G>` declares.
  return merged as Readonly<Partial<G>>;
};

/** One registered app — the provider plus the availability set `enable`/`renew` start under. */
export type AppRegistration = {
  readonly provider: AppProvider;
  readonly enableWhen: ReadonlyArray<Exclude<AppAvailability, "blocked">>;
};

export type AppsControllerDeps = {
  /** The registered apps — the controller names none of them; the map key is the id. */
  readonly registrations: ReadonlyMap<AppId, AppRegistration>;
  readonly wallet: Wallet;
  readonly requests: Pick<RequestController, "reject">;
  readonly openStore: () => Promise<EngineStore>;
  /** `GET /v1/eligibility` through the gateway client — throws on transport/malformed answers. */
  readonly fetchEligibility: () => Promise<EligibilityResponse>;
  /**
   * The constructor hands out the private flow runner once — `createApps` closes over it so each
   * definition's `AppContext.flow` binds its own id through the same guards.
   */
  readonly bindFlow: (
    runner: (group: AppGroup, app: AppId, run: (flow: AppFlow) => Promise<void>) => Promise<void>,
  ) => void;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

/**
 * The controller's own patch — an `AppGroupPatch` that may also carry `termsAcknowledged`
 * (`acknowledgeTerms` writes it; provider patches never do).
 */
type ControllerPatch = {
  readonly [K in keyof AppGroupState]?: AppGroupState[K] | undefined;
};

/**
 * A state view for `group`/`app` — `write` merges unless the captured generations went stale.
 * `acknowledgeTerms` and `reconcile` share it without starting a flow generation.
 */
type ControllerFlow = {
  readonly current: () => AppGroupState;
  readonly write: (patch: ControllerPatch) => void;
  readonly stale: () => boolean;
};

/**
 * Per-group, per-app state machine owner. `init`/`lock` follow the engine's unlock lifecycle; host
 * calls run provider flows under a per-group+app generation so a superseding call or a lock drops
 * stale writes, and one flow per group+app runs at a time (`busy` otherwise).
 */
export class AppsController<G extends AppGroups = AppGroups> extends Controller<AppsState<G>> {
  private readonly deps: AppsControllerDeps;
  private engineStore: EngineStore | undefined;
  private generation = 0;
  private readonly flowGen = new Map<string, number>();
  /** Group+app pairs with a flow in flight — a second enable/renew/disable is `busy`. */
  private readonly busy = new Set<string>();
  /** Request ids the flows opened and have not resolved — rejected on lock/cancel. */
  private readonly pendingRequests = new Set<string>();

  constructor(deps: AppsControllerDeps) {
    super({
      name: "apps",
      defaultState: () => ({ locked: true, groups: {}, eligibility: { status: "unknown" } }),
    });
    this.deps = deps;
    deps.bindFlow(async (group, app, run) => {
      await this.flow(group, app, async (_provider, view) => run(view));
    });
  }

  async init(): Promise<void> {
    this.engineStore = await this.deps.openStore();
    const collection = this.engineStore.collection(COLLECTION);
    const keys = await collection.list();
    const groups: Record<string, Readonly<Partial<G>>> = {};
    for (const key of keys) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- records load sequentially on unlock.
      const raw = await collection.get(key);
      const stored = raw === undefined ? undefined : parseRecord(raw);
      const slash = key.lastIndexOf("/");
      const group = key.slice(0, slash);
      const suffix = key.slice(slash + 1);
      const app = this.deps.registrations.has(suffix) ? suffix : undefined;
      if (stored === undefined || app === undefined) {
        this.deps.logger.warn(`apps record ${key} skipped: malformed`);
      } else {
        groups[group] = mergeGroup(groups[group], app, {
          ...DEFAULT_GROUP,
          termsAcknowledged: stored.termsAcknowledged,
        });
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
    for (const [id, { provider }] of this.deps.registrations) {
      /* A lock mid-init turns the kernel enumeration into an error — groups() fails closed and
         the post-init vault check (transition) runs the lock path. */
      // oxlint-disable-next-line eslint/no-await-in-loop -- providers enumerate in order.
      const discovered = await provider.groups().catch((error: unknown): AppGroup[] => {
        this.deps.logger.warn(`apps groups ${id} failed`, error);
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
    this.busy.clear();
    for (const id of this.pendingRequests) {
      this.deps.requests.reject(id);
    }
    this.pendingRequests.clear();
    const store = this.engineStore;
    this.engineStore = undefined;
    /* A locked vault holds no account data — eligibility is not account data and stays. */
    this.update((state) => ({ ...state, locked: true, groups: {} }));
    await store?.close();
  }

  private registrationFor(app: AppId): AppRegistration {
    const registration = this.deps.registrations.get(app);
    if (registration === undefined) {
      throw new Error(`app ${app} is not implemented`);
    }
    return registration;
  }

  private providerFor(app: AppId): AppProvider {
    return this.registrationFor(app).provider;
  }

  private requireUnlocked(app: AppId): void {
    if (this.getState().locked) {
      throw this.providerFor(app).error("unlock-required", "the vault is locked");
    }
  }

  /** The app's availability under the last ready eligibility answer — undefined otherwise. */
  private availability(app: AppId): AppAvailability | undefined {
    const { eligibility } = this.getState();
    return eligibility.status === "ready" ? eligibility.apps?.[app] : undefined;
  }

  /**
   * `enable`/`renew` gate: unless eligibility is `ready` and the answer is one the app's
   * `enableWhen` declares, the flow must not start — `unknown`/`error`, an app absent from a ready
   * answer and any undeclared availability all refuse (a jurisdiction gate fails closed). This is a
   * UI boundary only: `disable`/`cancel`/trading are not gated, and the platform enforces its own
   * restrictions. The thrown error is the app's own type.
   */
  private requireAvailable(app: AppId): void {
    const availability = this.availability(app);
    const open =
      availability !== undefined &&
      this.registrationFor(app).enableWhen.some((allowed) => allowed === availability);
    if (!open) {
      const { country, region } = this.getState().eligibility;
      const where =
        country === undefined || country === null
          ? "an unverified"
          : `your (${[country, region].filter(Boolean).join("-")})`;
      throw this.providerFor(app).error(
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
    const patched: Record<string, Readonly<Partial<G>>> = { ...groups };
    let changed = false;
    for (const [gkey, apps] of Object.entries(groups)) {
      /* `Object.entries` on a generic `Partial<G>` widens to `any` — the controller only ever
         holds base group states, so the value type is stated once here. */
      for (const [app, group] of Object.entries<AppGroupState | undefined>(apps)) {
        const blocked =
          this.deps.registrations.has(app) &&
          eligibility.status === "ready" &&
          eligibility.apps?.[app] === "blocked";
        if (group?.status === "disabled" && blocked) {
          patched[gkey] = mergeGroup(patched[gkey], app, { ...group, status: "unavailable" });
          changed = true;
        } else if (group?.status === "unavailable" && eligibility.status === "ready" && !blocked) {
          patched[gkey] = mergeGroup(patched[gkey], app, { ...group, status: "disabled" });
          changed = true;
        }
      }
    }
    if (changed) {
      this.update((state) => ({ ...state, groups: patched }));
    }
  }

  private view(group: AppGroup, app: AppId): ControllerFlow {
    const key = recordKey(group, app);
    const gkey = groupKey(group);
    const { generation } = this;
    /* The flow generation captured at creation — a `start` bump or a lock makes it stale. */
    const myGen = this.flowGen.get(key) ?? 0;
    const current = (): AppGroupState => {
      const apps: Partial<Record<AppId, AppGroupState>> | undefined = this.getState().groups[gkey];
      return apps?.[app] ?? DEFAULT_GROUP;
    };
    const stale = (): boolean =>
      generation !== this.generation ||
      (this.flowGen.get(key) ?? 0) !== myGen ||
      this.getState().locked;
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
        this.update((state) => ({
          ...state,
          groups: { ...state.groups, [gkey]: mergeGroup(state.groups[gkey], app, next) },
        }));
      },
    };
  }

  private groupOf(group: AppGroup): AppGroup {
    return { walletId: group.walletId, groupIndex: group.groupIndex };
  }

  /** Bump the group+app's flow generation — a running flow's writes go stale — then hand out a view. */
  private start(group: AppGroup, app: AppId): ControllerFlow {
    const key = recordKey(group, app);
    this.flowGen.set(key, (this.flowGen.get(key) ?? 0) + 1);
    return this.view(group, app);
  }

  /** Persisted terms acknowledgement — survives lock/unlock; never supersedes a running flow. */
  async acknowledgeTerms(group: AppGroup, app: Extract<keyof G, string>): Promise<void> {
    this.requireUnlocked(app);
    const key = recordKey(this.groupOf(group), app);
    this.view(this.groupOf(group), app).write({ termsAcknowledged: true });
    /* The record is exactly the terms flag, written only here and only while unlocked — a lock
       that landed mid-write dropped the write and the store along with it. */
    const { engineStore } = this;
    try {
      await engineStore
        ?.collection(COLLECTION)
        .put(key, new TextEncoder().encode(JSON.stringify({ termsAcknowledged: true })));
    } catch (error) {
      this.deps.logger.warn(`apps record ${key} write failed`, error);
    }
  }

  private async flow(
    group: AppGroup,
    app: AppId,
    run: (provider: AppProvider, flow: AppFlow) => Promise<void>,
  ): Promise<void> {
    this.requireUnlocked(app);
    const key = recordKey(group, app);
    const provider = this.providerFor(app);
    if (this.busy.has(key)) {
      throw provider.error("busy", "an enablement flow is already running");
    }
    const view = this.start(this.groupOf(group), app);
    this.busy.add(key);
    try {
      await run(provider, view);
    } finally {
      this.busy.delete(key);
    }
  }

  async enable(group: AppGroup, app: Extract<keyof G, string>, input?: unknown): Promise<void> {
    this.requireAvailable(app);
    await this.flow(group, app, async (provider, view) => provider.enable(group, view, input));
  }

  async renew(group: AppGroup, app: Extract<keyof G, string>, input?: unknown): Promise<void> {
    this.requireAvailable(app);
    await this.flow(group, app, async (provider, view) => provider.renew(group, view, input));
  }

  async disable(
    group: AppGroup,
    app: Extract<keyof G, string>,
    options: { readonly revoke: boolean; readonly verify?: VerifyFactor },
  ): Promise<void> {
    await this.flow(group, app, async (provider, view) => provider.disable(group, options, view));
  }

  /** Abort the running flow: supersede it (its writes die), then reject and clean up. */
  async cancel(group: AppGroup, app: Extract<keyof G, string>): Promise<void> {
    this.requireUnlocked(app);
    const provider = this.providerFor(app);
    const view = this.start(this.groupOf(group), app);
    await provider.cancel(this.groupOf(group), view);
  }

  /** Re-derive the group's state from the kernel and the apps' own reads — never a flow. */
  async reconcile(group: AppGroup): Promise<void> {
    if (this.getState().locked) {
      return;
    }
    for (const [app, { provider }] of this.deps.registrations) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- providers reconcile in order.
      await provider
        .reconcile(this.groupOf(group), this.view(this.groupOf(group), app))
        .catch((error: unknown) => {
          this.deps.logger.warn(`apps reconcile ${app} failed`, error);
        });
    }
  }

  /**
   * The venue-held authorities every app reports for `group` — display-only, unlocked like the
   * other reads. An app without `authorities` contributes nothing and one's failure lands as its
   * own `{ app, error }` row instead of hiding the rest.
   */
  async authorities(group: AppGroup): Promise<ReadonlyArray<AppAuthorityRow>> {
    const rows: AppAuthorityRow[] = [];
    for (const [app, { provider }] of this.deps.registrations) {
      this.requireUnlocked(app);
      if (provider.authorities === undefined) {
        continue;
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- providers read in order.
        for (const authority of await provider.authorities(this.groupOf(group))) {
          rows.push({ app, authority });
        }
      } catch (error) {
        rows.push({ app, error: authorityError(error) });
      }
    }
    return rows;
  }
}

/**
 * The apps composition: runs each listed definition's `create` over one shared `AppContext`,
 * registers its provider under its id (a duplicate id throws), and drives the controller's
 * lifecycle off the wallet's lock state — the same `transition`/`schedule` chain engine.ts
 * serializes on `wallet.subscribe`. The returned surface mirrors the listed definitions: only their
 * apis appear next to `controller`/`destroy`, and the controller's group state is typed by them.
 */
export function createApps<const A extends ReadonlyArray<AppDefinition<AppId, unknown>>>(
  options: CreateAppsOptions & { readonly apps: A },
): {
  readonly controller: AppsController<AppStates<A>>;
  readonly destroy: () => Promise<void>;
} & AppApis<A> {
  /* The state accessors and `flow` are lazy: definitions capture them at `create`, but the
     controller only exists once every definition ran — `controllerRef`/`runFlow` read it per
     call. `sessionStore` is the store the controller last opened: set on open, cleared
     synchronously when that store's `close` runs (the controller closes it on lock), which is
     what makes `AppStorage` throw `closed` — and a locked vault reads as closed even before the
     queued transition closes the store. */
  const controllerRef: { current: AppsController<AppStates<A>> | undefined } = {
    current: undefined,
  };
  let runFlow:
    | ((group: AppGroup, app: AppId, run: (flow: AppFlow) => Promise<void>) => Promise<void>)
    | undefined;
  let sessionStore: EngineStore | undefined;
  const unlocked = (): boolean => options.wallet.getSnapshot().vault.status === "unlocked";
  const openStore = async (): Promise<EngineStore> => {
    const store = await options.openStore();
    sessionStore = store;
    return {
      collection: (name) => store.collection(name),
      close: async () => {
        if (sessionStore === store) {
          sessionStore = undefined;
        }
        return store.close();
      },
    };
  };
  /* `id` is the definition's own — captured once at registration: a late `id` read (a getter, or
     a `create` that mutated `this.id`) could otherwise stamp another app's origin. */
  const context = (id: AppId): AppContext => ({
    wallet: options.wallet,
    account: options.account,
    /* Requests the app opens are attributed to it — a provider cannot choose its origin. */
    requests: {
      prepare: async (input) => options.requests.prepare(input, { kind: "app", id }),
      outcome: async (id) => options.requests.outcome(id),
      reject: (id) => options.requests.reject(id),
    },
    networks: options.networks,
    fetch: options.fetch,
    now: options.now,
    setTimer: options.setTimer,
    random: options.random,
    logger: options.logger,
    socket: options.socket,
    availability: () => {
      /* Eligibility outlives the lock by design — market views keep working without an
         unlocked wallet, so the last ready answer stays readable. */
      const eligibility = controllerRef.current?.getState().eligibility;
      return eligibility?.status === "ready" ? eligibility.apps?.[id] : undefined;
    },
    groupState: (group) => {
      const state: AppsState | undefined = controllerRef.current?.getState();
      return state !== undefined && !state.locked ? state.groups[groupKey(group)]?.[id] : undefined;
    },
    flow: async (group, run) => {
      if (runFlow === undefined) {
        /* Cannot happen after `createApps` returned — the controller bound it in its
           constructor, before any definition's `flow` could run. */
        throw new Error("apps flow is not bound");
      }
      await runFlow(group, id, run);
    },
    storage: createAppStorage(id, () => (unlocked() ? sessionStore : undefined)),
  });
  const registrations = new Map<AppId, AppRegistration>();
  const instances: Array<AppInstance<unknown>> = [];
  const apis: Record<string, unknown> = {};
  const registered: AppId[] = [];
  for (const definition of options.apps) {
    const { id } = definition;
    if (!APP_ID.test(id)) {
      throw new Error(`app ${id} must match ^[a-z][a-z0-9-]{1,31}$`);
    }
    if (registrations.has(id)) {
      throw new Error(`app ${id} is defined twice`);
    }
    if (
      definition.enableWhen.length === 0 ||
      definition.enableWhen.some((allowed) => allowed !== "available" && allowed !== "close-only")
    ) {
      throw new Error(`app ${id} enableWhen must list "available" and/or "close-only"`);
    }
    const instance = definition.create(context(id));
    registrations.set(id, { provider: instance.provider, enableWhen: definition.enableWhen });
    instances.push(instance);
    apis[id] = instance.api;
    registered.push(id);
  }

  /* Generic prune (design.md 不变量 12): on every unlock and every wallet snapshot change the
     app collections drop the records of wallets the snapshot no longer lists — the wallet id
     is the key prefix before the first "/". The controller's own `apps` collection is never
     touched. */
  const prune = async (): Promise<void> => {
    const store = sessionStore;
    if (store === undefined) {
      return;
    }
    const live = new Set(options.wallet.getSnapshot().wallets.map((entry) => entry.walletId));
    for (const id of registered) {
      const collection = store.collection(`apps.${id}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- collections list and delete sequentially.
      for (const key of await collection.list()) {
        const slash = key.indexOf("/");
        if (!live.has(slash === -1 ? key : key.slice(0, slash))) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- records delete sequentially.
          await collection.delete(key);
        }
      }
    }
  };

  /* `gatewayScope("/v1/eligibility")` is "service" — a fixed client id keeps the whole contract
     table (which `gatewayFetch` needs for per-route scopes) out of this entry. */
  const clientId = gatewaySession(options.gateway.url, options.random).clientIds.service;
  const eligibilityFetch = async (input: URL): Promise<Response> =>
    options.fetch(input, { headers: { [CLIENT_ID_HEADER]: clientId } });
  const controller = new AppsController<AppStates<A>>({
    registrations,
    wallet: options.wallet,
    bindFlow: (runner) => {
      runFlow = runner;
    },
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
    openStore,
    logger: options.logger,
  });
  controllerRef.current = controller;

  /* Serialized lifecycle: every wallet status change queues behind the previous one, so a lock
     during an unlock's init cannot interleave. */
  let started = false;
  let chain: Promise<void> = Promise.resolve();
  const transition = async (): Promise<void> => {
    if (unlocked() && !started) {
      started = true;
      try {
        for (const instance of instances) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- apps unlock in list order.
          await instance.unlock?.();
        }
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
      for (const instance of instances) {
        instance.lock?.();
      }
      await controller.lock();
    }
    /* Every event while running prunes — this covers the post-`init` pass and the wallet
       add/remove/rename snapshots; on a lock the store is already gone and prune no-ops. */
    if (unlocked() && started) {
      await prune();
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
  const destroy = async (): Promise<void> => {
    unsubscribe();
    for (const instance of instances) {
      instance.close?.();
    }
    await controller.lock();
    await chain;
  };
  /* Each key in `apis` is the `id` of a definition in `A` holding that definition's `Api` — the
     mapped type says exactly that; the runtime object is built dynamically. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `apis` is the dynamic build of the static `AppApis<A>` shape.
  return { controller, ...apis, destroy } as {
    readonly controller: AppsController<AppStates<A>>;
    readonly destroy: () => Promise<void>;
  } & AppApis<A>;
}
