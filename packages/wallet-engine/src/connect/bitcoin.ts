import { hexToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import { BITCOIN_NETWORKS } from "../networks/registry.ts";
import type { RequestController } from "../requests/controller.ts";
import type {
  BitcoinAccount,
  BitcoinPsbtInput,
  BitcoinSigHash,
  WalletConnectOrigin,
} from "../requests/types.ts";
import type {
  BitcoinPurpose,
  ConnectionController,
  ConnectionOrigin,
  ConnectionSession,
} from "./controller.ts";
import { BITCOIN_METHODS, BITCOIN_PURPOSES, sessionAccounts } from "./controller.ts";
import {
  ProviderError,
  batchStopped,
  internalError,
  invalidParams,
  toProviderError,
} from "./errors.ts";
import { SessionEvents } from "./subscription.ts";
import { BLIND_SIGNING_MESSAGE, utf8Text } from "./text.ts";

/**
 * The Bitcoin Wallet Standard (Exodus' `bitcoin:*` features, registered through
 * `@wallet-standard/wallet` like the Solana wallet) handler — the bridge routes `provider:
 * "bitcoin"` messages here.
 */
export type BitcoinRequest = {
  readonly method: string;
  readonly params?: unknown;
  /**
   * The CAIP-2 network the call targets — a WalletConnect request names it; the in-app-browser
   * bridge never sets it (the page has no say), so its calls use the wallet's default network.
   */
  readonly network?: string;
};

export type BitcoinHandler = {
  readonly handle: (
    origin: string | WalletConnectOrigin,
    request: BitcoinRequest,
  ) => Promise<unknown>;
  readonly subscribe: (listener: (event: BitcoinEvent) => void) => () => void;
};

const bitcoinId = (name: string): string => {
  const entry = BITCOIN_NETWORKS.find((n) => n.name === name);
  if (entry === undefined) {
    throw new Error(`no bitcoin network named ${name} in the registry`);
  }
  return entry.id;
};

/**
 * The Bitcoin Wallet Standard chain ids to the registry's CAIP-2 ids: `bitcoin:testnet` is the
 * registry's default test network (Testnet4 — the registry has no Testnet3).
 */
export const BITCOIN_CHAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  "bitcoin:mainnet": bitcoinId("Bitcoin"),
  "bitcoin:testnet": bitcoinId("Bitcoin Testnet4"),
});

/** The Wallet Standard chain id of a registry network, or `undefined` when it has none. */
export const bitcoinStandardChain = (network: string): string | undefined =>
  Object.entries(BITCOIN_CHAIN_IDS).find(([, id]) => id === network)?.[0];

/** The Wallet Standard `WalletAccount` shape `bitcoin:connect` returns per account. */
export type BitcoinWalletAccount = {
  readonly address: string;
  /** `payment`: the compressed key (33 bytes); `ordinals`: the x-only internal key (32 bytes). */
  readonly publicKey: Uint8Array;
  readonly chains: ReadonlyArray<string>;
  readonly features: ReadonlyArray<string>;
};

export type BitcoinEvent = {
  readonly name: "bitcoinAccountsChanged";
  readonly origin: string;
  readonly accounts: ReadonlyArray<BitcoinWalletAccount>;
};

type BitcoinConnections = Pick<
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

type BitcoinRequests = Pick<RequestController, "prepare" | "outcome">;

/** The kernel tags a BIP-322 simple signature `smp` + base64 of the witness. */
const SIMPLE_PREFIX = "smp";

const TEMPLATES = { payment: "btc.bip84", ordinals: "btc.bip86" } as const;

type Options = {
  readonly connections: BitcoinConnections;
  readonly requests: BitcoinRequests;
  /** The group's address and public key for `purpose` on `network` (receive chain, index 0). */
  readonly bitcoinAccount: (
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
    purpose: BitcoinPurpose,
  ) => Promise<{ readonly address: string; readonly publicKey: Uint8Array }>;
  readonly bitcoinNetwork: () => string;
};

/**
 * The Bitcoin Wallet Standard handler: `bitcoin:connect` authorizes the `bip122` scope (both the
 * `payment` and the `ordinals` account) and returns the requested purposes in order;
 * `bitcoin:signMessage` goes through `bitcoin-sign` (BIP-322 simple); `bitcoinAccountsChanged`
 * carries the re-pointed accounts the bridge forwards as `bitcoin:events` `change` on a group
 * switch.
 */
export class BitcoinWalletHandler implements BitcoinHandler {
  readonly options: Options;
  private readonly events: SessionEvents<BitcoinEvent>;

