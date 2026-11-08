import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * Platform-neutral EIP-1193 provider logic: it knows nothing about WebViews. The host hands it a
 * page's origin (computed from the WebView's top-level URL, never from the page) and a JSON-RPC
 * call; signing goes through the request pipeline and waits for the host's approval by id.
 */
import { ChainError } from "@qntx/wallet-chains";
import type { SignRequest } from "@qntx/wallet-chains";

import { EVM_RPC_METHODS } from "../gateway/contract/rpc.ts";
import type { NetworkController } from "../networks/controller.ts";
import {
  BlindSigningDisabledError,
  InvalidTokenError,
  OriginBusyError,
  RequestEndedError,
  SignInOriginError,
} from "../requests/controller.ts";
import type { RequestController } from "../requests/controller.ts";
import type {
  AccountRef,
  BatchRecord,
  DelegationStatus,
  TrackedTransaction,
} from "../transactions/route.ts";
import { EVM_BATCH_LIMIT } from "../transactions/route.ts";
import type { AccountGroup, ConnectionController, ConnectionSession } from "./controller.ts";
import { evmChainId } from "./controller.ts";
import {
  ProviderError,
  internalError,
  invalidParams,
  unauthorized,
  unrecognizedChain,
  unsupportedMethod,
  userRejectedRequest,
} from "./errors.ts";
import { SessionEvents } from "./subscription.ts";

export type Eip1193Request = { readonly method: string; readonly params?: unknown };

export type Eip1193Event =
  | { readonly name: "connect"; readonly origin: string; readonly chainId: string }
  | {
      readonly name: "accountsChanged";
      readonly origin: string;
      readonly accounts: ReadonlyArray<string>;
    }
  | { readonly name: "chainChanged"; readonly origin: string; readonly chainId: string }
  | { readonly name: "disconnect"; readonly origin: string };

export type Eip1193HandlerOptions = {
  readonly connections: ConnectionController;
  readonly requests: RequestController;
  readonly networks: NetworkController;
  /** The network an unconnected page sees. */
  readonly defaultNetwork: () => string;
  /** Whether a token is already in the built-in table or the user's custom tokens. */
  readonly isTracked: (network: string, address: string) => boolean;
  /** The account's EIP-7702 delegation state on `network`. */
  readonly delegationState: (account: AccountRef, network: string) => Promise<DelegationStatus>;
  /** `wallet_sendCalls` bundles, keyed by their id. */
  readonly batches: {
    readonly record: (record: BatchRecord) => Promise<void>;
    readonly get: (origin: string, id: string) => BatchRecord | undefined;
    readonly find: (id: string) => BatchRecord | undefined;
  };
  /** A tracked transaction by id — `wallet_getCallsStatus` aggregates them. */
  readonly txById: (id: string) => TrackedTransaction | undefined;
  /** The host shows a bundle's status page; `wallet_showCallsStatus` is the trigger. */
  readonly showCallsStatus: (request: {
    readonly origin: string;
    readonly txIds: ReadonlyArray<string>;
  }) => void;
  readonly now: () => number;
  readonly random: (length: number) => Uint8Array;
};

/** Refused outright, whatever the session. */
const REFUSED: ReadonlySet<string> = new Set([
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTransaction",
  "eth_sendRawTransaction",
]);

const READ_ONLY: ReadonlySet<string> = new Set(
  EVM_RPC_METHODS.filter((m) => m !== "eth_sendRawTransaction" && m !== "eth_chainId"),
);

const hexChainId = (network: string): string => `0x${(evmChainId(network) ?? 0).toString(16)}`;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const paramList = (params: unknown): ReadonlyArray<unknown> => {
  if (params === undefined) {
    return [];
  }
  if (!Array.isArray(params)) {
    throw invalidParams("params must be an array");
  }
  return params;
};

const textBytes = (value: unknown): Uint8Array => {
  if (typeof value !== "string") {
    throw invalidParams("message must be a string");
  }
  if (/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    return hexToBytes(value.slice(2));
  }
  return new TextEncoder().encode(value);
};

