import { hexToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import { BITCOIN_NETWORKS } from "../networks/registry.ts";
import type { RequestController } from "../requests/controller.ts";
import type { BitcoinAccount, BrowserOrigin } from "../requests/types.ts";
import type { BitcoinPurpose, ConnectionController, ConnectionSession } from "./controller.ts";
import { BITCOIN_METHODS, BITCOIN_PURPOSES } from "./controller.ts";
import { ProviderError, invalidParams } from "./errors.ts";
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
};

export type BitcoinHandler = {
  readonly handle: (origin: string, request: BitcoinRequest) => Promise<unknown>;
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
  | "bitcoinAccounts"
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
  readonly activeGroup: () =>
    | { readonly walletId: string; readonly groupIndex: number }
    | undefined;
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
        diffSessions(before, after).map(async ({ origin }): Promise<BitcoinEvent> => ({
          name: "bitcoinAccountsChanged",
          origin,
          accounts: await this.bitcoinAccountsChanged(),
        })),
      ),
    );
  }

  subscribe(listener: (event: BitcoinEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async handle(origin: string, request: BitcoinRequest): Promise<unknown> {
    const checked = this.options.connections.checkOrigin(origin);
    if (request.method === "bitcoin:connect") {
      return this.connect(checked, request);
    }
    if (request.method === "standard:disconnect") {
      await this.options.connections.revoke(origin);
      return {};
    }
    if (request.method === "bitcoin:signMessage") {
      return this.signMessage(checked, request);
    }
    throw invalidParams(`unsupported bitcoin method ${request.method}`);
  }

  private async connect(
    checked: BrowserOrigin,
    request: BitcoinRequest,
  ): Promise<{ accounts: ReadonlyArray<BitcoinWalletAccount> }> {
    const purposes = purposesOf(request.params);
    const network = this.options.bitcoinNetwork();
    const known = this.options.connections.bitcoinAccounts(checked.origin, network) !== undefined;
    await (known
      ? this.options.connections.touch(checked.origin)
      : this.options.connections.request(checked.origin, { kind: "connect", namespace: "bip122" }));
    const group = this.options.activeGroup();
    if (group === undefined) {
      throw new ProviderError(4100, "no account group is selected");
    }
    const accounts = await Promise.all(
      purposes.map(async (purpose) => this.walletAccount(group, network, purpose)),
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
  private async signMessage(checked: BrowserOrigin, request: BitcoinRequest): Promise<unknown> {
    const network = this.options.bitcoinNetwork();
    this.options.connections.authorize(checked.origin, network, "bitcoin:signMessage");
    const accounts = this.options.connections.bitcoinAccounts(checked.origin, network);
    if (accounts === undefined) {
      throw new ProviderError(4100, "no bitcoin account for this origin");
    }
    const { address, message } = signMessageParams(request.params);
    const purpose = BITCOIN_PURPOSES.find((p) => accounts[p] === address);
    if (purpose === undefined) {
      throw new ProviderError(4100, "account is not a connected account");
    }
    const text = utf8Text(message);
    if (text === undefined) {
      throw new ProviderError(4200, BLIND_SIGNING_MESSAGE);
    }
    const group = this.options.activeGroup();
    if (group === undefined) {
      throw new ProviderError(4100, "no account group is selected");
    }
    const account: BitcoinAccount = { ...group, address, template: TEMPLATES[purpose] };
    const pending = await this.options.requests.prepare({
      method: "bitcoin-sign",
      origin: checked,
      account,
      network,
      request: { kind: "message", message: text },
    });
    const outcome = await this.options.requests.outcome(pending.id);
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

  /** The `setActiveGroup` re-point: the bitcoin session's new accounts, `payment` then `ordinals`. */
  async bitcoinAccountsChanged(): Promise<BitcoinWalletAccount[]> {
    const network = this.options.bitcoinNetwork();
    const group = this.options.activeGroup();
    if (group === undefined) {
      return [];
    }
    return Promise.all(
      BITCOIN_PURPOSES.map(async (purpose) => this.walletAccount(group, network, purpose)),
    );
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

const byOrigin = (
  sessions: Readonly<Record<string, ConnectionSession>>,
): Map<string, ConnectionSession> =>
  new Map(Object.values(sessions).map((s) => [s.origin.origin, s]));

const bitcoinAccountList = (session: ConnectionSession): ReadonlyArray<string> =>
  Object.entries(session.scopes)
    .filter(([network]) => network.startsWith("bip122:"))
    .flatMap(([, scope]) => scope.accounts.map((a) => a.slice(a.lastIndexOf(":") + 1)));

function diffSessions(
  before: Readonly<Record<string, ConnectionSession>>,
  after: Readonly<Record<string, ConnectionSession>>,
): ReadonlyArray<{ origin: string }> {
  const events: Array<{ origin: string }> = [];
  const prev = byOrigin(before);
  const next = byOrigin(after);
  for (const [origin, session] of prev) {
    const now = next.get(origin);
    const was = bitcoinAccountList(session).join(",");
    const is = now === undefined ? "" : bitcoinAccountList(now).join(",");
    if (was !== is) {
      events.push({ origin });
    }
  }
  for (const [origin, session] of next) {
    if (!prev.has(origin) && bitcoinAccountList(session).length > 0) {
      events.push({ origin });
    }
  }
  return events;
}
