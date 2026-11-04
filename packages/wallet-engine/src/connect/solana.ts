import { hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

import { SOLANA_NETWORKS } from "../networks/registry.ts";
import type { RequestController } from "../requests/controller.ts";
import type { BrowserOrigin } from "../requests/types.ts";
import type { ConnectionController, ConnectionSession } from "./controller.ts";
import { SOLANA_METHODS } from "./controller.ts";
import { ProviderError, invalidParams } from "./errors.ts";
import { checkSignInInput, signInMessageText } from "./siws.ts";
import type { SignInFields } from "./siws.ts";
import { BLIND_SIGNING_MESSAGE, utf8Text } from "./text.ts";

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

/** The Wallet Standard short id of a registry network, or `undefined` when it has none. */
export const walletStandardChain = (network: string): string | undefined =>
  Object.entries(SOLANA_CHAIN_IDS).find(([, id]) => id === network)?.[0];

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
    if (request.method === "solana:signIn") {
      return this.signIn(checked, request);
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
    const chain = walletStandardChain(network);
    if (chain === undefined) {
      throw new ProviderError(-32603, `network ${network} has no Wallet Standard chain id`);
    }
    return {
      address: account.address,
      publicKey: account.publicKey,
      chains: [chain],
      features: SOLANA_METHODS.filter((m) => m.startsWith("solana:")),
    };
  }

  private async signTransactions(
    checked: BrowserOrigin,
    request: SolanaRequest,
    send: boolean,
  ): Promise<unknown> {
    const network = this.networkOf(request.params, send);
    this.options.connections.authorize(checked.origin, network, request.method);
    const address = this.options.connections.solanaAccount(checked.origin, network);
    if (address === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    checkAccounts(request.params, address);
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
      ? { signatures: (outcome.signatures ?? []).map((signature) => base58.decode(signature)) }
      : { signedTransactions: outcome.signedTransactions };
  }

  /**
   * The network a transaction call targets: the wallet's default when no input names a chain,
   * otherwise the one chain every input agrees on (`chain` is required for sign-and-send).
   */
  private networkOf(params: unknown, requireChain: boolean): string {
    const chains = paramList(params, "chains");
    if (requireChain && (chains.length === 0 || chains.some((chain) => chain === undefined))) {
      throw invalidParams("chain is required for solana:signAndSendTransaction");
    }
    const named = new Set(chains.filter((chain) => chain !== undefined));
    if (named.size === 0) {
      return this.options.solanaNetwork();
    }
    if (named.size > 1 || chains.some((chain) => chain === undefined)) {
      throw invalidParams("every input must use the same chain");
    }
    const [chain] = [...named];
    const network = typeof chain === "string" ? SOLANA_CHAIN_IDS[chain] : undefined;
    if (network === undefined) {
      throw invalidParams("unknown chain");
    }
    return network;
  }

  private async signMessage(checked: BrowserOrigin, request: SolanaRequest): Promise<unknown> {
    const network = this.options.solanaNetwork();
    this.options.connections.authorize(checked.origin, network, "solana:signMessage");
    const address = this.options.connections.solanaAccount(checked.origin, network);
    if (address !== undefined) {
      checkAccounts(request.params, address);
    }
    const message = messageOf(request.params);
    if (utf8Text(message) === undefined) {
      throw new ProviderError(4200, BLIND_SIGNING_MESSAGE);
    }
    const signature = await this.signMessageRequest(checked, network, message);
    return { signature, signedMessage: message };
  }

  /**
   * Sign In With Solana: connects first when needed, binds the message to the page's host and the
   * session's account, and signs the exact text the user is shown.
   */
  private async signIn(checked: BrowserOrigin, request: SolanaRequest): Promise<unknown> {
    const params =
      typeof request.params === "object" && request.params !== null ? request.params : {};
    const { input: raw } = params as { input?: unknown };
    const input = checkSignInInput(raw === undefined ? {} : raw);
    const { host } = new URL(checked.origin);
    if (input.domain !== undefined && input.domain !== host) {
      throw invalidParams("domain does not match the page");
    }
    const { accounts } = await this.connect(checked, { method: "standard:connect" });
    const [walletAccount] = accounts;
    const network = this.options.solanaNetwork();
    this.options.connections.authorize(checked.origin, network, "solana:signIn");
    if (walletAccount === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    if (input.address !== undefined && input.address !== walletAccount.address) {
      throw new ProviderError(4100, "address is not the connected account");
    }
    const fields: SignInFields = { ...input, domain: host, address: walletAccount.address };
    const message = new TextEncoder().encode(signInMessageText(fields));
    const signature = await this.signMessageRequest(checked, network, message, fields);
    return [
      { account: walletAccount, signedMessage: message, signature, signatureType: "ed25519" },
    ];
  }

  private async signMessageRequest(
    checked: BrowserOrigin,
    network: string,
    message: Uint8Array,
    signIn?: SignInFields,
  ): Promise<Uint8Array> {
    const address = this.options.connections.solanaAccount(checked.origin, network);
    if (address === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    const group = this.options.activeGroup();
    if (group === undefined) {
      throw new ProviderError(4100, "no account group is selected");
    }
    const pending = await this.options.requests.prepare({
      method: "solana-sign",
      origin: checked,
      account: { walletId: group.walletId, groupIndex: group.groupIndex, address },
      network,
      request: { kind: "message", message, ...(signIn === undefined ? {} : { signIn }) },
    });
    const outcome = await this.options.requests.outcome(pending.id);
    if (!("kind" in outcome) || outcome.kind !== "solana.message") {
      throw new ProviderError(-32603, "the solana-sign request settled unexpectedly");
    }
    return outcome.signature;
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

const paramList = (params: unknown, name: string): ReadonlyArray<unknown> => {
  const value: unknown =
    typeof params === "object" && params !== null
      ? new Map<string, unknown>(Object.entries(params)).get(name)
      : undefined;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidParams(`${name} must be an array`);
  }
  return value as unknown[];
};

/** Every account the page names must be the session's Solana account. */
const checkAccounts = (params: unknown, address: string): void => {
  if (paramList(params, "accounts").some((account) => account !== address)) {
    throw new ProviderError(4100, "account is not the connected account");
  }
};

const isBytesEnvelope = (v: unknown): v is { __bytes: string } =>
  typeof v === "object" && v !== null && typeof (v as { __bytes?: unknown }).__bytes === "string";

const transactionsOf = (params: unknown): Uint8Array[] => {
  const raw =
    typeof params === "object" && params !== null
      ? (params as { transactions?: unknown }).transactions
      : undefined;
  if (!Array.isArray(raw)) {
    throw invalidParams("solana:signTransaction needs a transactions array");
  }
  return raw.map((tx) => {
    if (tx instanceof Uint8Array) {
      return tx;
    }
    if (typeof tx === "string" && /^[0-9a-fA-F]+$/.test(tx)) {
      return hexToBytes(tx);
    }
    if (isBytesEnvelope(tx)) {
      return hexToBytes(tx.__bytes);
    }
    throw invalidParams("each transaction must be Uint8Array bytes or hex");
  });
};

const messageOf = (params: unknown): Uint8Array => {
  const message =
    typeof params === "object" && params !== null
      ? (params as { message?: unknown }).message
      : undefined;
  if (message instanceof Uint8Array) {
    return message;
  }
  if (typeof message === "string" && /^[0-9a-fA-F]+$/.test(message)) {
    return hexToBytes(message);
  }
  if (isBytesEnvelope(message)) {
    return hexToBytes(message.__bytes);
  }
  throw invalidParams("solana:signMessage needs Uint8Array bytes or hex");
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
