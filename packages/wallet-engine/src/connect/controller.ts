/**
 * DApp connections (CAIP-25 style sessions): one session per origin, authorization by network,
 * account and method, persisted in the engine store and cleared from memory on lock. A connection
 * is approved from a pending queue, by id, like any other request; locking rejects all of it.
 */
import type { NostrKeyRef } from "@qntx/wallet";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { PhishingController } from "../phishing/controller.ts";
import { PHISHING_BLOCKED_MESSAGE } from "../phishing/status.ts";
import { dappUrl, isDappOrigin, walletConnectKey } from "../requests/types.ts";
import type { DappOrigin, WalletConnectOrigin } from "../requests/types.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import {
  internalError,
  invalidParams,
  requestPending,
  unauthorized,
  userRejectedRequest,
} from "./errors.ts";

export type ConnectionOrigin = DappOrigin;

export type ConnectionScope = {
  /** CAIP-10 */
  readonly accounts: ReadonlyArray<string>;
  readonly methods: ReadonlyArray<string>;
  readonly notifications: ReadonlyArray<string>;
};

export type ConnectionSession = {
  readonly id: string;
  readonly origin: ConnectionOrigin;
  /** Keyed by CAIP-2. */
  readonly scopes: Readonly<Record<string, ConnectionScope>>;
  /**
   * The group whose keys sign for every chain scope (`eip155:*`, `solana:*`, `bip122:*`) and
   * `lightning`; absent until such a scope is granted.
   */
  readonly group?: AccountGroup;
  /** The identity whose key signs for the `nostr` scope; present with a non-empty nostr scope. */
  readonly identity?: NostrKeyRef;
  /** The session's current EVM network; only dApp sessions have one. */
  readonly currentNetwork: string;
  /** The session's current TRON network; set when a `tron` namespace is granted. */
  readonly tronNetwork?: string;
  /** The origin's Nostr policy — set when the host approves a `nostr` connection. */
  readonly nostrPolicy?: NostrPolicy;
  /** The origin's Lightning policy — set when the host approves a `lightning` connection. */
  readonly lightningPolicy?: LightningPolicy;
  readonly createdAt: number;
  readonly lastUsedAt: number;
};

/**
 * How much a `nostr` session may do without per-call approval: `signing` is `"ask"` (every
 * `signEvent` goes through the pipeline), `"always"` (any kind signs directly), or a kind list (`{
 * kinds }` — only those kinds sign directly, the rest ask); `decrypt` gates `nip04/nip44 .decrypt`.
 * Kinds `0`, `3` and `5` and every replaceable, ephemeral or addressable event (10000–39999) always
 * ask regardless.
 */
export type NostrPolicy = {
  readonly signing: "ask" | "always" | { readonly kinds: ReadonlyArray<number> };
  readonly decrypt: boolean;
};

/**
 * How much a `lightning` session may do without per-call approval: `balance` gates `getBalance`
 * (WebLN). Sending and invoicing always go through their own approvals.
 */
export type LightningPolicy = {
  readonly balance: boolean;
};

/** `connect` asks for accounts; `network` asks to add a network the session does not cover. */
export type PendingConnection = {
  readonly id: string;
  readonly origin: ConnectionOrigin;
  readonly kind: "connect" | "network";
  /**
   * Which namespace the connection is for — `eip155` (EVM), `nostr` (NIP-07) or `lightning`
   * (WebLN).
   */
  readonly namespace: "eip155" | "nostr" | "lightning" | "solana" | "bip122" | "tron";
  readonly network?: string;
  /** `false` for a `network` request that adds the network without making it current. */
  readonly activate?: boolean;
  readonly createdAt: number;
};

/** What a connection request asks for; `namespace` defaults to `eip155`, `activate` to `true`. */
export type ConnectionRequest = {
  readonly kind: PendingConnection["kind"];
  readonly namespace?: PendingConnection["namespace"];
  readonly network?: string;
  readonly activate?: boolean;
};

/** Pending connection requests held at once; a further request is refused. */
export const MAX_PENDING_CONNECTIONS = 64;

/** A pending connection request that nobody answers is rejected after this long. */
export const CONNECTION_REQUEST_TTL_MS = 10 * 60 * 1000;

export type AccountGroup = { readonly walletId: string; readonly groupIndex: number };

export type ConnectionState = {
  readonly sessions: Readonly<Record<string, ConnectionSession>>;
  readonly pending: Readonly<Record<string, PendingConnection>>;
  /** Whether the session store is open and loaded. */
  readonly ready: boolean;
};

