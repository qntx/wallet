import { hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

import { ChainError } from "@qntx/wallet-chains";
import { decodeSolanaTransaction } from "@qntx/wallet-chains/solana";

import { SOLANA_NETWORKS } from "../networks/registry.ts";
import { SignInOriginError } from "../requests/controller.ts";
import type { RequestController } from "../requests/controller.ts";
import type { BrowserOrigin } from "../requests/types.ts";
import type { ConnectionController, ConnectionSession } from "./controller.ts";
import { SOLANA_METHODS, sessionAccounts } from "./controller.ts";
import { ProviderError, broadcastRefused, invalidParams } from "./errors.ts";
import { checkSignInInput, signInMessageText } from "./siws.ts";
import type { SignInFields } from "./siws.ts";
import { SessionEvents } from "./subscription.ts";

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
  | "sessionAccounts"
  | "request"
  | "touch"
  | "revoke"
  | "getState"
  | "store"
>;

type SolanaRequests = Pick<RequestController, "prepare" | "outcome">;

type Options = {
  readonly connections: SolanaConnections;
  readonly requests: SolanaRequests;
  /** The group's Solana address + public key on `network` (the `solana.bip44-change` account). */
  readonly solanaAccount: (
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
  ) => Promise<{ readonly address: string; readonly publicKey: Uint8Array }>;
  readonly solanaNetwork: () => string;
};

/**
 * The Wallet Standard handler: `standard:connect` authorizes the `solana` scope, `solana:*` sign
 * requests go through `solana-sign`, `solanaAccountsChanged` returns the re-pointed accounts the
 * bridge forwards as `standard:events` `change` on a group switch.
 */
export class SolanaWalletHandler implements SolanaHandler {
  readonly options: Options;
  private readonly events: SessionEvents<SolanaEvent>;

  constructor(options: Options) {
    this.options = options;
    this.events = new SessionEvents(options.connections, async (before, after) =>
      Promise.all(
        diffSessions(before, after).map(async ({ origin, session }): Promise<SolanaEvent> => ({
          name: "solanaAccountsChanged",
          origin,
          accounts: await this.sessionAccountsChanged(session),
        })),
      ),
    );
  }

  /** `standard:events` `change` per origin — derived from changes to the sessions. */
  subscribe(listener: (event: SolanaEvent) => void): () => void {
    return this.events.subscribe(listener);
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
    let binding = this.options.connections.sessionAccounts(checked.origin, network);
    if (binding === undefined) {
      if (silent) {
        throw new ProviderError(4100, "the wallet is not connected");
      }
      await this.options.connections.request(checked.origin, {
        kind: "connect",
        namespace: "solana",
      });
      binding = this.options.connections.sessionAccounts(checked.origin, network);
      if (binding === undefined) {
        throw new ProviderError(4100, "the wallet is not connected");
      }
    } else {
      await this.options.connections.touch(checked.origin);
    }
    const account = await this.options.solanaAccount(binding.group, network);
    if (account.address !== binding.addresses[0]) {
      throw new ProviderError(-32603, "the session's account does not derive for its group");
    }
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
    const binding = this.options.connections.sessionAccounts(checked.origin, network);
    const address = binding?.addresses[0];
    if (binding === undefined || address === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    checkAccounts(request.params, address);
    const txs = transactionsOf(request.params);
    for (const tx of txs) {
      try {
        const { unsigned } = decodeSolanaTransaction(tx, address);
        // A sign-and-send whose other signers have not signed can never land (Solana Pay's
        // transaction-request spec requires wallets to reject these).
        if (send && unsigned.length > 0) {
          throw invalidParams(`the transaction still needs signatures from ${unsigned.join(", ")}`);
        }
      } catch (error) {
        throw error instanceof ChainError ? invalidParams(error.message) : error;
      }
    }
    const outcome = await this.signRequest(checked, network, binding.group, address, {
      kind: "transactions",
      transactions: txs,
      send,
    });
    if (!("kind" in outcome) || outcome.kind !== "solana.transactions") {
      throw new ProviderError(-32603, "the solana-sign request settled unexpectedly");
    }
    if (send && outcome.refused !== undefined) {
      throw broadcastRefused(outcome.refused, outcome.signatures ?? []);
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
    const binding = this.options.connections.sessionAccounts(checked.origin, network);
    if (binding !== undefined && binding.addresses[0] !== undefined) {
      checkAccounts(request.params, binding.addresses[0]);
    }
    const message = messageOf(request.params);
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
    const binding = this.options.connections.sessionAccounts(checked.origin, network);
    const address = binding?.addresses[0];
    if (binding === undefined || address === undefined) {
      throw new ProviderError(4100, "no solana account for this origin");
    }
    const outcome = await this.signRequest(checked, network, binding.group, address, {
      kind: "message",
      message,
      ...(signIn === undefined ? {} : { signIn }),
    });
    if (!("kind" in outcome) || outcome.kind !== "solana.message") {
      throw new ProviderError(-32603, "the solana-sign request settled unexpectedly");
    }
    return outcome.signature;
  }

  /** One `solana-sign` request for the session's bound group, resolved to its outcome. */
  private async signRequest(
    checked: BrowserOrigin,
    network: string,
    group: { readonly walletId: string; readonly groupIndex: number },
    address: string,
    request: Parameters<SolanaRequests["prepare"]>[0] extends infer I
      ? I extends { method: "solana-sign"; request: infer R }
        ? R
        : never
      : never,
  ): Promise<Awaited<ReturnType<SolanaRequests["outcome"]>>> {
    try {
      const pending = await this.options.requests.prepare({
        method: "solana-sign",
        origin: checked,
        account: { walletId: group.walletId, groupIndex: group.groupIndex, address },
        network,
        request,
      });
      return await this.options.requests.outcome(pending.id);
    } catch (error) {
      throw error instanceof SignInOriginError ? invalidParams(error.message) : error;
    }
  }

  /**
   * A `change` event's accounts, derived only from the session after the write: the binding's
   * account — empty when the session is gone or no Solana account is bound.
   */
  private async sessionAccountsChanged(
    session: ConnectionSession | undefined,
  ): Promise<SolanaWalletAccount[]> {
    const network = this.options.solanaNetwork();
    const binding = sessionAccounts(session, network);
    const address = binding?.addresses[0];
    if (binding === undefined || address === undefined) {
      return [];
    }
    try {
      const account = await this.options.solanaAccount(binding.group, network);
      return account.address === address ? [this.walletAccount(account, network)] : [];
    } catch {
      /* A session whose account cannot be derived or advertised changes to an empty list. */
      return [];
    }
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

/**
 * The origins whose Solana scope's accounts changed between the two snapshots, each with the
 * session after the write (`undefined` when the session is gone).
 */
function diffSessions(
  before: Readonly<Record<string, ConnectionSession>>,
  after: Readonly<Record<string, ConnectionSession>>,
): ReadonlyArray<{ origin: string; session: ConnectionSession | undefined }> {
  const events: Array<{ origin: string; session: ConnectionSession | undefined }> = [];
  const prev = byOrigin(before);
  const next = byOrigin(after);
  for (const [origin, session] of prev) {
    const now = next.get(origin);
    const was = solanaAccounts(session).join(",");
    const is = now === undefined ? "" : solanaAccounts(now).join(",");
    if (was !== is) {
      events.push({ origin, session: now });
    }
  }
  for (const [origin, session] of next) {
    if (!prev.has(origin) && solanaAccounts(session).length > 0) {
      events.push({ origin, session });
    }
  }
  return events;
}
