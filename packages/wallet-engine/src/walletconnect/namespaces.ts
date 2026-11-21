import type { SessionTypes } from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";

import type { ConnectionScope } from "../connect/controller.ts";
import type { WalletEngine } from "../engine.ts";
import type { WalletConnectOrigin } from "../requests/types.ts";

/** What the entry needs from `createWalletEngine` — a `WalletEngine` satisfies it. */
export type WalletConnectEngine = {
  readonly connections: Pick<
    WalletEngine["connections"],
    | "getState"
    | "store"
    | "session"
    | "sessionAccounts"
    | "establishWalletConnect"
    | "revoke"
    | "invalidateOrigin"
    | "authorize"
    | "touch"
    | "isEnabled"
  >;
  readonly eip1193: Pick<WalletEngine["eip1193"], "handle">;
  readonly solanaWallet: Pick<WalletEngine["solanaWallet"], "handle">;
  readonly bitcoinWallet: Pick<WalletEngine["bitcoinWallet"], "handle">;
  readonly requests: Pick<WalletEngine["requests"], "prepare" | "outcome">;
  readonly phishing: Pick<WalletEngine["phishing"], "check">;
};

/** One `session_request` a namespace row translates into a provider call. */
export type WalletConnectCall = {
  /** The session's origin with THIS request's Verify verdict. */
  readonly origin: WalletConnectOrigin;
  /** The request's CAIP-2 chainId. */
  readonly network: string;
  /** The WalletConnect method. */
  readonly method: string;
  /** Untrusted params. */
  readonly params: unknown;
};

export type NamespaceRow = {
  readonly namespace: string;
  /** WalletConnect method → the scope methods the providers authorize for it. */
  readonly methods: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly events: ReadonlyArray<string>;
  /** Whether the providers can serve `network` (enabled-ness is checked separately). */
  readonly serves: (network: string) => boolean;
  /** The CAIP-10 accounts a scope advertises in the session namespace. */
  readonly accounts: (scope: ConnectionScope) => ReadonlyArray<string>;
  readonly dispatch: (call: WalletConnectCall, engine: WalletConnectEngine) => Promise<unknown>;
};

/** A namespace as a proposal asks for it — after `normalizeNamespaces` folded CAIP-2 keys. */
type RequestedNamespace = {
  readonly chains?: ReadonlyArray<string>;
  readonly methods: ReadonlyArray<string>;
  readonly events: ReadonlyArray<string>;
};

/** What a grant may carry for one namespace. */
export type OfferedNamespace = {
  /** Required chains first, then optional — unique, served, enabled. */
  readonly chains: ReadonlyArray<string>;
  /** The subset the proposal made required; a grant must keep them all. */
  readonly required: ReadonlyArray<string>;
  /** The WalletConnect methods and events the session advertises. */
  readonly methods: ReadonlyArray<string>;
  readonly events: ReadonlyArray<string>;
};

export type Offer =
  | {
      readonly ok: true;
      readonly namespaces: Readonly<Record<string, OfferedNamespace>>;
      /** Offered networks — required chains then optional, in request order. */
      readonly networks: ReadonlyArray<string>;
      /** The networks a grant must keep. */
      readonly required: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: { readonly code: number; readonly message: string } };

const unique = (items: ReadonlyArray<string>): string[] => [...new Set(items)];

/**
 * The namespaces the wallet can offer a proposal: every required namespace, chain, method and event
 * must be servable and enabled; optional entries that are not are dropped. `ok: false` carries the
 * `getSdkError` reason the peer is rejected with.
 */
