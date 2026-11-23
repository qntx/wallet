/**
 * The Fiat24 provider error. `category` is the closed union the host branches on; `code` is the
 * SDK's own closed `Fiat24ErrorCode`, set only when the failure came out of `@qntx/fiat24`
 * (`category: "protocol"`) — the SDK's messages are fixed English templates, so they pass through
 * verbatim. No `cause` is ever attached: nothing an SDK error was built from — requests, results,
 * grants or signatures — may ride along.
 */
import { isFiat24Error } from "@qntx/fiat24/core";
import type { Fiat24ErrorCode } from "@qntx/fiat24/core";

/** Fiat24 provider error categories — never carry request payloads or secrets. */
export type Fiat24AppErrorCategory =
  /** The vault is locked — the group address cannot be resolved; nothing was read. */
  | "unlock-required"
  /** The group's app status is not `enabled`. */
  | "not-enabled"
  /** The call needs the group's owned live Fiat24 account and it has none. */
  | "no-account"
  /** No `api.fiat24.com` fetch was injected — API-backed features are off. */
  | "api-unavailable"
  /** An enablement flow is already running for the group — wait or cancel it. */
  | "busy"
  /** The jurisdiction allows only winding positions down — no new exposure. */
  | "close-only"
  /** A flow's transaction is still `sending`/`submitted`/`unknown` — no start or discard. */
  | "flow-unresolved"
  /** The flow id is neither persisted nor an in-memory draft. */
  | "unknown-flow"
  /** The read could not be completed (endpoint down, malformed answer) — a retry may succeed. */
  | "unavailable"
  /** A caller input fails validation before any request. */
  | "invalid-input"
  /**
   * The SDK reported the failure — `code` carries its closed `Fiat24ErrorCode` (`rpc-error`,
   * `invalid-rpc-response`, `contract-revert`, …); `contract-changed` is a state, not an error.
   */
  | "protocol";

export class Fiat24AppError extends Error {
  readonly category: Fiat24AppErrorCategory;
  /** The SDK's closed error code — set on `protocol` only. */
  readonly code?: Fiat24ErrorCode;

  constructor(
    category: Fiat24AppErrorCategory,
    message: string,
    options?: { readonly code?: Fiat24ErrorCode },
  ) {
    super(message);
    this.name = "Fiat24AppError";
    this.category = category;
    if (options?.code !== undefined) {
      this.code = options.code;
    }
  }
}

/**
 * One funnel for every failure out of the provider: `Fiat24AppError` passes through, an SDK
 * `Fiat24Error` becomes `protocol` with its code and fixed message, and anything else — a viem or
 * transport error whose message may embed URLs, params or results — collapses to a fixed
 * `unavailable`.
 */
export const fromSdk = (error: unknown): Fiat24AppError => {
  if (error instanceof Fiat24AppError) {
    return error;
  }
  if (isFiat24Error(error)) {
    return new Fiat24AppError("protocol", error.message, { code: error.code });
  }
  return new Fiat24AppError("unavailable", "the fiat24 chain read failed");
};
