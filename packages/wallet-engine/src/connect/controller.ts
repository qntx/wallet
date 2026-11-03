/**
 * DApp connections (CAIP-25 style sessions): one session per origin, authorization by network,
 * account and method, persisted in the engine store and cleared from memory on lock. A connection
 * is approved from a pending queue, by id, like any other request; locking rejects all of it.
 */
import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
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
  readonly createdAt: number;
  readonly lastUsedAt: number;
};

/** `connect` asks for accounts; `network` asks to add a network the session does not cover. */
export type PendingConnection = {
  readonly id: string;
  readonly origin: ConnectionOrigin;
  readonly kind: "connect" | "network";
  readonly network?: string;
  readonly createdAt: number;
};

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
  readonly enabledNetworks: () => ReadonlyArray<string>;
  /** Voids a page's unfinished requests (revoked, or its network changed). */
  readonly invalidate: (origin: string) => void;
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
];
export const SESSION_NOTIFICATIONS: ReadonlyArray<string> = ["accountsChanged", "chainChanged"];

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
    typeof value["lastUsedAt"] === "number"
  );
};

type Waiter = {
  readonly resolve: (session: ConnectionSession) => void;
  readonly reject: (error: Error) => void;
};

export class ConnectionController extends Controller<ConnectionState> {
  private readonly options: ConnectionControllerOptions;
  private engineStore: EngineStore | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private group: AccountGroup | undefined;

  constructor(options: ConnectionControllerOptions) {
    super({ name: "connections", defaultState: () => ({ sessions: {}, pending: {} }) });
    this.options = options;
  }

  async init(): Promise<void> {
    const store = await this.options.openStore();
    this.engineStore = store;
    this.group = undefined;
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
    this.update(() => ({ sessions: {}, pending: {} }));
  }

  /** Throws `4100` unless `origin` is `https://host[:port]` (or localhost in development). */
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
    kind: PendingConnection["kind"],
    network?: string,
  ): Promise<ConnectionSession> {
    const store = this.engineStore;
    if (store === undefined) {
      throw userRejectedRequest("the wallet is locked");
    }
    if (this.pending().some((p) => p.origin.origin === origin)) {
      throw requestPending("a connection request is already pending");
    }
    const id = `conn-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const entry: PendingConnection = {
      id,
      origin: { kind: "browser", origin },
      kind,
      ...(network === undefined ? {} : { network }),
      createdAt: this.options.now(),
    };
    return new Promise<ConnectionSession>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.update((s) => ({ ...s, pending: { ...s.pending, [id]: entry } }));
    });
  }

  /**
   * The host's approval, by id: the accounts granted (EVM addresses of the active group) and the
   * network.
   */
  async approveConnection(
    id: string,
    grant: { readonly accounts: ReadonlyArray<string>; readonly network: string },
  ): Promise<ConnectionSession> {
    const store = this.requireStore();
    const entry = this.getState().pending[id];
    const waiter = this.waiters.get(id);
    if (entry === undefined || waiter === undefined) {
      throw new Error(`unknown connection request ${id}`);
    }
    if (entry.kind === "network" && entry.network !== grant.network) {
      throw new Error(`connection request ${id} is for ${String(entry.network)}`);
    }
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
    if (this.getState().pending[id] === undefined) {
      throw new Error(`connection request ${id} is no longer pending`);
    }
    const now = this.options.now();
    const existing = this.session(entry.origin.origin);
    const scope: ConnectionScope = {
      accounts: [caip10(grant.network, own)],
      methods: SESSION_METHODS,
      notifications: SESSION_NOTIFICATIONS,
    };
    const session: ConnectionSession = {
      id:
        existing?.id ??
        `session-${[...this.options.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      origin: entry.origin,
      scopes: { ...existing?.scopes, [grant.network]: scope },
      currentNetwork: grant.network,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    await this.persist(store, session);
    this.dropPending(id);
    if (existing !== undefined && existing.currentNetwork !== grant.network) {
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

  private dropPending(id: string): void {
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
