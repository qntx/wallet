/**
 * The app-enablement types the `AppsController` state and its per-app providers share — kept in
 * their own module so provider modules and `apps/controller.ts` do not import each other. See
 * design.md §公开类型 / §启用状态机.
 */
import type { Wallet } from "@qntx/wallet";

import type { EngineLogger } from "../events.ts";
import type { AppAvailability, EligibilityResponse } from "../gateway/contract/eligibility.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { PendingRequest, RequestController, RequestInput } from "../requests/controller.ts";
import type { SetTimer } from "../timer.ts";
import type { AppSocket } from "./socket.ts";

/**
 * The request pipeline stamped to one app's origin: `prepare` opens a request attributed `{ kind:
 * "app", id }` — a provider cannot choose its origin or carry a dApp one.
 */
export type AppRequests = {
  readonly prepare: (input: RequestInput) => Promise<PendingRequest>;
  readonly outcome: RequestController["outcome"];
  readonly reject: RequestController["reject"];
};

/** An app id — `^[a-z][a-z0-9-]{1,31}$`, validated by `createApps` at registration. */
export type AppId = string;

export type AppError = {
  /** The category the app reports for the failed step — its error type's, or a plain reason. */
  readonly category: string;
  readonly message: string;
};

export type AppStatus =
  | "disabled"
  | "enabling"
  | "enabled"
  | "needs-reauthorization"
  /**
   * The venue account must be migrated outside the wallet before it can be enabled — read-only
   * until then.
   */
  | "needs-migration"
  | "unavailable";

/** The fields the controller owns in every app's group state. */
export type AppGroupBase = {
  /**
   * `unavailable` is the eligibility overlay on `disabled`: the gateway says the app is blocked in
   * the caller's jurisdiction. `enabled`/`enabling` groups keep their status so the user can still
   * disable/cancel — the overlay never hides an existing position.
   */
  readonly status: AppStatus;
  /** `acknowledgeTerms` persists this across lock/unlock. */
  readonly termsAcknowledged: boolean;
  /** The pending approval request, when a step opened one. */
  readonly requestId?: string;
  /** The last failure — keeps `enabling`/`disabled` resumable. */
  readonly error?: AppError;
};

/**
 * An app's own group-state fields: any shape that does not redefine a controller field. The index
 * signature is what makes the constraint satisfiable — without it the never-keys alone are a weak
 * type and every legal detail shape ("no properties in common") is refused outright.
 */
export type AppDetail = { readonly [K in keyof AppGroupBase]?: never } & Readonly<
  Record<string, unknown>
>;

/** One wallet group's per-app state — every flow step writes this, so a lock can resume. */
export type AppGroupState<D extends AppDetail = Record<never, never>> = AppGroupBase & Partial<D>;

/** The gateway's per-app availability for this jurisdiction — `unknown`/`error` refuse enables. */
export type AppsEligibility = {
  readonly status: "unknown" | "ready" | "error";
  /* Keyed by any app id the gateway configures — an app absent from a ready answer is unknown:
     it refuses `enable`/`renew` exactly as when not ready and never takes the overlay. */
  readonly apps?: Readonly<Record<string, AppAvailability>>;
  readonly country?: EligibilityResponse["country"];
  readonly region?: EligibilityResponse["region"];
  readonly checkedAt?: number;
};

/** `Partial` whose members may be written `undefined` — the clear-a-field form a patch needs. */
type Clearable<T> = { readonly [K in keyof T]?: T[K] | undefined };

/**
 * A state merge for `AppFlow.write` — `undefined` clears a field (exactOptionalPropertyTypes would
 * otherwise refuse it). The terms flag is the controller's alone: `acknowledgeTerms` sets it, a
 * provider patch cannot. Mapped over `keyof AppGroupBase | keyof D` (the same key set
 * `Exclude<keyof AppGroupState<D>, "termsAcknowledged">` yields — computed this way so the detail
 * keys stay literal through the generic).
 */
export type AppGroupPatch<D extends AppDetail = Record<never, never>> = Omit<
  Clearable<AppGroupBase>,
  "termsAcknowledged"
> &
  Clearable<D>;

/**
 * The handle an enablement flow gets: `write` merges a patch into the group's app state unless the
 * flow went stale (a lock or a newer call bumped the generation), and `stale` tells the flow to
 * stop touching state and abort.
 */
export type AppFlow<D extends AppDetail = Record<never, never>> = {
  readonly current: () => AppGroupState<D>;
  readonly write: (patch: AppGroupPatch<D>) => void;
  readonly stale: () => boolean;
};

/** A wallet group — `walletId` plus `groupIndex`. */
export type AppGroup = {
  readonly walletId: string;
  readonly groupIndex: number;
};

