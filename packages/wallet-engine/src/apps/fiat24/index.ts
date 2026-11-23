/**
 * `@qntx/wallet-engine/apps/fiat24` — the Fiat24 app: `fiat24()` returns the definition
 * `createApps` lists, and this entry carries the provider's surface (the group's Arbitrum One
 * account view over the cross-checked engine RPC with the SDK's pinned-deployment verification, the
 * resumable flows, the secured-read sessions and the public REST reads). A host that never imports
 * it bundles none of it.
 */
export { fiat24 } from "./app.ts";
export type { Fiat24App, Fiat24Config, Fiat24PublicReads } from "./app.ts";
export { Fiat24AppError } from "./errors.ts";
export type { Fiat24AppErrorCategory } from "./errors.ts";
export type { Fiat24AccountState } from "./account.ts";
export { FIAT24_POLL_MS } from "./live.ts";
export type { Fiat24LiveState, Fiat24LiveView } from "./live.ts";
export type { Fiat24Flow, Fiat24FlowEntry, Fiat24FlowInput, Fiat24Flows } from "./flows.ts";
export type { Fiat24Refusal } from "./signer.ts";
export type { Fiat24SecuredReads } from "./sessions.ts";
export type {
  AccountStatus,
  Currency,
  Fiat24ErrorCode,
  PayoutCurrency,
  Recipient,
} from "@qntx/fiat24/core";
export type { PayoutSettlement } from "@qntx/fiat24/chain";
export type {
  Bank,
  Banks,
  Card,
  Countries,
  CountryCities,
  KycStatus,
  PaymentPurpose,
  Profile,
  Rate,
  RatePair,
  TransactionPage,
  TransactionQuery,
} from "@qntx/fiat24/api";
export type {
  AccountView,
  CardCurrency,
  CardOperation,
  CardState,
  ExchangeState,
  FlowState,
  OnboardingState,
  PayoutDraft,
  PayoutState,
  PayoutTarget,
  TopUpState,
  TransferState,
  TxMismatch,
  TxPhase,
  TxRecord,
} from "@qntx/fiat24/flows";