const quantityOf = (value: unknown, field: string, fallback: string): string => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw invalidParams(`${field} must be a 0x quantity`);
  }
  return value;
};

export class Eip1193Handler {
  private readonly options: Eip1193HandlerOptions;
  private readonly events: SessionEvents<Eip1193Event>;

  constructor(options: Eip1193HandlerOptions) {
    this.options = options;
    this.events = new SessionEvents(options.connections, diffSessions);
  }

  /** Events for the host to forward to pages; derived from changes to the sessions. */
  subscribe(listener: (event: Eip1193Event) => void): () => void {
    return this.events.subscribe(listener);
  }

  async handle(origin: string, request: Eip1193Request): Promise<unknown> {
    const { connections } = this.options;
    connections.checkOrigin(origin);
    const { method } = request;
    if (method === "wallet_watchAsset") {
      return this.watchAsset(origin, request.params);
    }
    const params = paramList(request.params);
    if (REFUSED.has(method)) {
      throw unsupportedMethod(method);
    }
    switch (method) {
      case "eth_accounts":
        return connections.accounts(origin);
      case "eth_chainId":
        return hexChainId(
          connections.session(origin)?.currentNetwork ?? this.options.defaultNetwork(),
        );
      case "eth_requestAccounts":
        return this.requestAccounts(origin);
      case "wallet_requestPermissions":
        await this.requestAccounts(origin);
        return this.permissions(origin);
      case "wallet_getPermissions":
        return this.permissions(origin);
      case "wallet_revokePermissions":
        await connections.revoke(origin);
        return null;
      case "wallet_switchEthereumChain":
        return this.switchChain(origin, params[0]);
      case "wallet_addEthereumChain":
        return this.addChain(origin, params[0]);
      case "personal_sign":
        return this.personalSign(origin, params);
      case "eth_signTypedData_v4":
        return this.typedData(origin, params);
      case "eth_sendTransaction":
        return this.sendTransaction(origin, params[0]);
      case "wallet_getCapabilities":
        return this.getCapabilities(origin, params);
      case "wallet_sendCalls":
        return this.sendCalls(origin, params);
      case "wallet_getCallsStatus":
        return this.callsStatus(origin, params, false);
      case "wallet_showCallsStatus":
        return this.callsStatus(origin, params, true);
      default:
        break;
    }
    if (READ_ONLY.has(method)) {
      return this.read(origin, method, params);
    }
    throw new ProviderError(-32601, `${method} does not exist`);
  }

  private async requestAccounts(origin: string): Promise<ReadonlyArray<string>> {
    const { connections } = this.options;
    if (connections.accounts(origin).length === 0) {
      await connections.request(origin, { kind: "connect" });
    }
    await connections.touch(origin);
    return connections.accounts(origin);
  }

  private permissions(origin: string): ReadonlyArray<unknown> {
    const accounts = this.options.connections.accounts(origin);
    if (accounts.length === 0) {
      return [];
    }
    return [
      {
        parentCapability: "eth_accounts",
        invoker: origin,
        caveats: [{ type: "restrictReturnedAccounts", value: accounts }],
      },
    ];
  }

