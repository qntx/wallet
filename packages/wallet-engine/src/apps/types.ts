/**
 * The app-enablement types the `AppsController` state and its per-app providers share — kept in
 * their own module so `apps/hyperliquid/enable.ts` and `apps/controller.ts` do not import each
 * other. See design.md §公开类型 / §启用状态机.
 */

/** The apps the controller knows; unimplemented ids are typed, never stubbed. */
export type AppId = "hyperliquid" | "polymarket";

/** The resumable enablement step a group is in; absent when `status` is terminal. */
export type AppStep = "create-agent" | "approve-agent" | "approve-builder" | "verify" | "revoke";

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
  readonly status: "disabled" | "enabling" | "enabled" | "needs-reauthorization";
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
  /** Set once `maxBuilderFee(owner, builder) >= f` was confirmed on Hyperliquid. */
  readonly builder?: "approved";
  /** The last failure — keeps `enabling`/`disabled` resumable. */
  readonly error?: AppError;
};

/** The controller's per-groups view: `"<walletId>/<groupIndex>"` → per-app group state. */
export type AppsState = {
  readonly locked: boolean;
  readonly groups: Record<string, Readonly<Partial<Record<AppId, AppGroupState>>>>;
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
};

/** A wallet group — identical to the trading path's `HyperliquidGroup`. */
export type AppGroup = {
  readonly walletId: string;
  readonly groupIndex: number;
};

/** What the controller asks a per-app provider for — Hyperliquid implements it today. */
export type AppProvider = {
  readonly id: AppId;
  /** Re-derive the group's app state from kernel agents and Hyperliquid reads. */
  readonly reconcile: (group: AppGroup, flow: AppFlow) => Promise<void>;
  /** Run or resume the enable flow to `enabled`, or leave a resumable `enabling`/error state. */
  readonly enable: (group: AppGroup, flow: AppFlow) => Promise<void>;
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
