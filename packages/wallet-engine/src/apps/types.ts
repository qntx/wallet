/**
 * The app-enablement types the `AppsController` state and its per-app providers share — kept in
 * their own module so `apps/hyperliquid/enable.ts` and `apps/controller.ts` do not import each
 * other. See design.md §公开类型 / §启用状态机.
 */
import type { Wallet } from "@qntx/wallet";

import type { EngineLogger } from "../events.ts";
import type { AppAvailability, EligibilityResponse } from "../gateway/contract/eligibility.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { RequestController } from "../requests/controller.ts";
import type { SetTimer } from "../timer.ts";
import type { AppSocket } from "./socket.ts";

/** The apps the controller knows; unimplemented ids are typed, never stubbed. */
export type AppId = "hyperliquid" | "polymarket";

export const isAppId = (value: string): value is AppId =>
  value === "hyperliquid" || value === "polymarket";

/**
 * The resumable enablement step a group is in; absent when `status` is terminal. The
 * `create-agent`/`approve-*` steps are Hyperliquid's; `locate-wallet`/`deploy-wallet`/
 * `credentials`/`approvals` are Polymarket's; `verify`/`revoke` are shared.
 */
export type AppStep =
  | "create-agent"
  | "approve-agent"
  | "approve-builder"
  | "locate-wallet"
  | "deploy-wallet"
  | "credentials"
  | "approvals"
  | "verify"
  | "revoke";

export type AppAgent = {
  readonly address: string;
  readonly name: string;
  readonly validUntil: number;
  readonly network: string;
};

export type AppError = {
  /** The `HyperliquidError` category (or a plain reason) of the failed step. */
  readonly category: string;
  readonly message: string;
};

/** One wallet group's per-app state — every flow step writes this, so a lock can resume. */
export type AppGroupState = {
  /**
   * `unavailable` is the eligibility overlay on `disabled`: the gateway says the app is blocked in
   * the caller's jurisdiction. `enabled`/`enabling` groups keep their status so the user can still
   * disable/cancel — the overlay never hides an existing position.
   */
  readonly status:
    | "disabled"
    | "enabling"
    | "enabled"
    | "needs-reauthorization"
    /** Polymarket only: the group resolves to a legacy Safe — read-only until migrated. */
    | "needs-migration"
    | "unavailable";
  /** `acknowledgeTerms` persists this across lock/unlock. */
  readonly termsAcknowledged: boolean;
  /** The agent the group is enabling or enabled with. */
  readonly agent?: AppAgent;
  /** The step an `enabling` flow is at — `verify` also marks a lost-POST re-check. */
  readonly step?: AppStep;
  /** The pending approval request, when a step opened one. */
  readonly requestId?: string;
  /** `validUntil - now < 14 days` — the host surfaces a renew prompt. */
  readonly renewalDue: boolean;
  /**
   * `approved` once `maxBuilderFee(owner, builder) >= f` was confirmed on Hyperliquid; `declined`
   * when the user refused the approval — trades go out without a builder either way the fee is
   * unconfirmed.
   */
  readonly builder?: "approved" | "declined";
  /** The located Polymarket account — positions/balance reads scope to `wallet`. */
  readonly account?: {
    readonly wallet: string;
    readonly kind: "deposit-wallet" | "safe";
    readonly deployed: boolean;
    readonly legacySafe?: string;
  };
  /** The last failure — keeps `enabling`/`disabled` resumable. */
  readonly error?: AppError;
};

/** The controller's per-groups view: `"<walletId>/<groupIndex>"` → per-app group state. */
/** The gateway's per-app availability for this jurisdiction — `unknown`/`error` refuse enables. */
export type AppsEligibility = {
  readonly status: "unknown" | "ready" | "error";
  readonly apps?: Readonly<Record<AppId, AppAvailability>>;
  readonly country?: EligibilityResponse["country"];
  readonly region?: EligibilityResponse["region"];
  readonly checkedAt?: number;
};

export type AppsState = {
  readonly locked: boolean;
  readonly groups: Record<string, Readonly<Partial<Record<AppId, AppGroupState>>>>;
  readonly eligibility: AppsEligibility;
};

/**
 * A state merge for `AppFlow.write` — `undefined` clears a field (exactOptionalPropertyTypes would
 * otherwise refuse it).
 */
export type AppGroupPatch = {
  readonly [K in keyof AppGroupState]?: AppGroupState[K] | undefined;
};

/**
 * The handle an enablement flow gets: `write` merges a patch into the group's app state unless the
 * flow went stale (a lock or a newer call bumped the generation), and `stale` tells the flow to
 * stop touching state and abort.
 */