export type ConnectionControllerOptions = {
  /** The session EngineStore — the engine opens it once per unlock and closes it on lock. */
  readonly openStore: () => Promise<EngineStore>;
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
  readonly logger: EngineLogger;
  /** Development builds also accept `http://localhost`. */
  readonly allowLocalhost: boolean;
  /** The group the app currently shows; sessions are bound to it. */
  readonly selectedGroup: () => AccountGroup | undefined;
  /** The group's EVM address on `network`. */
  readonly evmAddress: (group: AccountGroup, network: string) => Promise<string>;
  /** The group's Solana address on `network` (a CAIP-2 `solana:<genesis>` chain). */
  readonly solanaAddress: (group: AccountGroup, network: string) => Promise<string>;
  /** The group's TRON address (base58) on `network` (a `tron:<chain>` CAIP-2 chain). */
  readonly tronAddress: (group: AccountGroup, network: string) => Promise<string>;
  /** The group's fixed dApp-facing Bitcoin address of `purpose` on `network` (`bip122:<genesis>`). */
  readonly bitcoinAddress: (
    group: AccountGroup,
    network: string,
    purpose: BitcoinPurpose,
  ) => Promise<string>;
  readonly enabledNetworks: () => ReadonlyArray<string>;
  /** A Nostr identity's public key — `nostr(wallet).signer(ref).getPublicKey()`. */
  readonly nostrPubkey: (ref: NostrKeyRef) => Promise<string>;
  /** Voids a page's unfinished requests (revoked, or its network changed). */
  readonly invalidate: (origin: string) => void;
  /** Called when the app's group selection changes; returns an unsubscribe. */
  readonly onSelectedGroup: (listener: () => void) => () => void;
  /**
   * Voids every unfinished request — locking, unlocking and switching account group void every
   * unfinished request (requests.mdx invariant 1).
   */
  readonly invalidateAll: () => void;
  readonly phishing: Pick<PhishingController, "check">;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
};

const COLLECTION = "connections";

/** Sessions unused for this long are dropped when the vault unlocks. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** `lastUsedAt` is rewritten at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

/** Granted for every network a session covers. */
export const SESSION_METHODS: ReadonlyArray<string> = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
  "wallet_watchAsset",
  "wallet_getCapabilities",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
];
export const SESSION_NOTIFICATIONS: ReadonlyArray<string> = ["accountsChanged", "chainChanged"];
/** The `nostr` namespace scope's granted methods — the NIP-07 surface. */
export const NOSTR_METHODS: ReadonlyArray<string> = [
  "getPublicKey",
  "signEvent",
  "nip04.encrypt",
  "nip04.decrypt",
  "nip44.encrypt",
  "nip44.decrypt",
];

/** The `lightning` namespace scope's granted methods — the WebLN surface. */
export const LIGHTNING_METHODS: ReadonlyArray<string> = [
  "enable",
  "getInfo",
  "sendPayment",
  "makeInvoice",
  "lnurl",
  "getBalance",
];

/** The `solana` namespace scope's granted methods — the Wallet Standard surface. */
export const SOLANA_METHODS: ReadonlyArray<string> = [
  "standard:connect",
  "standard:disconnect",
  "standard:events",
  "solana:signTransaction",
  "solana:signAndSendTransaction",
  "solana:signMessage",
  "solana:signIn",
];

/** The `bip122` namespace scope's granted methods — the Bitcoin Wallet Standard surface. */
export const BITCOIN_METHODS: ReadonlyArray<string> = [
  "bitcoin:connect",
  "standard:disconnect",
  "bitcoin:events",
  "bitcoin:signMessage",
  "bitcoin:signTransaction",
  "bitcoin:signAndSendTransaction",
];

/** `payment` is the group's `btc.bip84` address, `ordinals` its `btc.bip86` one. */
export type BitcoinPurpose = "payment" | "ordinals";

/** The `tron` namespace scope's granted methods — the TronLink surface. */
export const TRON_METHODS: ReadonlyArray<string> = [
  "eth_requestAccounts",
  "tron_requestAccounts",
  "wallet_switchEthereumChain",
  "wallet_watchAsset",
  "tron_signTransaction",
  "tron_sendRawTransaction",
  "tron_signMessageV2",
  "tron_signTypedData",
];

/** The `tron` namespace scope's notifications. */
export const TRON_NOTIFICATIONS: ReadonlyArray<string> = ["accountsChanged", "chainChanged"];

/** The order of a `bip122` scope's two accounts. */
export const BITCOIN_PURPOSES: ReadonlyArray<BitcoinPurpose> = ["payment", "ordinals"];

/** `eip155:1` → 1; `undefined` for anything that is not an EVM network. */
export const evmChainId = (network: string): number | undefined => {
  const match = /^eip155:(\d+)$/.exec(network);
  const id = match?.[1] === undefined ? undefined : Number(match[1]);
  return id !== undefined && Number.isSafeInteger(id) ? id : undefined;
};

const caip10 = (network: string, address: string): string => `${network}:${address}`;

const addressOf = (account: string): string => account.slice(account.lastIndexOf(":") + 1);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isGroup = (value: unknown): value is AccountGroup =>
  isObject(value) &&
  typeof value["walletId"] === "string" &&
  typeof value["groupIndex"] === "number" &&
  Number.isSafeInteger(value["groupIndex"]) &&
  value["groupIndex"] >= 0;

