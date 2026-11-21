/**
 * The WalletConnect wallet entry: pairing and proposals live here, sessions are ordinary
 * `ConnectionController` sessions keyed `walletconnect:<topic>`, and every `session_request` runs
 * through the same dApp handlers and request pipeline the in-app browser uses. Hosts that never
 * pair pay nothing — this module is its own entry.
 */
export { createWalletConnect } from "./client.ts";
export type {
  WalletConnect,
  WalletConnectMetadata,
  WalletConnectOptions,
  WalletConnectProposal,
  WalletConnectState,
  WalletConnectStorage,
} from "./client.ts";
export { WalletConnectError } from "./errors.ts";
export type { WalletConnectErrorCode } from "./errors.ts";
export type { NamespaceRow, WalletConnectCall, WalletConnectEngine } from "./namespaces.ts";
