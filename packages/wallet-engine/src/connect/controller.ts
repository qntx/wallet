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
import type { EngineStore } from "../store/port.ts";
import {
  internalError,
  invalidParams,
  requestPending,
  unauthorized,
  userRejectedRequest,
} from "./errors.ts";

export type ConnectionOrigin = { readonly kind: "browser"; readonly origin: string };

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
  /** The session's current EVM network; only dApp sessions have one. */
  readonly currentNetwork: string;
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
 * The four forced-confirm kinds `{0,3,5,10002}` always ask regardless.
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
  readonly namespace: "eip155" | "nostr" | "lightning" | "solana" | "bip122";
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
};

export type ConnectionControllerOptions = {
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
];

/** `payment` is the group's `btc.bip84` address, `ordinals` its `btc.bip86` one. */
export type BitcoinPurpose = "payment" | "ordinals";

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

const isSession = (value: unknown): value is ConnectionSession => {
  if (!isObject(value) || !isObject(value["origin"]) || !isObject(value["scopes"])) {
    return false;
  }
  return (
    typeof value["id"] === "string" &&
    value["origin"]["kind"] === "browser" &&
    typeof value["origin"]["origin"] === "string" &&
    typeof value["currentNetwork"] === "string" &&
    typeof value["createdAt"] === "number" &&
    typeof value["lastUsedAt"] === "number" &&
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

type Waiter = {
  readonly resolve: (session: ConnectionSession) => void;
  readonly reject: (error: Error) => void;
};

export class ConnectionController extends Controller<ConnectionState> {
  private readonly options: ConnectionControllerOptions;
  private engineStore: EngineStore | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly expiries = new Map<string, () => void>();
  private group: AccountGroup | undefined;
  private identity: NostrKeyRef | undefined;

  constructor(options: ConnectionControllerOptions) {
    super({ name: "connections", defaultState: () => ({ sessions: {}, pending: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    const store = await this.options.openStore();
    this.engineStore = store;
    this.group = undefined;
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
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
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
    this.update(() => ({ sessions, pending: {} }));
  }

  async destroy(): Promise<void> {
    this.lock();
    await Promise.resolve();
  }

  /** Locking is not consent: every pending connection is rejected. */
  lock(): void {
    this.engineStore = undefined;
    this.group = undefined;
    for (const waiter of this.waiters.values()) {
      waiter.reject(userRejectedRequest("the wallet was locked"));
    }
    this.waiters.clear();
    for (const cancel of this.expiries.values()) {
      cancel();
    }
    this.expiries.clear();
    this.update(() => ({ sessions: {}, pending: {} }));
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
   * the phishing list.
   */
  checkOrigin(origin: string): ConnectionOrigin {
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

  /** The group sessions are bound to: the host's last `setActiveGroup`, else the app's selection. */
  activeGroup(): AccountGroup | undefined {
    return this.group ?? this.options.selectedGroup();
  }

  /** Whether `network` is an EVM network the wallet has enabled. */
  isEnabled(network: string): boolean {
    return this.options.enabledNetworks().includes(network);
  }

  /** The origin's authorized addresses on its current network; empty when not connected. */
  accounts(origin: string): ReadonlyArray<string> {
    const session = this.session(origin);
    return session?.scopes[session.currentNetwork]?.accounts.map(addressOf) ?? [];
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
      origin: { kind: "browser", origin },
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
   * The host's approval, by id: the accounts granted (EVM addresses of the active group) and the
   * network.
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
    const store = this.requireStore();
    const entry = this.getState().pending[id];
    const waiter = this.waiters.get(id);
    if (entry === undefined || waiter === undefined) {
      throw new Error(`unknown connection request ${id}`);
    }
    if (this.options.phishing.check(entry.origin.origin) === "blocked") {
      const blocked = unauthorized(PHISHING_BLOCKED_MESSAGE);
      this.dropPending(id);
      waiter.reject(blocked);
      throw blocked;
    }
    if (entry.kind === "network" && entry.network !== grant.network) {
      throw new Error(`connection request ${id} is for ${String(entry.network)}`);
    }
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
    } else if (entry.namespace === "solana") {
      const group = this.activeGroup();
      if (group === undefined) {
        throw new Error("no account group is selected");
      }
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
    } else if (entry.namespace === "bip122") {
      const group = this.activeGroup();
      if (group === undefined) {
        throw new Error("no account group is selected");
      }
      const bitcoinNetworks = this.options.enabledNetworks().filter((n) => n.startsWith("bip122:"));
      const bitcoinEntries = await Promise.all(
        bitcoinNetworks.map(async (network): Promise<[string, ConnectionScope]> => [
          network,
          await this.bitcoinScope(group, network),
        ]),
      );
      Object.assign(scopes, Object.fromEntries(bitcoinEntries));
    } else if (entry.namespace === "lightning") {
      if (grant.lightning === undefined) {
        throw invalidParams("a lightning connection needs the origin's policy");
      }
      const group = this.activeGroup();
      if (group === undefined) {
        throw new Error("no account group is selected");
      }
      scopes["lightning"] = {
        accounts: [`spark:${group.walletId}:${String(group.groupIndex)}`],
        methods: LIGHTNING_METHODS,
        notifications: [],
      };
    } else {
      const chainId = evmChainId(grant.network);
      if (chainId === undefined || !this.options.enabledNetworks().includes(grant.network)) {
        throw invalidParams(`${grant.network} is not an enabled EVM network`);
      }
      const group = this.activeGroup();
      if (group === undefined) {
        throw new Error("no account group is selected");
      }
      const derived = await this.options.evmAddress(group, grant.network);
      const own = derived.toLowerCase();
      if (grant.accounts.length === 0 || grant.accounts.some((a) => a.toLowerCase() !== own)) {
        throw invalidParams("only the active group's account can be granted");
      }
      scopes[grant.network] = {
        accounts: [caip10(grant.network, own)],
        methods: SESSION_METHODS,
        notifications: SESSION_NOTIFICATIONS,
      };
    }
    if (this.getState().pending[id] === undefined) {
      throw new Error(`connection request ${id} is no longer pending`);
    }
    const now = this.options.now();
    const existing = this.session(entry.origin.origin);
    const currentNetwork =
      entry.activate === false && existing !== undefined ? existing.currentNetwork : grant.network;
    const session: ConnectionSession = {
      id:
        existing?.id ??
        `session-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      origin: entry.origin,
      scopes: { ...existing?.scopes, ...scopes },
      currentNetwork,
      ...(grant.nostr === undefined ? {} : { nostrPolicy: grant.nostr.policy }),
      ...(grant.lightning === undefined ? {} : { lightningPolicy: grant.lightning.policy }),
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    await this.persist(store, session);
    this.dropPending(id);
    if (existing !== undefined && existing.currentNetwork !== currentNetwork) {
      this.options.invalidate(entry.origin.origin);
    }
    waiter.resolve(session);
    return session;
  }

  rejectConnection(id: string): void {
    const waiter = this.waiters.get(id);
    if (this.getState().pending[id] === undefined || waiter === undefined) {
      throw new Error(`unknown connection request ${id}`);
    }
    this.dropPending(id);
    waiter.reject(userRejectedRequest());
  }

  /** Ends the origin's session; its pending connection and unfinished requests are void. */
  async revoke(origin: string): Promise<void> {
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
  }

  /** Switches within the session's scope; the origin's unfinished requests are void. */
  async setCurrentNetwork(origin: string, network: string): Promise<void> {
    const store = this.requireStore();
    const session = this.session(origin);
    if (session === undefined || session.scopes[network] === undefined) {
      throw unauthorized();
    }
    await this.persist(store, { ...session, currentNetwork: network });
    this.options.invalidate(origin);
  }

  async touch(origin: string): Promise<void> {
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
  }

  /**
   * The host switched account group: every session's accounts become the new group's addresses. A
   * session that cannot get one (no address derivable) is left with an empty list and has to be
   * authorized again.
   */
  async setActiveGroup(walletId: string, groupIndex: number): Promise<void> {
    const store = this.requireStore();
    const group = { walletId, groupIndex };
    this.group = group;
    await Promise.all(
      Object.values(this.getState().sessions).map(async (session) => {
        const entries = await Promise.all(
          Object.entries(session.scopes).map(
            async ([network, scope]): Promise<[string, ConnectionScope]> => {
              if (scope.accounts.length === 0) {
                return [network, scope];
              }
              try {
                if (network === "nostr" || network === "lightning") {
                  return [network, scope];
                }
                if (network.startsWith("bip122:")) {
                  return [network, await this.bitcoinScope(group, network)];
                }
                if (network.startsWith("solana:")) {
                  const address = await this.options.solanaAddress(group, network);
                  return [network, { ...scope, accounts: [caip10(network, address)] }];
                }
                const address = await this.options.evmAddress(group, network);
                return [network, { ...scope, accounts: [caip10(network, address.toLowerCase())] }];
              } catch (error) {
                this.options.logger.warn("connection account unavailable in the new group", error);
                return [network, { ...scope, accounts: [] }];
              }
            },
          ),
        );
        await this.persist(store, { ...session, scopes: Object.fromEntries(entries) });
      }),
    );
  }

  /** The active Nostr identity — `undefined` until the host picks one. */
  activeIdentity(): NostrKeyRef | undefined {
    return this.identity;
  }

  /** The origin's persisted Nostr policy — `undefined` until it is nostr-authorized. */
  nostrPolicy(origin: string): NostrPolicy | undefined {
    return this.session(origin)?.nostrPolicy;
  }

  /** The origin's `nostr` namespace scope's pubkey, or `undefined` when not nostr-authorized. */
  nostrAccount(origin: string): string | undefined {
    const account = this.session(origin)?.scopes["nostr"]?.accounts[0];
    return account === undefined ? undefined : addressOf(account);
  }

  /** The origin's persisted Lightning policy — `undefined` until it is lightning-authorized. */
  lightningPolicy(origin: string): LightningPolicy | undefined {
    return this.session(origin)?.lightningPolicy;
  }

  /** The origin's `solana` scope's address on `network`, or `undefined` when not authorized. */
  solanaAccount(origin: string, network: string): string | undefined {
    const account = this.session(origin)?.scopes[network]?.accounts[0];
    return account === undefined ? undefined : addressOf(account);
  }

  /**
   * The origin's `bip122` scope accounts on `network`, in `BITCOIN_PURPOSES` order, or `undefined`
   * when not authorized.
   */
  bitcoinAccounts(origin: string, network: string): Record<BitcoinPurpose, string> | undefined {
    const [payment, ordinals] = this.session(origin)?.scopes[network]?.accounts ?? [];
    return payment === undefined || ordinals === undefined
      ? undefined
      : { payment: addressOf(payment), ordinals: addressOf(ordinals) };
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
   * The host's Nostr identity selection: every authorized `nostr` session's account becomes the new
   * identity's pubkey (or empties when the identity is cleared). No event — NIP-07 has none.
   */
  async setActiveIdentity(ref: NostrKeyRef | undefined): Promise<void> {
    const store = this.requireStore();
    this.identity = ref;
    let pubkey: string | undefined;
    if (ref !== undefined) {
      const raw = await this.options.nostrPubkey(ref);
      pubkey = raw.toLowerCase();
    }
    await Promise.all(
      Object.values(this.getState().sessions).map(async (session) => {
        const scope = session.scopes["nostr"];
        if (scope === undefined || scope.accounts.length === 0) {
          return;
        }
        await this.persist(store, {
          ...session,
          scopes: {
            ...session.scopes,
            nostr: {
              ...scope,
              accounts: pubkey === undefined ? [] : [`nostr:${pubkey}`],
            },
          },
        });
      }),
    );
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