const isIdentity = (value: unknown): value is NostrKeyRef =>
  isObject(value) &&
  value["kind"] === "derived" &&
  typeof value["walletId"] === "string" &&
  typeof value["index"] === "number" &&
  Number.isSafeInteger(value["index"]) &&
  value["index"] >= 0;

export const isSession = (value: unknown): value is ConnectionSession => {
  if (!isObject(value) || !isObject(value["scopes"])) {
    return false;
  }
  const { origin } = value;
  return (
    typeof value["id"] === "string" &&
    isDappOrigin(origin) &&
    (origin.kind !== "walletconnect" || origin.origin === walletConnectKey(origin.topic)) &&
    typeof value["currentNetwork"] === "string" &&
    (value["tronNetwork"] === undefined || typeof value["tronNetwork"] === "string") &&
    typeof value["createdAt"] === "number" &&
    typeof value["lastUsedAt"] === "number" &&
    (value["group"] === undefined || isGroup(value["group"])) &&
    (value["identity"] === undefined || isIdentity(value["identity"])) &&
    (value["nostrPolicy"] === undefined || isNostrPolicy(value["nostrPolicy"])) &&
    (value["lightningPolicy"] === undefined || isLightningPolicy(value["lightningPolicy"]))
  );
};

const isLightningPolicy = (value: unknown): value is LightningPolicy =>
  isObject(value) && typeof value["balance"] === "boolean";

const isNostrPolicy = (value: unknown): value is NostrPolicy =>
  isObject(value) &&
  typeof value["decrypt"] === "boolean" &&
  (value["signing"] === "ask" ||
    value["signing"] === "always" ||
    (isObject(value["signing"]) &&
      Array.isArray(value["signing"]["kinds"]) &&
      (value["signing"]["kinds"] as unknown[]).every((k) => typeof k === "number")));

/**
 * What a session authorized on one network: the addresses the page may see and the group whose keys
 * sign for them.
 */
export type SessionAccounts = {
  readonly group: AccountGroup;
  readonly addresses: ReadonlyArray<string>;
};

/** `undefined` unless the session covers `network` with at least one account and has a group. */
export const sessionAccounts = (
  session: ConnectionSession | undefined,
  network: string,
): SessionAccounts | undefined => {
  const scope = session?.scopes[network];
  if (session?.group === undefined || scope === undefined || scope.accounts.length === 0) {
    return undefined;
  }
  return { group: session.group, addresses: scope.accounts.map(addressOf) };
};

/** The identity and pubkey a session bound to its `nostr` scope; `undefined` when it has neither. */
export const sessionIdentity = (
  session: ConnectionSession | undefined,
): { readonly ref: NostrKeyRef; readonly pubkey: string } | undefined => {
  const account = session?.scopes["nostr"]?.accounts[0];
  if (session?.identity === undefined || account === undefined) {
    return undefined;
  }
  return { ref: session.identity, pubkey: addressOf(account) };
};

