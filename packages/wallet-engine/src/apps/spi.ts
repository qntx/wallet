/**
 * The app provider SPI — the only engine module a provider under `src/apps/<app>/` may import
 * (check-boundaries rule `app-provider-spi`). Every runtime value it re-exports is also a public
 * export of `@qntx/wallet-engine` or `@qntx/wallet-engine/apps` (tests/apps-spi.test.ts), except
 * `createAppSocketCore`, which stays in-tree until the providers leave the package — exporting it
 * would grow the `/apps` core entry by ~0.5 kB gzip for code every provider bundle already
 * carries.
 */
export type {
  AppContext,
  AppDefinition,
  AppDetail,
  AppError,
  AppFlow,
  AppGroup,
  AppGroupPatch,
  AppGroupState,
  AppId,
  AppInstance,
  AppNetworks,
  AppProvider,
  AppRequests,
  AppStorage,
} from "./types.ts";
export { createAppSocketCore } from "./socket.ts";
export type { AppSocket, AppSocketCore, AppSocketStatus } from "./socket.ts";
export type { EvmFeeTier } from "../chains/evm.ts";
export { formatDecimal, parseDecimal } from "../decimal.ts";
export type { Decimal } from "../decimal.ts";
export { EngineStoreError } from "../errors.ts";
export type { EngineLogger } from "../events.ts";
export type { AppAvailability } from "../gateway/contract/eligibility.ts";
export { RequestEndedError } from "../requests/controller.ts";
export { readJson } from "../store/json.ts";
export type { SetTimer } from "../timer.ts";
export { timeoutSignal } from "../timer.ts";
export type { SignatureResult } from "../transactions/route.ts";
