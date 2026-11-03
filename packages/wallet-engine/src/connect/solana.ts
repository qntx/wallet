import { SOLANA_NETWORKS } from "../networks/registry.ts";
import type { RequestController } from "../requests/controller.ts";
import type { BrowserOrigin } from "../requests/types.ts";
import type { ConnectionController, ConnectionSession } from "./controller.ts";
import { SOLANA_METHODS } from "./controller.ts";
import { ProviderError, invalidParams } from "./errors.ts";

/**
 * The Wallet Standard (`window.solana` / `registerWallet`) handler — the bridge routes `provider:
 * "solana"` messages here.
 */
export type SolanaRequest = {
  readonly method: string;
  readonly params?: unknown;
};

export type SolanaHandler = {
  readonly handle: (origin: string, request: SolanaRequest) => Promise<unknown>;
  readonly subscribe: (listener: (event: SolanaEvent) => void) => () => void;
};

const solanaId = (name: string): string => {
  const entry = SOLANA_NETWORKS.find((n) => n.name === name);
  if (entry === undefined) {
    throw new Error(`no solana network named ${name} in the registry`);
  }
  return entry.id;
};

/**
 * The Wallet Standard short chain ids to the registry's CAIP-2 genesis-hash ids, derived from the
 * solana network registry by name.
 */
export const SOLANA_CHAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  "solana:mainnet": solanaId("Solana"),
  "solana:devnet": solanaId("Solana Devnet"),
});

/** The Wallet Standard `WalletAccount` shape `standard:connect` returns per account. */
export type SolanaWalletAccount = {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: ReadonlyArray<string>;
  readonly features: ReadonlyArray<string>;
  readonly icon?: string;
  readonly label?: string;
};

export type SolanaEvent = {
  readonly name: "solanaAccountsChanged";
  readonly origin: string;
  readonly accounts: ReadonlyArray<SolanaWalletAccount>;
};

type SolanaConnections = Pick<
  ConnectionController,
  | "checkOrigin"
  | "session"
  | "authorize"
  | "solanaAccount"
  | "request"
  | "touch"
  | "revoke"
  | "getState"
  | "store"
>;

type Options = {
  readonly connections: SolanaConnections;
  readonly requests: Pick<RequestController, "prepare" | "outcome">;
  /** The group's Solana address + public key on `network` (the `solana.bip44-change` account). */
  readonly solanaAccount: (
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
  ) => Promise<{ readonly address: string; readonly publicKey: Uint8Array }>;
  readonly activeGroup: () =>
    | { readonly walletId: string; readonly groupIndex: number }
    | undefined;
  readonly solanaNetwork: () => string;
};

/**
 * The Wallet Standard handler: `standard:connect` authorizes the `solana` scope, `solana:*` sign
 * requests go through `solana-sign`, `solanaAccountsChanged` returns the re-pointed accounts the
 * bridge forwards as `standard:events` `change` on a group switch.
 */
