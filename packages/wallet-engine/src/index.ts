export { Controller } from "./controller.ts";
export type { ControllerOptions } from "./controller.ts";
export { createEventBus } from "./events.ts";
export type { EngineLogger, EventBus } from "./events.ts";
export { EngineStoreError } from "./errors.ts";
export type { EngineErrorCode } from "./errors.ts";
export type { EngineCollection, EngineStore, PublicStore } from "./store/port.ts";
export { createMemoryEngineStore, createMemoryPublicStore } from "./store/memory.ts";
export { ConnectionController } from "./connect/controller.ts";
export type {
  AccountGroup as ConnectionAccountGroup,
  ConnectionOrigin,
  ConnectionScope,
  ConnectionSession,
  ConnectionState,
  PendingConnection,
} from "./connect/controller.ts";
export { Eip1193Handler } from "./connect/eip1193.ts";
export type { Eip1193Event, Eip1193Request } from "./connect/eip1193.ts";
export { ProviderError } from "./connect/errors.ts";
export { AddressBookController } from "./addresses/controller.ts";
export type { AddressBookEntry, AddressBookState, AddressFamily } from "./addresses/controller.ts";
export { AddressBookError } from "./addresses/errors.ts";
export type { AddressBookErrorCategory } from "./addresses/errors.ts";
export { PhishingController, PHISHING_REFRESH_MS } from "./phishing/controller.ts";
export type { PhishingControllerOptions, PhishingState } from "./phishing/controller.ts";
export type { PhishingStatus } from "./phishing/status.ts";
export { RequestController, REQUEST_TTL_MS } from "./requests/controller.ts";
export type {
  BrowserOrigin,
  EvmSignInput,
  PayInput,
  PendingRequest,
  RequestCheckCode,
  RequestInput,
  RequestMethod,
  RequestControllerState,
  RequestOrigin,
  RequestStage,
  RiskFinding,
  SparkDepositInput,
  SparkExitInput,
  SignatureResult,
  SignLogEntry,
  SignLogOutcome,
} from "./requests/controller.ts";
export { createWalletEngine } from "./engine.ts";
export type { EngineOptions, WalletEngine } from "./engine.ts";
export { BackupController } from "./backup/controller.ts";
export type { BackupControllerState } from "./backup/controller.ts";
export { BackupControllerError } from "./backup/errors.ts";
export type { BackupErrorCategory } from "./backup/errors.ts";
export { createMemoryCloudStore } from "./backup/memory.ts";
export type { CloudStore } from "./backup/port.ts";
export { SparkController } from "./spark/controller.ts";
export type {
  SparkAccountState,
  SparkClientFactory,
  SparkControllerOptions,
  SparkControllerState,
} from "./spark/controller.ts";
export { SparkControllerError } from "./spark/errors.ts";
export { AccountTreeError } from "./accounts/errors.ts";
export { AccountTreeController } from "./accounts/controller.ts";
export type { AccountGroup, AccountTreeState } from "./accounts/controller.ts";
export { MetaSyncController } from "./meta/controller.ts";
export type {
  MetaSyncConfig,
  MetaSyncRelayPort,
  MetaSyncState,
  MetaSyncWalletStatus,
} from "./meta/controller.ts";
export { MetaSyncError } from "./meta/errors.ts";
export type { MetaDoc, MetaDocGroup, MetaDocTree, MetaDocWallet } from "./meta/doc.ts";
export { PaymentError } from "./payments/errors.ts";
export { parsePayment, resolvePayment } from "./payments/index.ts";
export type {
  PayParams,
  PreparedSparkAction,
  SparkDisplay,
  SparkResult,
  WithdrawLnurlParams,
} from "./payments/index.ts";
export type { PaymentOption, PaymentParse, PaymentRequest } from "./payments/parse.ts";
export type { SparkErrorCategory } from "./spark/errors.ts";
export { sparkStore } from "./spark/store.ts";
export type { PaymentNote, SparkActivity } from "./spark/notes.ts";
export { decodeExitChain, encodeExitChain } from "./spark/exit-chain-codec.ts";
export { prepareZap } from "./payments/zap.ts";
export type {
  PrepareZapContext,
  PrepareZapParams,
  PreparedZap,
  ZapRecipient,
} from "./payments/zap.ts";