export const offerNamespaces = (
  required: Readonly<Record<string, RequestedNamespace>>,
  optional: Readonly<Record<string, RequestedNamespace>>,
  rows: Readonly<Record<string, NamespaceRow>>,
  isEnabled: (network: string) => boolean,
): Offer => {
  const namespaces: Record<string, OfferedNamespace> = {};
  for (const [key, request] of Object.entries(required)) {
    const row = rows[key];
    if (row === undefined) {
      return { ok: false, error: getSdkError("UNSUPPORTED_NAMESPACE_KEY", key) };
    }
    const chains = [...(request.chains ?? [])];
    if (chains.length === 0 || !chains.every((chain) => row.serves(chain) && isEnabled(chain))) {
      return { ok: false, error: getSdkError("UNSUPPORTED_CHAINS") };
    }
    if (!request.methods.every((method) => row.methods[method] !== undefined)) {
      return { ok: false, error: getSdkError("UNSUPPORTED_METHODS") };
    }
    if (!request.events.every((event) => row.events.includes(event))) {
      return { ok: false, error: getSdkError("UNSUPPORTED_EVENTS") };
    }
    namespaces[key] = {
      chains,
      required: chains,
      methods: unique([...request.methods, ...(optional[key]?.methods ?? [])]).filter(
        (method) => row.methods[method] !== undefined,
      ),
      events: unique([...request.events, ...(optional[key]?.events ?? [])]).filter((event) =>
        row.events.includes(event),
      ),
    };
  }
  for (const [key, request] of Object.entries(optional)) {
    const row = rows[key];
    if (row === undefined) {
      continue;
    }
    const offered =
      namespaces[key] ??
      (namespaces[key] = {
        chains: [],
        required: [],
        methods: unique(request.methods).filter((method) => row.methods[method] !== undefined),
        events: unique(request.events).filter((event) => row.events.includes(event)),
      });
    const chains = [...offered.chains];
    for (const chain of request.chains ?? []) {
      if (!chains.includes(chain) && row.serves(chain) && isEnabled(chain)) {
        chains.push(chain);
      }
    }
    namespaces[key] = { ...offered, chains };
  }
  const granted = Object.values(namespaces);
  const networks = granted.flatMap((offered) => [...offered.chains]);
  if (networks.length === 0) {
    return { ok: false, error: getSdkError("UNSUPPORTED_CHAINS") };
  }
  return { ok: true, namespaces, networks, required: granted.flatMap((o) => o.required) };
};

/**
 * The session namespaces to advertise after the session's scopes changed: chains and accounts are
 * recomputed from the scopes (namespaces the WalletKit session lacks are never added), methods and
 * events keep what the session negotiated. `undefined` when a chain can no longer produce an
 * account — the session is unrecoverable and must be dropped.
 */
export const sessionNamespaces = (
  scopes: Readonly<Record<string, ConnectionScope>>,
  namespaces: Readonly<Record<string, SessionTypes.Namespace>>,
  rows: Readonly<Record<string, NamespaceRow>>,
): Record<string, SessionTypes.Namespace> | undefined => {
  const out: Record<string, SessionTypes.Namespace> = {};
  for (const [key, live] of Object.entries(namespaces)) {
    const row = rows[key];
    if (row === undefined) {
      out[key] = {
        ...live,
        accounts: [...live.accounts],
        methods: [...live.methods],
        events: [...live.events],
      };
      continue;
    }
    const chains = Object.keys(scopes).filter((network) => network.startsWith(`${key}:`));
    const accounts: string[] = [];
    for (const chain of chains) {
      const scope = scopes[chain];
      const bound = scope === undefined ? [] : row.accounts(scope);
      if (bound.length === 0) {
        return undefined;
      }
      accounts.push(...bound);
    }
    out[key] = { chains, accounts, methods: [...live.methods], events: [...live.events] };
  }
  return out;
};

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((item) => b.includes(item));

/** Order-insensitive comparison of the parts reconcile can change: chains and accounts. */
export const sameNamespaces = (
  a: Readonly<Record<string, SessionTypes.Namespace>>,
  b: Readonly<Record<string, SessionTypes.Namespace>>,
): boolean => {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (x === undefined || y === undefined) {
      return false;
    }
    if (!sameSet(x.chains ?? [], y.chains ?? []) || !sameSet(x.accounts, y.accounts)) {
      return false;
    }
  }
  return true;
};