  constructor(options: Options) {
    this.options = options;
    this.events = new SessionEvents(options.connections, async (before, after) =>
      Promise.all(
        diffSessions(before, after).map(async ({ origin, session }): Promise<BitcoinEvent> => ({
          name: "bitcoinAccountsChanged",
          origin,
          accounts: await this.sessionAccountsChanged(session),
        })),
      ),
    );
  }

  subscribe(listener: (event: BitcoinEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async handle(origin: string | WalletConnectOrigin, request: BitcoinRequest): Promise<unknown> {
    const caller = this.options.connections.checkOrigin(origin);
    if (request.method === "bitcoin:connect") {
      return this.connect(caller, request);
    }
    if (request.method === "standard:disconnect") {
      await this.options.connections.revoke(caller.origin);
      return {};
    }
    if (request.method === "bitcoin:signMessage") {
      return this.signMessage(caller, request);
    }
    if (request.method === "bitcoin:signTransaction") {
      return this.signTransactions(caller, request, false);
    }
    if (request.method === "bitcoin:signAndSendTransaction") {
      return this.signTransactions(caller, request, true);
    }
    throw invalidParams(`unsupported bitcoin method ${request.method}`);
  }

  private async connect(
    caller: ConnectionOrigin,
    request: BitcoinRequest,
  ): Promise<{ accounts: ReadonlyArray<BitcoinWalletAccount> }> {
    const purposes = purposesOf(request.params);
    const network = request.network ?? this.options.bitcoinNetwork();
    let binding = this.options.connections.sessionAccounts(caller.origin, network);
    await (binding === undefined
      ? this.options.connections.request(caller.origin, { kind: "connect", namespace: "bip122" })
      : this.options.connections.touch(caller.origin));
    binding = this.options.connections.sessionAccounts(caller.origin, network);
    if (binding === undefined) {
      throw new ProviderError(4100, "the wallet is not connected");
    }
    const { group } = binding;
    const accounts = await Promise.all(
      purposes.map(async (purpose) => {
        const account = await this.walletAccount(group, network, purpose);
        if (account.address !== binding.addresses[BITCOIN_PURPOSES.indexOf(purpose)]) {
          throw new ProviderError(-32603, "the session's account does not derive for its group");
        }
        return account;
      }),
    );
    return { accounts };
  }

  private async walletAccount(
    group: { readonly walletId: string; readonly groupIndex: number },
    network: string,
    purpose: BitcoinPurpose,
  ): Promise<BitcoinWalletAccount> {
    const chain = bitcoinStandardChain(network);
    if (chain === undefined) {
      throw new ProviderError(-32603, `network ${network} has no Wallet Standard chain id`);
    }
    const account = await this.options.bitcoinAccount(group, network, purpose);
    return {
      address: account.address,
      publicKey: account.publicKey,
      chains: [chain],
      features: BITCOIN_METHODS.filter((m) => m.startsWith("bitcoin:")),
    };
  }

  /**
   * Signs `message` (UTF-8 text only — `bitcoin.message` takes text, so there is no blind path) for
   * one of the session's accounts. The signature is the BIP-322 simple witness serialization
   * (witness item count, then each item length-prefixed) — the kernel's `smp` + base64 string
   * decoded to bytes, which is what MetaMask's Bitcoin Wallet Standard wallet hands out.
   */
  private async signMessage(caller: ConnectionOrigin, request: BitcoinRequest): Promise<unknown> {
    const network = request.network ?? this.options.bitcoinNetwork();
    this.options.connections.authorize(caller.origin, network, "bitcoin:signMessage");
    const binding = this.options.connections.sessionAccounts(caller.origin, network);
    if (binding === undefined) {
      throw new ProviderError(4100, "no bitcoin account for this origin");
    }
    const { address, message } = signMessageParams(request.params);
    const purpose = BITCOIN_PURPOSES.find(
      (p) => binding.addresses[BITCOIN_PURPOSES.indexOf(p)] === address,
    );
    if (purpose === undefined) {
      throw new ProviderError(4100, "account is not a connected account");
    }
    const text = utf8Text(message);
    if (text === undefined) {
      throw new ProviderError(4200, BLIND_SIGNING_MESSAGE);
    }
    const account: BitcoinAccount = { ...binding.group, address, template: TEMPLATES[purpose] };
    let outcome: Awaited<ReturnType<BitcoinRequests["outcome"]>>;
    try {
      const pending = await this.options.requests.prepare({
        method: "bitcoin-sign",
        origin: caller,
        account,
        network,
        request: { kind: "message", message: text },
      });
      outcome = await this.options.requests.outcome(pending.id);
    } catch (error) {
      throw toProviderError(error);
    }
    if (!("kind" in outcome) || outcome.kind !== "bitcoin.message") {
      throw new ProviderError(-32603, "the bitcoin-sign request settled unexpectedly");
    }
    if (!outcome.signature.startsWith(SIMPLE_PREFIX)) {
      throw new ProviderError(-32603, "the kernel returned an unrecognized signature encoding");
    }
    return {
      signedMessage: message,
      signature: base64.decode(outcome.signature.slice(SIMPLE_PREFIX.length)),
    };
  }

  /**
   * Signs (and with `send` broadcasts) a batch of dApp PSBTs under one approval. Every account
   * named must be a session account — inputs of both purposes may mix in one PSBT, each sign entry
   * carries its account's template — and `chain`, when given, must be the session's network.
   */
  private async signTransactions(
    caller: ConnectionOrigin,
    request: BitcoinRequest,
    send: boolean,
  ): Promise<unknown> {
    const network = request.network ?? this.options.bitcoinNetwork();
    this.options.connections.authorize(caller.origin, network, request.method);
    const binding = this.options.connections.sessionAccounts(caller.origin, network);
    if (binding === undefined) {
      throw new ProviderError(4100, "no bitcoin account for this origin");
    }
    const inputs = transactionInputs(request.params);
    if (send && inputs.some((input) => input.chain === undefined)) {
      throw invalidParams("chain is required for bitcoin:signAndSendTransaction");
    }
    if (
      inputs.some(
        (input) => input.chain !== undefined && BITCOIN_CHAIN_IDS[input.chain] !== network,
      )
    ) {
      throw invalidParams("chain is not the connected network");
    }
    const templateOf = (address: string): BitcoinAccount["template"] => {
      const purpose = BITCOIN_PURPOSES.find(
        (p) => binding.addresses[BITCOIN_PURPOSES.indexOf(p)] === address,
      );
      if (purpose === undefined) {
        throw new ProviderError(4100, "account is not a connected account");
      }
      return TEMPLATES[purpose];
    };
    let outcome: Awaited<ReturnType<BitcoinRequests["outcome"]>>;
    try {
      const pending = await this.options.requests.prepare({
        method: "bitcoin-sign",
        origin: caller,
        account: binding.group,
        network,
        request: {
          kind: "psbt",
          psbts: inputs.map(({ psbt, inputsToSign }): BitcoinPsbtInput => ({
            psbt,
            sign: inputsToSign.flatMap(({ address, signingIndexes, sigHash }) =>
              signingIndexes.map((index) => ({
                index,
                sigHash,
                template: templateOf(address),
              })),
            ),
          })),
          send,
        },
      });
      outcome = await this.options.requests.outcome(pending.id);
    } catch (error) {
      throw toProviderError(error);
    }
    if (!("kind" in outcome) || outcome.kind !== "bitcoin.psbts") {
      throw new ProviderError(-32603, "the bitcoin-sign request settled unexpectedly");
    }
    if (send && outcome.stopped !== undefined) {
      throw batchStopped(outcome.stopped, outcome.txids);
    }
    return send
      ? outcome.txids.map((txId, index) => {
          const signedPsbt = outcome.signedPsbts[index];
          if (signedPsbt === undefined) {
            throw internalError("a broadcast transaction has no signed PSBT");
          }
          return { txId, signedPsbt };
        })
      : outcome.signedPsbts.map((signedPsbt) => ({ signedPsbt }));
  }

  /**
   * A `change` event's accounts, derived only from the session after the write: the binding's
   * `payment` and `ordinals` accounts — empty when the session is gone or none are bound.
   */
  private async sessionAccountsChanged(
    session: ConnectionSession | undefined,
  ): Promise<BitcoinWalletAccount[]> {
    const network = this.options.bitcoinNetwork();
    const binding = sessionAccounts(session, network);
    if (binding === undefined) {
      return [];
    }
    try {
      const accounts = await Promise.all(
        BITCOIN_PURPOSES.map(async (purpose, index) => {
          const account = await this.walletAccount(binding.group, network, purpose);
          return account.address === binding.addresses[index] ? account : undefined;
        }),
      );
      return accounts.filter((account) => account !== undefined);
    } catch {
      /* A session whose accounts cannot be derived or advertised changes to an empty list. */
      return [];
    }
  }
}

const isBytesEnvelope = (v: unknown): v is { __bytes: string } =>
  typeof v === "object" && v !== null && typeof (v as { __bytes?: unknown }).__bytes === "string";

const purposesOf = (params: unknown): BitcoinPurpose[] => {
  const raw =
    typeof params === "object" && params !== null
      ? (params as { purposes?: unknown }).purposes
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidParams("bitcoin:connect needs a non-empty purposes array");
  }
  return raw.map((purpose) => {
    const found = BITCOIN_PURPOSES.find((p) => p === purpose);
    if (found === undefined) {
      throw invalidParams("unknown purpose");
    }
    return found;
  });
};

const signMessageParams = (params: unknown): { address: string; message: Uint8Array } => {
  const { account, message } =
    typeof params === "object" && params !== null
      ? (params as { account?: unknown; message?: unknown })
      : {};
  if (typeof account !== "string") {
    throw invalidParams("bitcoin:signMessage needs the account address");
  }
  if (message instanceof Uint8Array) {
    return { address: account, message };
  }
  if (isBytesEnvelope(message) && /^(?:[0-9a-fA-F]{2})*$/.test(message.__bytes)) {
    return { address: account, message: hexToBytes(message.__bytes) };
  }
  throw invalidParams("bitcoin:signMessage needs Uint8Array message bytes");
};

type TransactionInput = {
  readonly psbt: Uint8Array;
  readonly chain: string | undefined;
  readonly inputsToSign: ReadonlyArray<{
    readonly address: string;
    readonly signingIndexes: ReadonlyArray<number>;
    readonly sigHash: BitcoinSigHash;
  }>;
};

const bytesOf = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) {
    return value;
  }
  return isBytesEnvelope(value) && /^(?:[0-9a-fA-F]{2})*$/.test(value.__bytes)
    ? hexToBytes(value.__bytes)
    : undefined;
};

