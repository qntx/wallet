/**
 * Polymarket's own group-state fields on top of the controller's base — the resumable enablement
 * step and the located venue account. `needs-migration` (the base `AppStatus` value a legacy Safe
 * resolves to) is documented here: the group must migrate its Safe outside the wallet before it can
 * be enabled, and reads stay scoped to it until then.
 */
import type { AppGroupState } from "../spi.ts";

/** The resumable enablement step a group is in; absent when `status` is terminal. */
export type PolymarketStep =
  | "locate-wallet"
  | "deploy-wallet"
  | "credentials"
  | "approvals"
  | "verify";

/** The located Polymarket account — positions/balance reads scope to `wallet`. */
export type PolymarketAccountState = {
  readonly wallet: string;
  /**
   * `safe` is a legacy Safe the wallet can only read: the group reconciles to `needs-migration`
   * until the user migrates it outside the wallet.
   */
  readonly kind: "deposit-wallet" | "safe";
  readonly deployed: boolean;
  readonly legacySafe?: string;
};

/** Polymarket's own group-state fields on top of the controller's base. */
export type PolymarketDetail = {
  /** The step an `enabling` flow is at — `verify` also marks a lost-POST re-check. */
  readonly step?: PolymarketStep;
  /** The located account the group enables or is enabled against. */
  readonly account?: PolymarketAccountState;
};

/** One wallet group's Polymarket app state. */
export type PolymarketGroupState = AppGroupState<PolymarketDetail>;