export class SolanaWalletHandler implements SolanaHandler {
  readonly options: Options;
  private readonly listeners = new Set<(event: SolanaEvent) => void>();
  private unsubscribe: (() => void) | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  /** `standard:events` `change` per origin — derived from changes to the sessions. */
  subscribe(listener: (event: SolanaEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.unsubscribe === undefined) {
      let previous = this.options.connections.getState().sessions;
      this.unsubscribe = this.options.connections.store.subscribe((state) => {
        void (async () => {
          const events = await Promise.all(
            diffSessions(previous, state.sessions).map(
              async ({ origin }): Promise<SolanaEvent> => ({
                name: "solanaAccountsChanged",
                origin,
                accounts: await this.solanaAccountsChanged(origin),
              }),
            ),
          );
          for (const event of events) {
            for (const l of this.listeners) {
              l(event);
            }
          }
        })();
        previous = state.sessions;
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  }

  async handle(origin: string, request: SolanaRequest): Promise<unknown> {
    const checked = this.options.connections.checkOrigin(origin);
    if (request.method === "standard:connect") {
      return this.connect(checked, request);
    }
    if (request.method === "standard:disconnect") {
      await this.options.connections.revoke(origin);
      return {};
    }
    if (request.method === "solana:signTransaction") {
      return this.signTransactions(checked, request, false);
    }
    if (request.method === "solana:signAndSendTransaction") {
      return this.signTransactions(checked, request, true);
    }
    if (request.method === "solana:signMessage") {
      return this.signMessage(checked, request);
    }
    throw invalidParams(`unsupported solana method ${request.method}`);
  }

  private async connect(
    checked: BrowserOrigin,
    request: SolanaRequest,
  ): Promise<{ accounts: ReadonlyArray<SolanaWalletAccount> }> {
    const params =
      typeof request.params === "object" && request.params !== null ? request.params : {};
    const silent = (params as { silent?: boolean }).silent === true;
    const network = this.options.solanaNetwork();
    if (this.options.connections.solanaAccount(checked.origin, network) === undefined) {
      if (silent) {
        throw new ProviderError(4100, "the wallet is not connected");
      }
      await this.options.connections.request(checked.origin, "connect", undefined, "solana");
    } else {
      await this.options.connections.touch(checked.origin);
    }
    const group = this.options.activeGroup();
    if (group === undefined) {
      throw new ProviderError(4100, "no account group is selected");
    }
    const account = await this.options.solanaAccount(group, network);
    return { accounts: [this.walletAccount(account, network)] };
  }

  private walletAccount(
    account: { readonly address: string; readonly publicKey: Uint8Array },
    network: string,
  ): SolanaWalletAccount {
    return {
      address: account.address,
      publicKey: account.publicKey,
      chains: [network],
      features: SOLANA_METHODS.filter((m) => m.startsWith("solana:")),
    };
  }

  private async signTransactions(
    checked: BrowserOrigin,
    request: SolanaRequest,
    send: boolean,
  ): Promise<unknown> {
    const network = this.options.solanaNetwork();
    this.options.connections.authorize(checked.origin, network, request.method);
    const address = this.options.connections.solanaAccount(checked.origin, network);
    if (address === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    const txs = transactionsOf(request.params);
    const group = this.options.activeGroup();
    if (group === undefined) {
      throw new ProviderError(4100, "no account group is selected");
    }
    const pending = await this.options.requests.prepare({
      method: "solana-sign",
      origin: checked,
      account: { walletId: group.walletId, groupIndex: group.groupIndex, address },
      network,
      request: { kind: "transactions", transactions: txs, send },
    });
    const outcome = await this.options.requests.outcome(pending.id);
    if (!("kind" in outcome) || outcome.kind !== "solana.transactions") {
      throw new ProviderError(-32603, "the solana-sign request settled unexpectedly");
    }
    return send
      ? { signatures: outcome.signatures }
      : { signedTransactions: outcome.signedTransactions };
  }

  private async signMessage(checked: BrowserOrigin, request: SolanaRequest): Promise<unknown> {
    const network = this.options.solanaNetwork();
    this.options.connections.authorize(checked.origin, network, "solana:signMessage");
    const address = this.options.connections.solanaAccount(checked.origin, network);
    if (address === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    const message = messageOf(request.params);
    const group = this.options.activeGroup();
    if (group === undefined) {
      throw new ProviderError(4100, "no account group is selected");
    }
    const pending = await this.options.requests.prepare({
      method: "solana-sign",
      origin: checked,
      account: { walletId: group.walletId, groupIndex: group.groupIndex, address },
      network,
      request: { kind: "message", message },
    });
    const outcome = await this.options.requests.outcome(pending.id);
    if (!("kind" in outcome) || outcome.kind !== "solana.message") {
      throw new ProviderError(-32603, "the solana-sign request settled unexpectedly");
    }
    return { signature: outcome.signature, signedMessage: message };
  }

  /** The `setActiveGroup` re-point: the solana session's new `WalletAccount[]` for `change`. */
  async solanaAccountsChanged(_origin: string): Promise<SolanaWalletAccount[]> {
    const network = this.options.solanaNetwork();
    const group = this.options.activeGroup();
    if (group === undefined) {
      return [];
    }
    const account = await this.options.solanaAccount(group, network);
    return [this.walletAccount(account, network)];
  }
}

const transactionsOf = (params: unknown): Uint8Array[] => {
  const raw =
    typeof params === "object" && params !== null
      ? (params as { transactions?: unknown }).transactions
      : undefined;
  if (!Array.isArray(raw)) {
    throw invalidParams("solana:signTransaction needs a transactions array");
  }
  return raw.map((tx) => {
    if (!(tx instanceof Uint8Array)) {
      throw invalidParams("each transaction must be Uint8Array bytes");
    }
    return tx;
  });
};

const messageOf = (params: unknown): Uint8Array => {
  const message =
    typeof params === "object" && params !== null
      ? (params as { message?: unknown }).message
      : undefined;
  if (!(message instanceof Uint8Array)) {
    throw invalidParams("solana:signMessage needs Uint8Array bytes");
  }
  return message;
};

const byOrigin = (
  sessions: Readonly<Record<string, ConnectionSession>>,
): Map<string, ConnectionSession> =>
  new Map(Object.values(sessions).map((s) => [s.origin.origin, s]));

const solanaAccounts = (session: ConnectionSession): ReadonlyArray<string> =>
  Object.entries(session.scopes)
    .filter(([network]) => network.startsWith("solana:"))
    .flatMap(([, scope]) => scope.accounts.map((a) => a.slice(a.lastIndexOf(":") + 1)));

function diffSessions(
  before: Readonly<Record<string, ConnectionSession>>,
  after: Readonly<Record<string, ConnectionSession>>,
): ReadonlyArray<{ origin: string; accounts: ReadonlyArray<string> }> {
  const events: Array<{ origin: string; accounts: ReadonlyArray<string> }> = [];
  const prev = byOrigin(before);
  const next = byOrigin(after);
  for (const [origin, session] of prev) {
    const now = next.get(origin);
    const was = solanaAccounts(session).join(",");
    const is = now === undefined ? "" : solanaAccounts(now).join(",");
    if (was !== is) {
      events.push({ origin, accounts: now === undefined ? [] : solanaAccounts(now) });
    }
  }
  for (const [origin, session] of next) {
    if (!prev.has(origin)) {
      const accounts = solanaAccounts(session);
      if (accounts.length > 0) {
        events.push({ origin, accounts });
      }
    }
  }
  return events;
}
