/**
 * `@qntx/wallet-engine/apps` — the apps composition core the main engine entry never loads: a host
 * that enables app trading imports this entry next to `createWalletEngine`, so hosts that do not
 * pay nothing. Platform-neutral like the rest of src: every I/O dependency (fetch, timers, clock)
 * is injected.
 *
 * `createApps` builds the `AppsController` (enablement state, terms acknowledgement, lifecycle on
 * the wallet's lock state) over the app definitions the host lists — providers come from per-app
 * sub-entries, so a host bundles only the apps it uses.
 */
export { createApps } from "./controller.ts";
export type { AppsController, CreateAppsOptions } from "./controller.ts";
export type { AppSocket } from "./socket.ts";
export type {
  AppApis,
  AppContext,
  AppDefinition,
  AppDetail,
  AppError,
  AppFlow,
  AppGroup,
  AppGroupBase,
  AppGroupPatch,
  AppGroups,
  AppGroupState,
  AppId,
  AppInstance,
  AppNetworks,
  AppProvider,
  AppRequests,
  AppsEligibility,
  AppStates,
  AppsState,
  AppStatus,
  AppStorage,
} from "./types.ts";
