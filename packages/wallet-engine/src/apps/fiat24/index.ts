/**
 * `@qntx/wallet-engine/apps/fiat24` — the Fiat24 app: `fiat24()` returns the definition
 * `createApps` lists, and this entry carries the provider's surface (the group's Arbitrum One
 * account view over the cross-checked engine RPC with the SDK's pinned-deployment verification, a
 * 15 s live view while visible and unlocked, and the enabled-record enablement machine). A host
 * that never imports it bundles none of it.
 */
export { fiat24 } from "./app.ts";
export type { Fiat24App } from "./app.ts";
export { Fiat24AppError } from "./errors.ts";
export type { Fiat24AppErrorCategory } from "./errors.ts";
export type { Fiat24AccountState } from "./account.ts";
export { FIAT24_POLL_MS } from "./live.ts";
export type { Fiat24LiveState, Fiat24LiveView } from "./live.ts";
export type { AccountStatus, Fiat24ErrorCode } from "@qntx/fiat24";
export type { AccountView } from "@qntx/fiat24/flows";