/** What the controller asks a per-app provider for. */
export type AppProvider<D extends AppDetail = Record<never, never>> = {
  /**
   * The app's own error type for the controller's generic failures: `busy` and `unlock-required`
   * keep their category; `unavailable` is the jurisdiction gate (the app may report it under its
   * own category); `invalid-input` refuses a flow the group's state does not allow.
   */
  readonly error: (
    category: "busy" | "unlock-required" | "unavailable" | "invalid-input",
    message: string,
  ) => Error;
  /** The groups that carry kernel-side app state. */
  readonly groups: () => Promise<ReadonlyArray<AppGroup>>;
  /** Re-derive the group's app state from kernel state and the app's own reads. */
  readonly reconcile: (group: AppGroup, flow: AppFlow<D>) => Promise<void>;
  /** Run or resume the enable flow to `enabled`, or leave a resumable `enabling`/error state. */
  readonly enable: (group: AppGroup, flow: AppFlow<D>) => Promise<void>;
  /** Enable a fresh credential/agent, then drop the old one — the old stays usable until then. */
  readonly renew: (group: AppGroup, flow: AppFlow<D>) => Promise<void>;
  /**
   * Stop trading (the app's credentials deleted first); `revoke` also asks the app to invalidate
   * them server-side.
   */
  readonly disable: (
    group: AppGroup,
    options: { readonly revoke: boolean },
    flow: AppFlow<D>,
  ) => Promise<void>;
  /** Abandon an in-flight flow: reject its request, clean orphans, back to `disabled`. */
  readonly cancel: (group: AppGroup, flow: AppFlow<D>) => Promise<void>;
};

/** The chain clients an app's deposit path reads allowance/burn limits through. */
export type AppNetworks = Pick<NetworkController, "client" | "independentClient">;

/**
 * What `createApps` hands every app definition's `create` — the host-injected I/O plus lazy reads
 * of the controller's state. The controller only exists after every `create` ran, so the state
 * accessors are thunks: providers read them per call, never at construction.
 */
export type AppContext<D extends AppDetail = Record<never, never>> = {
  readonly wallet: Wallet;
  /** The request pipeline stamped `{ kind: "app", id }` with the definition's own id. */
  readonly requests: AppRequests;
  /** The chain clients an app's deposit path reads allowance/burn limits through. */
  readonly networks: AppNetworks;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  readonly random: (length: number) => Uint8Array;
  readonly logger: EngineLogger;
  readonly socket: (url: string) => AppSocket;
  /**
   * This app's availability under the last ready eligibility answer — `undefined` while unknown,
   * failed, or absent from the answer.
   */
  readonly availability: () => AppAvailability | undefined;
  /**
   * This app's state for `group` — `undefined` while locked or before any flow or reconcile wrote
   * it.
   */
  readonly groupState: (group: AppGroup) => AppGroupState<D> | undefined;
  /**
   * Runs `run` as a flow of this app on `group` under the controller's guards: refused with the
   * app's `unlock-required` while locked and `busy` while another flow of this app runs on the
   * group; its writes drop once a lock or a newer flow supersedes it.
   */
  readonly flow: (group: AppGroup, run: (flow: AppFlow<D>) => Promise<void>) => Promise<void>;
  /** The app's own records in the apps store (collection `apps.<id>`) — unlocked sessions only. */
  readonly storage: AppStorage;
};

/**
 * The app's per-group records in the session EngineStore — keys `${walletId}/${groupIndex}/${name}`
 * inside collection `apps.<id>`. Every method throws `EngineStoreError("closed")` while no session
 * store is open (the controller closes it on lock).
 */
export type AppStorage = {
  readonly get: (group: AppGroup, name: string) => Promise<Uint8Array | undefined>;
  readonly put: (group: AppGroup, name: string, bytes: Uint8Array) => Promise<void>;
  readonly delete: (group: AppGroup, name: string) => Promise<void>;
  /** The groups with at least one record — deduplicated. */
  readonly groups: () => Promise<ReadonlyArray<AppGroup>>;
};

/** What an app definition's `create` hands back: the public api, the provider, lifecycle hooks. */
export type AppInstance<Api, D extends AppDetail = Record<never, never>> = {
  /** The app surface `createApps` returns under the definition's id. */
  readonly api: Api;
  /** The enablement state machine the controller drives. */
  readonly provider: AppProvider<D>;
  /** Runs on every unlock before `controller.init` — a provider refreshes its session state. */
  readonly unlock?: () => Promise<void>;
  /** Runs on every lock before `controller.lock` — a provider resets its session marks. */
  readonly lock?: () => void;
  /** Runs on destroy before `controller.lock` — a provider closes its shared resources. */
  readonly close?: () => void;
};

/**
 * One app, declared: `createApps` calls `create` with the shared context and registers the instance
 * under `id` — a duplicate `id` throws.
 */
export type AppDefinition<Id extends AppId, Api, D extends AppDetail = Record<never, never>> = {
  readonly id: Id;
  /**
   * The eligibility answers under which `enable`/`renew` may start; anything else — `unknown`,
   * `error`, the app absent from a ready answer, or `blocked` — refuses.
   */
  readonly enableWhen: ReadonlyArray<Exclude<AppAvailability, "blocked">>;
  readonly create: (context: AppContext<D>) => AppInstance<Api, D>;
};

/** The per-app api surface `createApps` returns next to the controller — keyed by app id. */
export type AppApis<A extends ReadonlyArray<AppDefinition<AppId, unknown>>> = {
  readonly [D in A[number] as D["id"]]: D extends AppDefinition<AppId, infer Api> ? Api : never;
};

/** Every registered app's group state keyed by id — the loosest shape a groups map may hold. */
export type AppGroups = Readonly<Record<AppId, AppGroupState>>;

export type AppsState<G extends AppGroups = AppGroups> = {
  readonly locked: boolean;
  readonly groups: Readonly<Record<string, Readonly<Partial<G>>>>;
  readonly eligibility: AppsEligibility;
};

/** Each listed definition's group state, keyed by its id. */
export type AppStates<A extends ReadonlyArray<AppDefinition<AppId, unknown>>> = {
  readonly [D in A[number] as D["id"]]: D extends AppDefinition<AppId, unknown, infer S>
    ? AppGroupState<S>
    : never;
};