const sigHashOf = (value: unknown): BitcoinSigHash => {
  if (value === undefined || value === "ALL") {
    return "ALL";
  }
  if (value === "SINGLE|ANYONECANPAY") {
    return value;
  }
  throw invalidParams("sigHash must be ALL or SINGLE|ANYONECANPAY");
};

/** The wire shape of `bitcoin:signTransaction` inputs: accounts arrive as their addresses. */
const transactionInputs = (params: unknown): ReadonlyArray<TransactionInput> => {
  const raw =
    typeof params === "object" && params !== null
      ? (params as { inputs?: unknown }).inputs
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidParams("a bitcoin transaction call needs a non-empty inputs array");
  }
  return raw.map((entry: unknown): TransactionInput => {
    const { psbt, chain, inputsToSign } =
      typeof entry === "object" && entry !== null
        ? (entry as { psbt?: unknown; chain?: unknown; inputsToSign?: unknown })
        : {};
    const bytes = bytesOf(psbt);
    if (bytes === undefined || !Array.isArray(inputsToSign) || inputsToSign.length === 0) {
      throw invalidParams("each input needs psbt bytes and inputsToSign");
    }
    if (chain !== undefined && typeof chain !== "string") {
      throw invalidParams("chain must be a string");
    }
    return {
      psbt: bytes,
      chain,
      inputsToSign: inputsToSign.map((item: unknown) => {
        const { address, signingIndexes, sigHash } =
          typeof item === "object" && item !== null
            ? (item as { address?: unknown; signingIndexes?: unknown; sigHash?: unknown })
            : {};
        if (
          typeof address !== "string" ||
          !Array.isArray(signingIndexes) ||
          signingIndexes.length === 0 ||
          !signingIndexes.every((i) => Number.isSafeInteger(i) && i >= 0)
        ) {
          throw invalidParams("inputsToSign needs an account and signing indexes");
        }
        return { address, signingIndexes: signingIndexes.map(Number), sigHash: sigHashOf(sigHash) };
      }),
    };
  });
};

const byOrigin = (
  sessions: Readonly<Record<string, ConnectionSession>>,
): Map<string, ConnectionSession> =>
  new Map(Object.values(sessions).map((s) => [s.origin.origin, s]));

const bitcoinAccountList = (session: ConnectionSession): ReadonlyArray<string> =>
  Object.entries(session.scopes)
    .filter(([network]) => network.startsWith("bip122:"))
    .flatMap(([, scope]) => scope.accounts.map((a) => a.slice(a.lastIndexOf(":") + 1)));

/**
 * The origins whose `bip122` scope's accounts changed between the two snapshots, each with the
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
    const was = bitcoinAccountList(session).join(",");
    const is = now === undefined ? "" : bitcoinAccountList(now).join(",");
    if (was !== is) {
      events.push({ origin, session: now });
    }
  }
  for (const [origin, session] of next) {
    if (!prev.has(origin) && bitcoinAccountList(session).length > 0) {
      events.push({ origin, session });
    }
  }
  return events;
}