const sameGroup = (a: AccountGroup | undefined, b: AccountGroup | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.walletId === b.walletId && a.groupIndex === b.groupIndex;

/** A scope a group signs for — chain networks and `lightning`; `nostr` belongs to the identity. */
const isChainScope = (network: string): boolean =>
  network === "lightning" ||
  network.startsWith("eip155:") ||
  network.startsWith("solana:") ||
  network.startsWith("bip122:") ||
  network.startsWith("tron:");

type Waiter = {
  readonly resolve: (session: ConnectionSession) => void;
  readonly reject: (error: Error) => void;
};

export class ConnectionController extends Controller<ConnectionState> {
  private readonly options: ConnectionControllerOptions;
  private engineStore: EngineStore | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly expiries = new Map<string, () => void>();
  private identity: NostrKeyRef | undefined;
  private unsubscribeSelection: (() => void) | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ConnectionControllerOptions) {
    super({
      name: "connections",
      defaultState: () => ({ sessions: {}, pending: {}, ready: false }),
    });
    this.options = options;
  }

  async init(): Promise<void> {
    const store = await this.options.openStore();
    this.engineStore = store;
    this.identity = undefined;
    const collection = store.collection(COLLECTION);
    const keys = await collection.list();
    const rows = await Promise.all(keys.map(async (key) => collection.get(key)));
    const now = this.options.now();
    const sessions: Record<string, ConnectionSession> = {};
    const expired: string[] = [];
    for (const [index, raw] of rows.entries()) {
      const key = keys[index];
      if (raw === undefined || key === undefined) {
        continue;
      }
      const parsed = readJson(raw);
      if (!isSession(parsed)) {
        this.options.logger.warn("connection session skipped: malformed");
        expired.push(key);
      } else if (now - parsed.lastUsedAt > SESSION_TTL_MS) {
        expired.push(key);
      } else {
        sessions[parsed.id] = parsed;
      }
    }
    await Promise.all(expired.map(async (key) => collection.delete(key)));
    this.update(() => ({ sessions, pending: {}, ready: true }));
    this.unsubscribeSelection = this.options.onSelectedGroup(() => {
      this.options.invalidateAll();
      void this.repointQueued();
    });
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Locking is not consent: every pending connection is rejected. */
  lock(): void {
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = undefined;
    this.engineStore = undefined;
    for (const waiter of this.waiters.values()) {
      waiter.reject(userRejectedRequest("the wallet was locked"));
    }
    this.waiters.clear();
    for (const cancel of this.expiries.values()) {
      cancel();
    }
    this.expiries.clear();
    this.update(() => ({ sessions: {}, pending: {}, ready: false }));
  }

  /**
   * A page navigated away (or the bridge is being disposed): the origin's pending connection
   * requests are rejected and its unfinished pipeline requests voided — the live session survives
   * (a refresh is not a revocation).
   */
  invalidateOrigin(origin: string): void {
    for (const entry of this.pending()) {
      if (entry.origin.origin !== origin) {
        continue;
      }
      this.waiters.get(entry.id)?.reject(userRejectedRequest("the page navigated away"));
      this.dropPending(entry.id);
    }
    this.options.invalidate(origin);
  }

  /**
   * Throws `4100` unless `origin` is `https://host[:port]` (or localhost in development) and not on
   * the phishing list. A WalletConnect peer instead passes its origin object: an established
   * session must carry the same session key and topic, and its unverified peer URL must not be on
   * the phishing list.
   */
  checkOrigin(origin: string | WalletConnectOrigin): ConnectionOrigin {
    if (typeof origin !== "string") {
      const session = Object.values(this.getState().sessions).find(
        (s) =>
          s.origin.kind === "walletconnect" &&
          s.origin.origin === origin.origin &&
          s.origin.topic === origin.topic,
      );
      if (session === undefined) {
        throw unauthorized();
      }
      if (this.options.phishing.check(origin.url) === "blocked") {
        throw unauthorized(PHISHING_BLOCKED_MESSAGE);
      }
      return origin;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw unauthorized("invalid origin");
    }
    const localhost = url.protocol === "http:" && url.hostname === "localhost";
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" && !(localhost && this.options.allowLocalhost))
    ) {
      throw unauthorized("origin not allowed");
    }
    if (this.options.phishing.check(origin) === "blocked") {
      throw unauthorized(PHISHING_BLOCKED_MESSAGE);
    }
    return { kind: "browser", origin };
  }

  session(origin: string): ConnectionSession | undefined {
    return Object.values(this.getState().sessions).find((s) => s.origin.origin === origin);
  }

  pending(): ReadonlyArray<PendingConnection> {
    return Object.values(this.getState().pending);
  }

  /** What the origin's session authorized on `network` — `undefined` when nothing. */
  sessionAccounts(origin: string, network: string): SessionAccounts | undefined {
    return sessionAccounts(this.session(origin), network);
  }

  /**
   * The selected group's accounts on `network` as a grant would bind them — a preview for callers
   * that sign before a session exists; nothing is persisted. `undefined` when no group is selected
   * or the account cannot be derived.
   */
  async previewAccounts(network: string): Promise<SessionAccounts | undefined> {
    const group = this.options.selectedGroup();
    if (group === undefined) {
      return undefined;
    }
    const bound = await this.repointScopes(
      { [network]: { accounts: [], methods: [], notifications: [] } },
      group,
    );
    const scope = bound[network];
    if (scope === undefined || scope.accounts.length === 0) {
      return undefined;
    }
    return { group, addresses: scope.accounts.map(addressOf) };
  }

  /** The identity the origin's `nostr` scope is bound to, with the pubkey the page sees. */
  nostrIdentity(
    origin: string,
  ): { readonly ref: NostrKeyRef; readonly pubkey: string } | undefined {
    return sessionIdentity(this.session(origin));
  }

  /** Whether `network` is an EVM network the wallet has enabled. */
  isEnabled(network: string): boolean {
    return this.options.enabledNetworks().includes(network);
  }

  /** Throws `4100` unless the origin's session covers `method` on `network`. */
  authorize(origin: string, network: string, method: string): ConnectionSession {
    const session = this.session(origin);
    const scope = session?.scopes[network];
    if (session === undefined || scope === undefined || !scope.methods.includes(method)) {
      throw unauthorized();
    }
    return session;
  }

  /** Resolves with the session once the host approves; rejects with `4001` when it refuses. */
  async request(
    origin: string,
    { kind, namespace = "eip155", network, activate = true }: ConnectionRequest,
  ): Promise<ConnectionSession> {
    const store = this.engineStore;
    if (store === undefined) {
      throw userRejectedRequest("the wallet is locked");
    }
    if (this.pending().some((p) => p.origin.origin === origin)) {
      throw requestPending("a connection request is already pending");
    }
    if (this.pending().length >= MAX_PENDING_CONNECTIONS) {
      throw requestPending("too many pending connection requests");
    }
    const id = `conn-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const entry: PendingConnection = {
      id,
      origin: this.session(origin)?.origin ?? { kind: "browser", origin },
      kind,
      namespace,
      ...(network === undefined ? {} : { network }),
      ...(activate ? {} : { activate }),
      createdAt: this.options.now(),
    };
    return new Promise<ConnectionSession>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.expiries.set(
        id,
        this.options.setTimer(CONNECTION_REQUEST_TTL_MS, () => {
          this.waiters.get(id)?.reject(userRejectedRequest("the connection request expired"));
          this.dropPending(id);
        }),
      );
      this.update((s) => ({ ...s, pending: { ...s.pending, [id]: entry } }));
    });
  }

  /**
   * The host's approval, by id: the accounts granted (of the app's selected group for a
   * chain/lightning grant, of the active identity for `nostr`) and the network. The whole
   * derivation, merge and persist runs inside the session write queue, so a concurrent group switch
   * cannot interleave.
   */
  async approveConnection(
    id: string,
    grant: {
      readonly accounts: ReadonlyArray<string>;
      readonly network: string;
      /** The `nostr` namespace's grant: the identity's pubkey and the origin's policy. */
      readonly nostr?: { readonly pubkey: string; readonly policy: NostrPolicy };
      /** The `lightning` namespace's grant: the origin's policy. */
      readonly lightning?: { readonly policy: LightningPolicy };
    },
  ): Promise<ConnectionSession> {
    const entry = this.getState().pending[id];
    const waiter = this.waiters.get(id);
    if (entry === undefined || waiter === undefined) {
      throw new Error(`unknown connection request ${id}`);
    }
    if (this.options.phishing.check(dappUrl(entry.origin)) === "blocked") {
      const blocked = unauthorized(PHISHING_BLOCKED_MESSAGE);
      this.dropPending(id);
      waiter.reject(blocked);
      throw blocked;
    }
    if (entry.kind === "network" && entry.network !== grant.network) {
      throw new Error(`connection request ${id} is for ${String(entry.network)}`);
    }
    return this.serial(async () => {
      const store = this.requireStore();
      const { scopes, group, identity, tronNetwork } = await this.grantScopes(entry, grant);
      if (this.getState().pending[id] === undefined) {
        throw new Error(`connection request ${id} is no longer pending`);
      }
      const now = this.options.now();
      const existing = this.session(entry.origin.origin);
      /*
       * A grant binds to the current group: merging into a session bound to another re-points the
       * existing chain/lightning scopes in the same write — a session never mixes groups.
       */
      const repointed =
        group !== undefined && existing !== undefined && !sameGroup(existing.group, group);
      const merged = repointed
        ? await this.repointScopes(existing.scopes, group)
        : { ...existing?.scopes };
      const sessionGroup = group ?? existing?.group;
      const sessionIdentity = identity ?? existing?.identity;
      const sessionTronNetwork = tronNetwork ?? existing?.tronNetwork;
      /* A later grant (e.g. an added network) keeps the policies an earlier grant set. */
      const nostrPolicy = grant.nostr?.policy ?? existing?.nostrPolicy;
      const lightningPolicy = grant.lightning?.policy ?? existing?.lightningPolicy;
      const session: ConnectionSession = {
        id: existing?.id ?? this.newSessionId(),
        origin: entry.origin,
        scopes: { ...merged, ...scopes },
        currentNetwork:
          entry.activate === false && existing !== undefined
            ? existing.currentNetwork
            : grant.network,
        ...(sessionGroup === undefined ? {} : { group: sessionGroup }),
        ...(sessionIdentity === undefined ? {} : { identity: sessionIdentity }),
        ...(sessionTronNetwork === undefined ? {} : { tronNetwork: sessionTronNetwork }),
        ...(nostrPolicy === undefined ? {} : { nostrPolicy }),
        ...(lightningPolicy === undefined ? {} : { lightningPolicy }),
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
      };
      await this.persist(store, session);
      this.dropPending(id);
      if (
        repointed ||
        (existing !== undefined && existing.currentNetwork !== session.currentNetwork)
      ) {
        this.options.invalidate(entry.origin.origin);
      }
      waiter.resolve(session);
      return session;
    });
  }

  rejectConnection(id: string): void {
    const waiter = this.waiters.get(id);
    if (this.getState().pending[id] === undefined || waiter === undefined) {
      throw new Error(`unknown connection request ${id}`);
    }
    this.dropPending(id);
    waiter.reject(userRejectedRequest());
  }

  /**
   * Establishes a WalletConnect peer's session inside the session write queue: each network's scope
   * is bound to the selected group's accounts, `settle` receives the bound scopes and settles the
   * peer on the relay, returning its origin, and the session is persisted under that origin — a
   * group switch cannot interleave between the accounts the peer is given and the ones recorded.
   * Nothing is persisted when `settle` throws.
   */
  async establishWalletConnect(
    scopes: Readonly<Record<string, Omit<ConnectionScope, "accounts">>>,
    settle: (scopes: Readonly<Record<string, ConnectionScope>>) => Promise<WalletConnectOrigin>,
  ): Promise<ConnectionSession> {
    return this.serial(async () => {
      const store = this.requireStore();
      const group = this.options.selectedGroup();
      if (group === undefined) {
        throw userRejectedRequest("no account group is selected");
      }
      const enabled = this.options.enabledNetworks();
      const boundable = (network: string): boolean =>
        (network.startsWith("eip155:") ||
          network.startsWith("solana:") ||
          network.startsWith("bip122:")) &&
        enabled.includes(network);
      const requested = Object.keys(scopes);
      const [first] = requested;
      if (first === undefined || !requested.every(boundable)) {
        throw invalidParams("every scope must name an enabled eip155, solana or bip122 network");
      }
      const bound = await this.repointScopes(
        Object.fromEntries(
          Object.entries(scopes).map(([network, scope]) => [network, { ...scope, accounts: [] }]),
        ),
        group,
      );
      if (Object.values(bound).some((scope) => scope.accounts.length === 0)) {
        throw internalError("an account could not be derived for a granted network");
      }
      const origin = await settle(bound);
      const existing = this.session(origin.origin);
      const now = this.options.now();
      const session: ConnectionSession = {
        id: existing?.id ?? this.newSessionId(),
        origin,
        scopes: bound,
        group,
        currentNetwork: requested.find((network) => network.startsWith("eip155:")) ?? first,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
      };
      await this.persist(store, session);
      return session;
    });
  }

  /** Ends the origin's session; its pending connection and unfinished requests are void. */
  async revoke(origin: string): Promise<void> {
    await this.serial(async () => {
      const store = this.requireStore();
      for (const p of this.pending().filter((x) => x.origin.origin === origin)) {
        const waiter = this.waiters.get(p.id);
        this.dropPending(p.id);
        waiter?.reject(userRejectedRequest("the connection was revoked"));
      }
      const session = this.session(origin);
      if (session !== undefined) {
        await store.collection(COLLECTION).delete(session.id);
        this.update((s) => {
          const { [session.id]: _gone, ...sessions } = s.sessions;
          return { ...s, sessions };
        });
      }
      this.options.invalidate(origin);
    });
  }

  /** Switches within the session's scope; the origin's unfinished requests are void. */
  async setCurrentNetwork(origin: string, network: string): Promise<void> {
    await this.serial(async () => {
      const store = this.requireStore();
      const session = this.session(origin);
      if (session === undefined || session.scopes[network] === undefined) {
        throw unauthorized();
      }
      await this.persist(store, { ...session, currentNetwork: network });
      this.options.invalidate(origin);
    });
  }

  /** Switches the session's TRON network; the origin's unfinished requests are void. */
  async setTronNetwork(origin: string, network: string): Promise<void> {
    await this.serial(async () => {
      const store = this.requireStore();
      const session = this.session(origin);
      if (session === undefined || session.scopes[network] === undefined) {
        throw unauthorized();
      }
      await this.persist(store, { ...session, tronNetwork: network });
      this.options.invalidate(origin);
    });
  }

  async touch(origin: string): Promise<void> {
    await this.serial(async () => {
      const store = this.engineStore;
      const session = this.session(origin);
      const now = this.options.now();
      if (
        store === undefined ||
        session === undefined ||
        now - session.lastUsedAt < TOUCH_INTERVAL_MS
      ) {
        return;
      }
      await this.persist(store, { ...session, lastUsedAt: now });
    });
  }

  /** The active Nostr identity — `undefined` until the host picks one. */
  activeIdentity(): NostrKeyRef | undefined {
    return this.identity;
  }

  /** The origin's persisted Nostr policy — `undefined` until it is nostr-authorized. */
  nostrPolicy(origin: string): NostrPolicy | undefined {
    return this.session(origin)?.nostrPolicy;
  }

  /** The origin's persisted Lightning policy — `undefined` until it is lightning-authorized. */
  lightningPolicy(origin: string): LightningPolicy | undefined {
    return this.session(origin)?.lightningPolicy;
  }

  private async bitcoinScope(group: AccountGroup, network: string): Promise<ConnectionScope> {
    const addresses = await Promise.all(
      BITCOIN_PURPOSES.map(async (purpose) => this.options.bitcoinAddress(group, network, purpose)),
    );
    return {
      accounts: addresses.map((address) => caip10(network, address)),
      methods: BITCOIN_METHODS,
      notifications: ["change"],
    };
  }

  /**
   * The host's Nostr identity selection: the pubkey is derived first, then every session with a
   * non-empty `nostr` scope is re-pointed — `identity` and the scope's account written together —
   * and the origin's unfinished requests voided. No event — NIP-07 has none.
   */
  async setActiveIdentity(ref: NostrKeyRef | undefined): Promise<void> {
    await this.serial(async () => {
      const store = this.requireStore();
      let pubkey: string | undefined;
      if (ref !== undefined) {
        const raw = await this.options.nostrPubkey(ref);
        pubkey = raw.toLowerCase();
      }
      this.identity = ref;
      for (const session of Object.values(this.getState().sessions)) {
        const scope = session.scopes["nostr"];
        if (scope === undefined || scope.accounts.length === 0) {
          continue;
        }
        const { identity: _gone, ...rest } = session;
        // oxlint-disable-next-line eslint/no-await-in-loop -- session writes are serialized.
        await this.persist(store, {
          ...rest,
          scopes: {
            ...session.scopes,
            nostr: {
              ...scope,
              accounts: pubkey === undefined ? [] : [`nostr:${pubkey}`],
            },
          },
          ...(ref === undefined ? {} : { identity: ref }),
        });
        this.options.invalidate(session.origin.origin);
      }
    });
  }

  /**
   * Every session write — a re-point, a grant's merge and persist, a revoke, a network switch, a
   * touch — queues here so one writer runs at a time and reads the latest session at its turn. A
   * failed task does not break the chain.
   */
  private async serial<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: (() => void) | undefined;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release?.();
    }
  }

  private async repointQueued(): Promise<void> {
    try {
      await this.serial(async () => this.repoint());
    } catch (error: unknown) {
      this.options.logger.warn("connection re-point failed", error);
    }
  }

  /**
   * Re-binds every session's chain/lightning scopes to the app's current group selection: each
   * scope's accounts become the target's (empty when the selection is cleared or a derivation
   * fails), `group` written together with them. The origin's unfinished requests are voided.
   */
  private async repoint(): Promise<void> {
    const store = this.requireStore();
    const target = this.options.selectedGroup();
    for (const session of Object.values(this.getState().sessions)) {
      if (!Object.keys(session.scopes).some(isChainScope) || sameGroup(session.group, target)) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- session writes are serialized.
      const scopes = await this.repointScopes(session.scopes, target);
      const { group: _gone, ...rest } = session;
      // oxlint-disable-next-line eslint/no-await-in-loop -- session writes are serialized.
      await this.persist(store, {
        ...rest,
        scopes,
        ...(target === undefined ? {} : { group: target }),
      });
      this.options.invalidate(session.origin.origin);
    }
  }

  /**
   * A session's scopes re-computed for `target`: EVM and Solana scope accounts are the group's
   * address, `bip122` its two purpose addresses, `lightning` its `spark:` ref; `nostr` is the
   * identity's and passes through. `target` undefined or a failed derivation → empty accounts.
   */
  private async repointScopes(
    scopes: Readonly<Record<string, ConnectionScope>>,
    target: AccountGroup | undefined,
  ): Promise<Record<string, ConnectionScope>> {
    const entries = await Promise.all(
      Object.entries(scopes).map(async ([network, scope]): Promise<[string, ConnectionScope]> => {
        if (network === "nostr") {
          return [network, scope];
        }
        if (target === undefined) {
          return [network, { ...scope, accounts: [] }];
        }
        try {
          if (network === "lightning") {
            return [
              network,
              { ...scope, accounts: [`spark:${target.walletId}:${String(target.groupIndex)}`] },
            ];
          }
          if (network.startsWith("bip122:")) {
            const bound = await this.bitcoinScope(target, network);
            return [network, { ...scope, accounts: bound.accounts }];
          }
          if (network.startsWith("solana:")) {
            const address = await this.options.solanaAddress(target, network);
            return [network, { ...scope, accounts: [caip10(network, address)] }];
          }
          if (network.startsWith("tron:")) {
            const address = await this.options.tronAddress(target, network);
            return [network, { ...scope, accounts: [caip10(network, address)] }];
          }
          if (network.startsWith("eip155:")) {
            const address = await this.options.evmAddress(target, network);
            return [network, { ...scope, accounts: [caip10(network, address.toLowerCase())] }];
          }
          return [network, scope];
        } catch (error) {
          this.options.logger.warn("connection account unavailable in the new group", error);
          return [network, { ...scope, accounts: [] }];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  /**
   * The scopes a grant produces, bound to the app's selected group (chain/lightning namespaces) or
   * the active identity (`nostr`) — read at write-queue turn, not request time.
   */
  private async grantScopes(
    entry: PendingConnection,
    grant: Parameters<ConnectionController["approveConnection"]>[1],
  ): Promise<{
    readonly scopes: Record<string, ConnectionScope>;
    readonly group?: AccountGroup;
    readonly identity?: NostrKeyRef;
    readonly tronNetwork?: string;
  }> {
    const scopes: Record<string, ConnectionScope> = {};
    if (entry.namespace === "nostr") {
      if (grant.nostr === undefined) {
        throw invalidParams("a nostr connection needs the identity's pubkey and policy");
      }
      const identity = this.activeIdentity();
      if (identity === undefined) {
        throw userRejectedRequest("no nostr identity is selected");
      }
      const identityRaw = await this.options.nostrPubkey(identity);
      const identityPubkey = identityRaw.toLowerCase();
      if (grant.nostr.pubkey.toLowerCase() !== identityPubkey) {
        throw invalidParams("only the active identity can be granted");
      }
      scopes["nostr"] = {
        accounts: [`nostr:${identityPubkey}`],
        methods: NOSTR_METHODS,
        notifications: [],
      };
      return { scopes, identity };
    }
    if (entry.namespace === "lightning") {
      if (grant.lightning === undefined) {
        throw invalidParams("a lightning connection needs the origin's policy");
      }
      const group = this.options.selectedGroup();
      if (group === undefined) {
        throw new Error("no account group is selected");
      }
      scopes["lightning"] = {
        accounts: [`spark:${group.walletId}:${String(group.groupIndex)}`],
        methods: LIGHTNING_METHODS,
        notifications: [],
      };
      return { scopes, group };
    }
    const group = this.options.selectedGroup();
    if (group === undefined) {
      throw new Error("no account group is selected");
    }
    if (entry.namespace === "solana") {
      const solanaNetworks = this.options.enabledNetworks().filter((n) => n.startsWith("solana:"));
      const solanaEntries = await Promise.all(
        solanaNetworks.map(async (network): Promise<[string, ConnectionScope]> => {
          const address = await this.options.solanaAddress(group, network);
          return [
            network,
            {
              accounts: [caip10(network, address)],
              methods: SOLANA_METHODS,
              notifications: ["change"],
            },
          ];
        }),
      );
      Object.assign(scopes, Object.fromEntries(solanaEntries));
      return { scopes, group };
    }
    if (entry.namespace === "tron") {
      const tronNetworks = this.options.enabledNetworks().filter((n) => n.startsWith("tron:"));
      if (!tronNetworks.includes(grant.network)) {
        throw invalidParams(`${grant.network} is not an enabled TRON network`);
      }
      const tronEntries = await Promise.all(
        tronNetworks.map(async (network): Promise<[string, ConnectionScope]> => {
          const address = await this.options.tronAddress(group, network);
          return [
            network,
            {
              accounts: [caip10(network, address)],
              methods: TRON_METHODS,
              notifications: TRON_NOTIFICATIONS,
            },
          ];
        }),
      );
      Object.assign(scopes, Object.fromEntries(tronEntries));
      return { scopes, group, tronNetwork: grant.network };
    }
    if (entry.namespace === "bip122") {
      const bitcoinNetworks = this.options.enabledNetworks().filter((n) => n.startsWith("bip122:"));
      const bitcoinEntries = await Promise.all(
        bitcoinNetworks.map(async (network): Promise<[string, ConnectionScope]> => [
          network,
          await this.bitcoinScope(group, network),
        ]),
      );
      Object.assign(scopes, Object.fromEntries(bitcoinEntries));
      return { scopes, group };
    }
    const chainId = evmChainId(grant.network);
    if (chainId === undefined || !this.options.enabledNetworks().includes(grant.network)) {
      throw invalidParams(`${grant.network} is not an enabled EVM network`);
    }
    const derived = await this.options.evmAddress(group, grant.network);
    const own = derived.toLowerCase();
    if (grant.accounts.length === 0 || grant.accounts.some((a) => a.toLowerCase() !== own)) {
      throw invalidParams("only the selected group's account can be granted");
    }
    scopes[grant.network] = {
      accounts: [caip10(grant.network, own)],
      methods: SESSION_METHODS,
      notifications: SESSION_NOTIFICATIONS,
    };
    return { scopes, group };
  }

  private newSessionId(): string {
    return `session-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  private dropPending(id: string): void {
    this.expiries.get(id)?.();
    this.expiries.delete(id);
    this.waiters.delete(id);
    this.update((s) => {
      const { [id]: _gone, ...pending } = s.pending;
      return { ...s, pending };
    });
  }

  private async persist(store: EngineStore, session: ConnectionSession): Promise<void> {
    try {
      await store
        .collection(COLLECTION)
        .put(session.id, new TextEncoder().encode(JSON.stringify(session)));
    } catch (error) {
      throw internalError(error instanceof Error ? error.message : String(error));
    }
    this.update((s) => ({ ...s, sessions: { ...s.sessions, [session.id]: session } }));
  }

  private requireStore(): EngineStore {
    if (this.engineStore === undefined) {
      throw userRejectedRequest("the wallet is locked");
    }
    return this.engineStore;
  }
}