export type AppFlow = {
  readonly current: () => AppGroupState;
  readonly write: (patch: AppGroupPatch) => void;
  readonly stale: () => boolean;
  /** The address of the last agent a previous session enabled, when the record persisted one. */
  readonly wasEnabledAgent: () => string | undefined;
  /** Whether the persisted record saw the builder approval declined. */
  readonly wasBuilderDeclined: () => boolean;
};

/** A wallet group — identical to the trading path's `HyperliquidGroup`. */
export type AppGroup = {
  readonly walletId: string;
  readonly groupIndex: number;
};

/** What the controller asks a per-app provider for — Hyperliquid implements it today. */
export type AppProvider = {
  readonly id: AppId;
  /**
   * The app's own error type for the controller's generic failures: `busy` and `unlock-required`
   * keep their category; `unavailable` is the jurisdiction gate (Polymarket reports `blocked`);
   * `invalid-input` refuses a flow the group's state does not allow.
   */
  readonly error: (
    category: "busy" | "unlock-required" | "unavailable" | "invalid-input",
    message: string,
  ) => Error;
  /** The groups that carry kernel-side app state — Hyperliquid's agents on this network. */
  readonly groups: () => Promise<ReadonlyArray<AppGroup>>;
  /** Re-derive the group's app state from kernel agents and Hyperliquid reads. */
  readonly reconcile: (group: AppGroup, flow: AppFlow) => Promise<void>;
  /** Run or resume the enable flow to `enabled`, or leave a resumable `enabling`/error state. */
  readonly enable: (group: AppGroup, flow: AppFlow) => Promise<void>;
  /** Ask an enabled group for the builder fee approval it declined or never gave. */
  readonly approveBuilder: (group: AppGroup, flow: AppFlow) => Promise<void>;
  /** Enable a fresh agent, then drop the old one — the old stays usable until then. */
  readonly renew: (group: AppGroup, flow: AppFlow) => Promise<void>;
  /**
   * Stop trading (agents deleted first); `revoke` also re-approves a throwaway agent under the same
   * name — Hyperliquid has no revoke action, a same-name approval deregisters the old one.
   */
  readonly disable: (
    group: AppGroup,
    options: { readonly revoke: boolean },
    flow: AppFlow,
  ) => Promise<void>;
  /** Abandon an in-flight flow: reject its request, clean orphans, back to `disabled`. */
  readonly cancel: (group: AppGroup, flow: AppFlow) => Promise<void>;
};

/**
 * What `createApps` hands every app definition's `create` — the host-injected I/O plus a lazy read
 * of the controller's state. The controller only exists after every `create` ran, so `state` is a
 * thunk: gates (the Hyperliquid builder gate, the Polymarket availability gate) read it per call,
 * never at construction.
 */
export type AppContext = {
  readonly wallet: Wallet;
  readonly requests: Pick<RequestController, "prepare" | "outcome" | "reject">;
  /** The chain clients `hyperliquid.fund.deposit` reads CCTP allowance/burn limits through. */
  readonly networks: Pick<NetworkController, "client">;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly setTimer: SetTimer;
  readonly random: (length: number) => Uint8Array;
  readonly logger: EngineLogger;
  readonly socket: (url: string) => AppSocket;
  /** The controller state — `undefined` until `createApps` returns. */
  readonly state: () => AppsState | undefined;
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
export type AppInstance<Api> = {
  /** The app surface `createApps` returns under the definition's id. */
  readonly api: Api;
  /** The enablement state machine the controller drives. */
  readonly provider: AppProvider;
  /** Runs on every unlock before `controller.init` — Hyperliquid refreshes its agents here. */
  readonly unlock?: () => Promise<void>;
  /** Runs on every lock before `controller.lock` — Hyperliquid resets its session marks here. */
  readonly lock?: () => void;
  /** Runs on destroy before `controller.lock` — Hyperliquid closes its shared socket here. */
  readonly close?: () => void;
};

/**
 * One app, declared: `createApps` calls `create` with the shared context and registers the instance
 * under `id` — a duplicate `id` throws.
 */
export type AppDefinition<Id extends AppId, Api> = {
  readonly id: Id;
  readonly create: (context: AppContext) => AppInstance<Api>;
};

/** The per-app api surface `createApps` returns next to the controller — keyed by app id. */
export type AppApis<A extends ReadonlyArray<AppDefinition<AppId, unknown>>> = {
  readonly [D in A[number] as D["id"]]: D extends AppDefinition<AppId, infer Api> ? Api : never;
};