  private async switchChain(origin: string, arg: unknown): Promise<unknown> {
    const { connections } = this.options;
    const chainId = isObject(arg) ? arg["chainId"] : undefined;
    if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId)) {
      throw invalidParams("chainId must be a 0x quantity");
    }
    const network = `eip155:${Number.parseInt(chainId, 16)}`;
    if (!connections.isEnabled(network)) {
      throw unrecognizedChain(`chain ${chainId} is not enabled`);
    }
    const session = connections.session(origin);
    if (session === undefined) {
      throw unauthorized();
    }
    if (session.scopes[network] === undefined) {
      await connections.request(origin, { kind: "network", network });
    } else if (session.currentNetwork !== network) {
      await connections.setCurrentNetwork(origin, network);
    }
    return null;
  }

  /**
   * EIP-3085. The chain must already be a network the wallet enables; the page's `rpcUrls` are
   * validated for shape and never read or used — custom endpoints are the user's setting.
   */
  private async addChain(origin: string, arg: unknown): Promise<unknown> {
    const { connections } = this.options;
    if (!isObject(arg)) {
      throw invalidParams("the chain parameter must be an object");
    }
    const { chainId, chainName, nativeCurrency, rpcUrls } = arg;
    if (typeof chainId !== "string" || !/^0x[1-9a-f][0-9a-f]*$/i.test(chainId)) {
      throw invalidParams("chainId must be a 0x quantity without leading zeros");
    }
    if (typeof chainName !== "string" || chainName === "") {
      throw invalidParams("chainName must be a non-empty string");
    }
    if (
      !isObject(nativeCurrency) ||
      typeof nativeCurrency["name"] !== "string" ||
      nativeCurrency["name"] === "" ||
      typeof nativeCurrency["symbol"] !== "string" ||
      nativeCurrency["symbol"].length < 2 ||
      nativeCurrency["symbol"].length > 6 ||
      nativeCurrency["decimals"] !== 18
    ) {
      throw invalidParams("nativeCurrency must be { name, symbol (2-6 characters), decimals: 18 }");
    }
    if (
      !Array.isArray(rpcUrls) ||
      rpcUrls.length === 0 ||
      !rpcUrls.every((url) => typeof url === "string")
    ) {
      throw invalidParams("rpcUrls must be a non-empty array of strings");
    }
    const network = `eip155:${Number.parseInt(chainId, 16)}`;
    if (!connections.isEnabled(network)) {
      throw unrecognizedChain(`chain ${chainId} is not enabled`);
    }
    const session = connections.session(origin);
    if (session !== undefined && session.scopes[network] === undefined) {
      await connections.request(origin, { kind: "network", network, activate: false });
    }
    return null;
  }

  /** EIP-747 (ERC-20 only): `symbol`, `decimals` and `image` from the page are never used. */
  private async watchAsset(origin: string, arg: unknown): Promise<boolean> {
    const { connections, requests } = this.options;
    const session = this.signingSession(origin, "wallet_watchAsset");
    if (!isObject(arg) || arg["type"] !== "ERC20" || !isObject(arg["options"])) {
      throw invalidParams("params must be { type: 'ERC20', options: { address } }");
    }
    const { options } = arg;
    const { address, chainId } = options;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw invalidParams("options.address must be an EVM address");
    }
    const { currentNetwork: network } = session;
    if (chainId !== undefined && Number(chainId) !== evmChainId(network)) {
      throw invalidParams("options.chainId does not match the session network");
    }
    if (this.options.isTracked(network, address)) {
      return true;
    }
    const group: AccountGroup | undefined = connections.activeGroup();
    if (group === undefined) {
      throw internalError("no account group is selected");
    }
    try {
      const pending = await requests.prepare({
        method: "watch-asset",
        origin: { kind: "browser", origin },
        account: { kind: "hd", ...group, template: "evm.bip44" },
        network,
        address,
      });
      await requests.outcome(pending.id);
      await connections.touch(origin);
      return true;
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private authorizedAccount(session: ConnectionSession, address: unknown): string {
    const accounts = this.options.connections.accounts(session.origin.origin);
    const wanted = typeof address === "string" ? address.toLowerCase() : accounts[0];
    if (wanted === undefined || !accounts.some((a) => a.toLowerCase() === wanted.toLowerCase())) {
      throw unauthorized("account not authorized");
    }
    return wanted;
  }

  private async personalSign(origin: string, params: ReadonlyArray<unknown>): Promise<string> {
    const session = this.signingSession(origin, "personal_sign");
    this.authorizedAccount(session, params[1]);
    const message = textBytes(params[0]);
    return this.sign(origin, session, (account) => ({
      kind: "evm.personal-message",
      network: session.currentNetwork,
      account,
      message,
    }));
  }

  private async typedData(origin: string, params: ReadonlyArray<unknown>): Promise<string> {
    const session = this.signingSession(origin, "eth_signTypedData_v4");
    this.authorizedAccount(session, params[0]);
    const [, source] = params;
    const typedData = typeof source === "string" ? source : JSON.stringify(source);
    return this.sign(origin, session, (account) => ({
      kind: "evm.typed-data",
      network: session.currentNetwork,
      account,
      typedData,
    }));
  }

  private async sendTransaction(origin: string, arg: unknown): Promise<string> {
    const session = this.signingSession(origin, "eth_sendTransaction");
    if (!isObject(arg)) {
      throw invalidParams("transaction must be an object");
    }
    this.authorizedAccount(session, arg["from"]);
    const chainId = evmChainId(session.currentNetwork);
    if (chainId === undefined) {
      throw internalError("session network is not an EVM network");
    }
    if (arg["chainId"] !== undefined && Number(arg["chainId"]) !== chainId) {
      throw invalidParams("transaction chainId does not match the session network");
    }
    const data = arg["data"] ?? arg["input"] ?? "0x";
    if (typeof data !== "string") {
      throw invalidParams("data must be a hex string");
    }
    const { to } = arg;
    if (to !== undefined && typeof to !== "string") {
      throw invalidParams("to must be an address");
    }
    // Only to, value, data and gas survive; nonce and fees are placeholders the pipeline replaces.
    return this.sign(origin, session, (account) => ({
      kind: "evm.transaction",
      network: session.currentNetwork,
      account,
      tx: {
        type: "eip1559",
        chainId,
        nonce: 0,
        gas: quantityOf(arg["gas"], "gas", "0x0"),
        value: quantityOf(arg["value"], "value", "0x0"),
        data,
        ...(to === undefined ? {} : { to }),
        accessList: [],
        maxFeePerGas: "0x0",
        maxPriorityFeePerGas: "0x0",
      },
    }));
  }

  private signingSession(origin: string, method: string): ConnectionSession {
    const { connections } = this.options;
    const session = connections.session(origin);
    if (session === undefined) {
      throw unauthorized();
    }
    return connections.authorize(origin, session.currentNetwork, method);
  }

  private async sign(
    origin: string,
    session: ConnectionSession,
    build: (account: AccountRef) => SignRequest,
  ): Promise<string> {
    const { connections, requests } = this.options;
    const group: AccountGroup | undefined = connections.activeGroup();
    if (group === undefined) {
      throw internalError("no account group is selected");
    }
    const account = { kind: "hd", ...group, template: "evm.bip44" } as const;
    try {
      const pending = await requests.prepare({
        method: "evm-sign",
        origin: { kind: "browser", origin },
        account,
        network: session.currentNetwork,
        request: build(account),
      });
      const result = await requests.outcome(pending.id);
      await connections.touch(origin);
      if ("signature" in result && result.signature instanceof Uint8Array) {
        return `0x${bytesToHex(result.signature)}`;
      }
      if (!("hash" in result) || typeof result.hash !== "string") {
        throw internalError("the transaction has no hash");
      }
      return result.hash;
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private requiredSession(origin: string): ConnectionSession {
    const session = this.options.connections.session(origin);
    if (session === undefined) {
      throw unauthorized();
    }
    return session;
  }

  private accountFor(group: AccountGroup) {
    return { kind: "hd", ...group, template: "evm.bip44" } as const;
  }

  /**
   * EIP-5792 `wallet_getCapabilities`: `atomic` per chain the page asks about or its session
   * covers.
   */
  private async getCapabilities(
    origin: string,
    params: ReadonlyArray<unknown>,
  ): Promise<Record<string, unknown>> {
    const session = this.requiredSession(origin);
    const [address0, asked] = params;
    this.authorizedAccount(session, address0);
    const networks =
      asked === undefined
        ? Object.keys(session.scopes).filter((s) => s.startsWith("eip155:"))
        : (() => {
            if (!Array.isArray(asked) || !asked.every((c) => typeof c === "string")) {
              throw invalidParams("chainIds must be an array of hex chain ids");
            }
            return asked.map((c) => `eip155:${Number.parseInt(c, 16)}`);
          })();
    const group = this.options.connections.activeGroup();
    if (group === undefined) {
      throw internalError("no account group is selected");
    }
    const account = this.accountFor(group);
    const out: Record<string, unknown> = {};
    await Promise.all(
      networks.map(async (network) => {
        let status = "unsupported";
        try {
          if (evmChainId(network) !== undefined && this.options.connections.isEnabled(network)) {
            const s = await this.options.delegationState(account, network);
            status =
              s.supported && s.state === "ours"
                ? "supported"
                : s.supported && s.state === "none"
                  ? "ready"
                  : "unsupported";
          }
        } catch {
          /* a failed read is unsupported */
        }
        out[hexChainId(network)] = { atomic: { status } };
      }),
    );
    return out;
  }

  /** `wallet_sendCalls` (EIP-5792 v2.0.0): atomic batch, sequential fallback or 5760. */
  private async sendCalls(origin: string, params: ReadonlyArray<unknown>): Promise<unknown> {
    const session = this.signingSession(origin, "wallet_sendCalls");
    const [arg] = params;
    if (!isObject(arg)) {
      throw invalidParams("params must be a sendCalls object");
    }
    if (arg["version"] !== "2.0.0") {
      throw invalidParams('version must be "2.0.0"');
    }
    if (typeof arg["atomicRequired"] !== "boolean") {
      throw invalidParams("atomicRequired must be a boolean");
    }
    const chainId = evmChainId(session.currentNetwork);
    if (chainId === undefined) {
      throw internalError("session network is not an EVM network");
    }
    const askedChain = arg["chainId"];
    if (typeof askedChain !== "string" || Number(askedChain) !== chainId) {
      throw new ProviderError(5710, "chainId does not match the session network");
    }
    this.authorizedAccount(session, arg["from"]);
    const group = this.options.connections.activeGroup();
    if (group === undefined) {
      throw internalError("no account group is selected");
    }
    const account = this.accountFor(group);
    const rawCalls = arg["calls"];
    if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
      throw invalidParams("calls must be a non-empty array");
    }
    if (rawCalls.length > EVM_BATCH_LIMIT) {
      throw new ProviderError(5740, `a batch allows at most ${EVM_BATCH_LIMIT} calls`);
    }
    const checkCaps = (caps: unknown): void => {
      if (caps === undefined) {
        return;
      }
      if (!isObject(caps)) {
        throw invalidParams("capabilities must be an object");
      }
      for (const [name, value] of Object.entries(caps)) {
        if (!isObject(value) || value["optional"] !== true) {
          throw new ProviderError(5700, `capability ${name} is not supported`);
        }
      }
    };
    checkCaps(arg["capabilities"]);
    const calls = rawCalls.map((raw, index) => {
      if (!isObject(raw)) {
        throw invalidParams(`calls[${index}] must be an object`);
      }
      checkCaps(raw["capabilities"]);
      if (typeof raw["to"] !== "string") {
        throw invalidParams(`calls[${index}].to is required`);
      }
      const rawData = raw["data"];
      if (
        rawData !== undefined &&
        (typeof rawData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(rawData))
      ) {
        throw invalidParams(`calls[${index}].data must be hex`);
      }
      const value = quantityOf(raw["value"], `calls[${index}].value`, "0x0");
      const data = typeof rawData === "string" && rawData !== "" ? rawData : "0x";
      return { to: raw["to"], data, value };
    });
    let id: string;
    const rawId = arg["id"];
    if (rawId === undefined) {
      id = `0x${bytesToHex(this.options.random(32))}`;
    } else {
      if (typeof rawId !== "string" || rawId.length === 0 || rawId.length > 4096) {
        throw invalidParams("id must be a string of at most 4096 characters");
      }
      if (this.options.batches.get(origin, rawId) !== undefined) {
        throw new ProviderError(5720, `bundle id ${rawId} is already used`);
      }
      id = rawId;
    }
    const { atomicRequired } = arg;
    const network = session.currentNetwork;
    const txIds: string[] = [];
    const atomic = calls.length > 1;
    try {
      const [first] = calls;
      if (calls.length === 1 && first !== undefined) {
        const tracked = await this.submitCall(origin, session, account, first);
        txIds.push(tracked.id);
      } else {
        const status = await this.options.delegationState(account, network);
        if (status.supported && status.state === "ours") {
          const tracked = await this.submitBatch(origin, session, account, calls);
          txIds.push(tracked.id);
        } else if (status.supported && status.state === "none") {
          const tracked = await this.submitBatch(origin, session, account, calls);
          txIds.push(tracked.id);
        } else if (atomicRequired) {
          throw new ProviderError(5760, "atomicity is not supported on this account");
        } else {
          for (const [index, tx] of calls.entries()) {
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop -- each call is approved separately, in order
              const tracked = await this.submitCall(origin, session, account, tx);
              txIds.push(tracked.id);
            } catch (error) {
              if (index === 0) {
                throw error;
              }
              break;
            }
          }
        }
      }
    } catch (error) {
      throw toProviderError(error);
    }
    await this.options.batches.record({
      origin,
      id,
      network,
      atomic,
      txIds,
      expected: calls.length,
      createdAt: this.options.now(),
    });
    return { id };
  }

  /** One call through the `evm-sign` transaction path — its own approval. */
  private async submitCall(
    origin: string,
    session: ConnectionSession,
    account: AccountRef,
    call: { to: string; data: string; value: string },
  ): Promise<TrackedTransaction> {
    const chainId = evmChainId(session.currentNetwork);
    const pending = await this.options.requests.prepare({
      method: "evm-sign",
      origin: { kind: "browser", origin },
      account,
      network: session.currentNetwork,
      request: {
        kind: "evm.transaction",
        network: session.currentNetwork,
        account,
        tx: {
          type: "eip1559",
          chainId: chainId ?? 0,
          nonce: 0,
          gas: "0x0",
          value: call.value,
          data: call.data,
          to: call.to,
          accessList: [],
          maxFeePerGas: "0x0",
          maxPriorityFeePerGas: "0x0",
        },
      },
    });
    const result = await this.options.requests.outcome(pending.id);
    await this.options.connections.touch(origin);
    if (!("id" in result)) {
      throw internalError("the transaction has no tracked id");
    }
    return result;
  }

  /** ≥2 calls through `evm-batch` with the page's origin. */
  private async submitBatch(
    origin: string,
    session: ConnectionSession,
    account: AccountRef,
    calls: ReadonlyArray<{ to: string; data: string; value: string }>,
  ): Promise<TrackedTransaction> {
    const pending = await this.options.requests.prepare({
      method: "evm-batch",
      origin: { kind: "browser", origin },
      account,
      network: session.currentNetwork,
      calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })),
      fee: "normal",
    });
    const result = await this.options.requests.outcome(pending.id);
    await this.options.connections.touch(origin);
    if (!("id" in result)) {
      throw internalError("the batch has no tracked id");
    }
    return result;
  }

  /** `wallet_getCallsStatus` / `wallet_showCallsStatus`: the record must belong to the origin. */
  private async callsStatus(
    origin: string,
    params: ReadonlyArray<unknown>,
    show: boolean,
  ): Promise<unknown> {
    this.requiredSession(origin);
    const [id] = params;
    if (typeof id !== "string") {
      throw invalidParams("id must be a string");
    }
    const record = this.options.batches.get(origin, id);
    if (record === undefined) {
      throw new ProviderError(5730, `unknown bundle id ${id}`);
    }
    if (show) {
      this.options.showCallsStatus({ origin, txIds: record.txIds });
      return null;
    }
    const txs = record.txIds
      .map((txId) => this.options.txById(txId))
      .filter((tx): tx is TrackedTransaction => tx !== undefined);
    const pending = txs.some(
      (tx) =>
        tx.state === "pending" ||
        tx.state === "submitted" ||
        tx.state === "signed" ||
        tx.state === "draft",
    );
    const allConfirmed =
      txs.length === record.expected && txs.every((tx) => tx.state === "confirmed");
    const noneReached =
      txs.length > 0 &&
      txs.every(
        (tx) =>
          (tx.state === "rejected" || tx.state === "dropped" || tx.state === "failed") &&
          tx.hash === undefined,
      );
    const allReverted =
      txs.length > 0 && txs.every((tx) => tx.hash !== undefined && tx.state === "failed");
    const status = pending ? 100 : allConfirmed ? 200 : noneReached ? 400 : allReverted ? 500 : 600;
    const mined = txs.filter((tx) => tx.hash !== undefined);
    const fetched = await Promise.all(
      mined.map(async (tx) => {
        try {
          const receipt: unknown = await this.options.networks
            .client(record.network)
            .transport.request({ method: "eth_getTransactionReceipt", params: [tx.hash] });
          return isObject(receipt)
            ? {
                logs: Array.isArray(receipt["logs"]) ? receipt["logs"] : [],
                status: receipt["status"],
                blockHash: receipt["blockHash"],
                blockNumber: receipt["blockNumber"],
                gasUsed: receipt["gasUsed"],
                transactionHash: tx.hash,
              }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const receipts = fetched.filter((r): r is NonNullable<typeof r> => r !== undefined);
    return {
      version: "2.0.0",
      id: record.id,
      chainId: hexChainId(record.network),
      atomic: record.atomic,
      status,
      ...(receipts.length > 0 ? { receipts } : {}),
    };
  }

  private async read(
    origin: string,
    method: string,
    params: ReadonlyArray<unknown>,
  ): Promise<unknown> {
    const { connections, networks } = this.options;
    const network = connections.session(origin)?.currentNetwork ?? this.options.defaultNetwork();
    try {
      return await networks.client(network).transport.request({ method, params: [...params] });
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof BlindSigningDisabledError) {
    return new ProviderError(4200, error.message);
  }
  if (error instanceof InvalidTokenError || error instanceof SignInOriginError) {
    return invalidParams(error.message);
  }
  if (error instanceof OriginBusyError) {
    return userRejectedRequest(error.message);
  }
  if (error instanceof RequestEndedError) {
    return error.stage === "failed"
      ? internalError(error.message)
      : userRejectedRequest(error.message);
  }
  if (error instanceof ChainError) {
    return invalidParams(error.message);
  }
  return internalError(error instanceof Error ? error.message : String(error));
}

function currentAccounts(session: ConnectionSession): ReadonlyArray<string> {
  return (
    session.scopes[session.currentNetwork]?.accounts.map((a) => a.slice(a.lastIndexOf(":") + 1)) ??
    []
  );
}

const byOrigin = (sessions: Readonly<Record<string, ConnectionSession>>) =>
  new Map(Object.values(sessions).map((s) => [s.origin.origin, s]));

function diffSessions(
  before: Readonly<Record<string, ConnectionSession>>,
  after: Readonly<Record<string, ConnectionSession>>,
): ReadonlyArray<Eip1193Event> {
  const events: Eip1193Event[] = [];
  const prev = byOrigin(before);
  const next = byOrigin(after);
  for (const [origin, session] of prev) {
    const now = next.get(origin);
    if (now === undefined) {
      events.push({ name: "disconnect", origin });
      continue;
    }
    if (now.currentNetwork !== session.currentNetwork) {
      events.push({ name: "chainChanged", origin, chainId: hexChainId(now.currentNetwork) });
    }
    const was = currentAccounts(session).join(",");
    const is = currentAccounts(now).join(",");
    if (was !== is) {
      events.push({ name: "accountsChanged", origin, accounts: currentAccounts(now) });
    }
  }
  for (const [origin, session] of next) {
    if (!prev.has(origin)) {
      events.push({ name: "connect", origin, chainId: hexChainId(session.currentNetwork) });
      const accounts = currentAccounts(session);
      if (accounts.length > 0) {
        // A fresh session's accounts went from [] to the granted set — an accountsChanged, so a
        // page listening for it (standard EIP-1193 on-connect behavior) is notified too.
        events.push({ name: "accountsChanged", origin, accounts });
      }
    }
  }
  return events;
}
