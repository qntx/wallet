/**
 * The route ↔ object boundary. `GatewayHttpError` cannot cross a Durable Object RPC as a class, so
 * the backend returns a discriminated result and the route rethrows it.
 */
import { PUSH_FAMILIES } from "@qntx/wallet-engine/gateway/contract";
import type {
  GatewayErrorCode,
  PushFamily,
  PushPlatform,
  PushSubscriptionRequest,
  PushSubscriptionResponse,
  PushTransactionRequest,
} from "@qntx/wallet-engine/gateway/contract";

import type { ErrorStatus } from "../middleware/errors.ts";
import type { RateLimiter } from "../types.ts";
import type { IngestItem, SubscribeRequest, WatchRequest } from "./core.ts";
import type { AlchemyHook } from "./watch-alchemy.ts";

export type PushResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: ErrorStatus; readonly code: GatewayErrorCode };

export type PushBackend = {
  readonly subscribe: (
    request: { readonly id: string } & PushSubscriptionRequest,
  ) => Promise<PushResult<PushSubscriptionResponse>>;
  readonly unsubscribe: (id: string) => Promise<PushResult<undefined>>;
  readonly watch: (
    request: { readonly id: string } & PushTransactionRequest,
  ) => Promise<PushResult<undefined>>;
  /** Webhook observations for the family's records — the hook route feeds it. */
  readonly ingest: (items: ReadonlyArray<IngestItem>) => Promise<PushResult<undefined>>;
};

/** Parses a `:family` route parameter; `undefined` when it is not a known family. */
export const pushFamilyOf = (value: string): PushFamily | undefined =>
  PUSH_FAMILIES.find((family) => family === value);

/** The `PushObject` RPC surface the routes need, family as the first argument. */
export type PushStub = {
  subscribe: (
    family: PushFamily,
    request: SubscribeRequest,
  ) => Promise<PushResult<PushSubscriptionResponse>>;
  unsubscribe: (family: PushFamily, id: string) => Promise<PushResult<undefined>>;
  watch: (family: PushFamily, request: WatchRequest) => Promise<PushResult<undefined>>;
  ingest: (
    family: PushFamily,
    observations: ReadonlyArray<IngestItem>,
  ) => Promise<PushResult<undefined>>;
};

/** The slice of `env.PUSH` the service uses — a namespace of per-family objects. */
export type PushObjectId = {
  toString: () => string;
  equals: (other: PushObjectId) => boolean;
};

export type PushNamespace = {
  idFromName: (name: string) => PushObjectId;
  get: (id: PushObjectId) => PushStub;
};

/** What `GET /v1/push` advertises and how the routes reach the family's Durable Object. */
export type PushService = {
  readonly platforms: ReadonlyArray<PushPlatform>;
  readonly families: ReadonlyArray<PushFamily>;
  readonly backend: (family: PushFamily) => PushBackend;
  /**
   * `webhookId` → hook, when the Alchemy watcher is configured — `/hooks/alchemy` authenticates
   * with it.
   */
  readonly alchemy?: ReadonlyMap<string, AlchemyHook>;
  /** The `PUSH_LIMITER` binding — per-IP writes on top of the shared request limiters. */
  readonly limiter: RateLimiter;
};
