import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * Platform-neutral EIP-1193 provider logic: it knows nothing about WebViews. The host hands it a
 * page's origin (computed from the WebView's top-level URL, never from the page) and a JSON-RPC
 * call; signing goes through the request pipeline and waits for the host's approval by id.
 */
import type { SignRequest } from "@qntx/wallet-chains";

import { EVM_RPC_METHODS, logsFilterViolation } from "../gateway/contract/rpc.ts";
import type { NetworkController } from "../networks/controller.ts";
import type { RequestController } from "../requests/controller.ts";
import type { WalletConnectOrigin } from "../requests/types.ts";
import type {
  AccountRef,
  BatchRecord,
  DelegationStatus,
  TrackedTransaction,
} from "../transactions/route.ts";
import { EVM_BATCH_LIMIT } from "../transactions/route.ts";
import type {
  AccountGroup,
  ConnectionController,
  ConnectionOrigin,
  ConnectionSession,
} from "./controller.ts";
import { evmChainId } from "./controller.ts";
import {
  ProviderError,
  internalError,
  invalidParams,
  limitExceeded,
  toProviderError,
  unauthorized,
  unrecognizedChain,
  unsupportedMethod,
} from "./errors.ts";
import { SessionEvents } from "./subscription.ts";

export type Eip1193Request = {
  readonly method: string;
  readonly params?: unknown;
  /**
   * The CAIP-2 network the call targets — a WalletConnect request names it; the in-app-browser
   * bridge never sets it (the page has no say), so its calls use the session's current network.
   */
  readonly network?: string;
};

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

/** The RPC of a network never comes from a page: only the user can enable one. */
const chainNotEnabled = (chainId: string): ProviderError =>
  unrecognizedChain(
    `chain ${chainId} is not enabled in the wallet; enable the network in the wallet first`,
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

  async handle(origin: string | WalletConnectOrigin, request: Eip1193Request): Promise<unknown> {
    const { connections } = this.options;
    const caller = connections.checkOrigin(origin);
    const { method } = request;
    if (method === "wallet_watchAsset") {
      return this.watchAsset(caller, request.network, request.params);
    }
    const params = paramList(request.params);
    if (REFUSED.has(method)) {
      throw unsupportedMethod(method);
    }
    switch (method) {
      case "eth_accounts":
        return this.accounts(caller.origin);
      case "eth_chainId":
        return hexChainId(
          connections.session(caller.origin)?.currentNetwork ?? this.options.defaultNetwork(),
        );
      case "eth_requestAccounts":
        return this.requestAccounts(caller.origin);
      case "wallet_requestPermissions":
        await this.requestAccounts(caller.origin);
        return this.permissions(caller.origin);
      case "wallet_getPermissions":
        return this.permissions(caller.origin);
      case "wallet_revokePermissions":
        await connections.revoke(caller.origin);
        return null;
      case "wallet_switchEthereumChain":
        return this.switchChain(caller.origin, params[0]);
      case "wallet_addEthereumChain":
        return this.addChain(caller.origin, params[0]);
      case "personal_sign":
        return this.personalSign(caller, request.network, params);
      case "eth_signTypedData_v4":
        return this.typedData(caller, request.network, params);
      case "eth_sendTransaction":
        return this.sendTransaction(caller, request.network, params[0]);
      case "wallet_getCapabilities":
        return this.getCapabilities(caller.origin, params);
      case "wallet_sendCalls":
        return this.sendCalls(caller, request.network, params);
      case "wallet_getCallsStatus":
        return this.callsStatus(caller.origin, params, false);
      case "wallet_showCallsStatus":
        return this.callsStatus(caller.origin, params, true);
      default:
        break;
    }
    if (method === "eth_getLogs") {
      const violation = logsFilterViolation(params);
      if (violation !== undefined) {
        throw limitExceeded(violation);
      }
    }
    if (READ_ONLY.has(method)) {
      return this.read(caller.origin, method, params);
    }
    throw new ProviderError(-32601, `${method} does not exist`);
  }

  /** The session's bound accounts on its current network — the page's `eth_accounts`. */
  private accounts(origin: string): ReadonlyArray<string> {
    const { connections } = this.options;
    const session = connections.session(origin);
    return connections.sessionAccounts(origin, session?.currentNetwork ?? "")?.addresses ?? [];
  }

  private async requestAccounts(origin: string): Promise<ReadonlyArray<string>> {
    const { connections } = this.options;
    if (this.accounts(origin).length === 0) {
      await connections.request(origin, { kind: "connect" });
    }
    await connections.touch(origin);
    return this.accounts(origin);
  }

  private permissions(origin: string): ReadonlyArray<unknown> {
    const accounts = this.accounts(origin);
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
      throw chainNotEnabled(chainId);
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
      throw chainNotEnabled(chainId);
    }
    const session = connections.session(origin);
    if (session !== undefined && session.scopes[network] === undefined) {
      await connections.request(origin, { kind: "network", network, activate: false });
    }
    return null;
  }

  /** EIP-747 (ERC-20 only): `symbol`, `decimals` and `image` from the page are never used. */
  private async watchAsset(
    caller: ConnectionOrigin,
    network: string | undefined,
    arg: unknown,
  ): Promise<boolean> {
    const { connections, requests } = this.options;
    const session = this.signingSession(caller, "wallet_watchAsset", network);
    if (!isObject(arg) || arg["type"] !== "ERC20" || !isObject(arg["options"])) {
      throw invalidParams("params must be { type: 'ERC20', options: { address } }");
    }
    const { options } = arg;
    const { address, chainId } = options;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw invalidParams("options.address must be an EVM address");
    }
    if (chainId !== undefined && Number(chainId) !== evmChainId(session.currentNetwork)) {
      throw invalidParams("options.chainId does not match the session network");
    }
    if (this.options.isTracked(session.currentNetwork, address)) {
      return true;
    }
    const binding = connections.sessionAccounts(caller.origin, session.currentNetwork);
    if (binding === undefined) {
      throw unauthorized("no account is bound to the session network");
    }
    try {
      const pending = await requests.prepare({
        method: "watch-asset",
        origin: caller,
        account: { kind: "hd", ...binding.group, template: "evm.bip44" },
        network: session.currentNetwork,
        address,
      });
      await requests.outcome(pending.id);
      await connections.touch(caller.origin);
      return true;
    } catch (error) {
      throw toProviderError(error);
    }
  }

  /** The address the page named, checked against the session binding on its current network. */
  private authorizedAccount(
    session: ConnectionSession,
    address: unknown,
  ): { readonly group: AccountGroup; readonly address: string } {
    const binding = this.options.connections.sessionAccounts(
      session.origin.origin,
      session.currentNetwork,
    );
    const wanted =
      typeof address === "string" ? address.toLowerCase() : binding?.addresses[0]?.toLowerCase();
    if (
      binding === undefined ||
      wanted === undefined ||
      !binding.addresses.some((a) => a.toLowerCase() === wanted)
    ) {
      throw unauthorized("account not authorized");
    }
    return { group: binding.group, address: wanted };
  }

  private async personalSign(
    caller: ConnectionOrigin,
    network: string | undefined,
    params: ReadonlyArray<unknown>,
  ): Promise<string> {
    const session = this.signingSession(caller, "personal_sign", network);
    const { group } = this.authorizedAccount(session, params[1]);
    const message = textBytes(params[0]);
    return this.sign(caller, session, group, (account) => ({
      kind: "evm.personal-message",
      network: session.currentNetwork,
      account,
      message,
    }));
  }

  private async typedData(
    caller: ConnectionOrigin,
    network: string | undefined,
    params: ReadonlyArray<unknown>,
  ): Promise<string> {
    const session = this.signingSession(caller, "eth_signTypedData_v4", network);
    const { group } = this.authorizedAccount(session, params[0]);
    const [, source] = params;
    const typedData = typeof source === "string" ? source : JSON.stringify(source);
    return this.sign(caller, session, group, (account) => ({
      kind: "evm.typed-data",
      network: session.currentNetwork,
      account,
      typedData,
    }));
  }

  private async sendTransaction(
    caller: ConnectionOrigin,
    network: string | undefined,
    arg: unknown,
  ): Promise<string> {
    const session = this.signingSession(caller, "eth_sendTransaction", network);
    if (!isObject(arg)) {
      throw invalidParams("transaction must be an object");
    }
    const { group } = this.authorizedAccount(session, arg["from"]);
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
    return this.sign(caller, session, group, (account) => ({
      kind: "evm.transaction",
      network: session.currentNetwork,
      account,
      tx: this.txSkeleton(chainId, {
        gas: quantityOf(arg["gas"], "gas", "0x0"),
        value: quantityOf(arg["value"], "value", "0x0"),
        data,
        ...(to === undefined ? {} : { to }),
      }),
    }));
  }

  /** The eip1559 placeholder the pipeline re-fills; only to, value, data and gas survive. */
  private txSkeleton(
    chainId: number,
    call: { gas: string; value: string; data: string; to?: string },
  ) {
    return {
      type: "eip1559" as const,
      chainId,
      nonce: 0,
      gas: call.gas,
      value: call.value,
      data: call.data,
      ...(call.to === undefined ? {} : { to: call.to }),
      accessList: [],
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
    };
  }

  /**
   * The session authorized for `method` on the request's target network (`network` overrides the
   * session's current one for a WalletConnect call); the returned session's `currentNetwork` is the
   * target so every downstream use — the account binding, the chainId checks — hits it.
   */
  private signingSession(
    caller: ConnectionOrigin,
    method: string,
    network?: string,
  ): ConnectionSession {
    const { connections } = this.options;
    const session = connections.session(caller.origin);
    if (session === undefined) {
      throw unauthorized();
    }
    const target = network ?? session.currentNetwork;
    const authorized = connections.authorize(caller.origin, target, method);
    return authorized.currentNetwork === target
      ? authorized
      : { ...authorized, currentNetwork: target };
  }

  private async sign(
    caller: ConnectionOrigin,
    session: ConnectionSession,
    group: AccountGroup,
    build: (account: AccountRef) => SignRequest,
  ): Promise<string> {
    const { connections, requests } = this.options;
    const account = { kind: "hd", ...group, template: "evm.bip44" } as const;
    try {
      const pending = await requests.prepare({
        method: "evm-sign",
        origin: caller,
        account,
        network: session.currentNetwork,
        request: build(account),
      });
      const result = await requests.outcome(pending.id);
      await connections.touch(caller.origin);
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
    const { group } = this.authorizedAccount(session, address0);
    const networks =
      asked === undefined
        ? Object.keys(session.scopes).filter((s) => s.startsWith("eip155:"))
        : (() => {
            if (
              !Array.isArray(asked) ||
              !asked.every((c) => typeof c === "string" && /^0x[0-9a-fA-F]+$/.test(c))
            ) {
              throw invalidParams("chainIds must be an array of 0x quantities");
            }
            return asked
              .filter((c): c is string => typeof c === "string")
              .map((c) => `eip155:${Number.parseInt(c, 16)}`);
          })();
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
  private async sendCalls(
    caller: ConnectionOrigin,
    network: string | undefined,
    params: ReadonlyArray<unknown>,
  ): Promise<unknown> {
    const session = this.signingSession(caller, "wallet_sendCalls", network);
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
    if (typeof askedChain !== "string" || !/^0x[0-9a-fA-F]+$/.test(askedChain)) {
      throw invalidParams("chainId must be a 0x quantity");
    }
    if (Number(askedChain) !== chainId) {
      throw new ProviderError(5710, "chainId does not match the session network");
    }
    const { group } = this.authorizedAccount(session, arg["from"]);
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
      if (this.options.batches.get(caller.origin, rawId) !== undefined) {
        throw new ProviderError(5720, `bundle id ${rawId} is already used`);
      }
      id = rawId;
    }
    const { atomicRequired } = arg;
    const txIds: string[] = [];
    /* Atomic for the one-call and the batch paths; a sequential fallback is not atomic. */
    let atomic = true;
    try {
      const [first] = calls;
      if (calls.length === 1 && first !== undefined) {
        const tracked = await this.submitCall(caller, session, account, first);
        txIds.push(tracked.id);
      } else {
        const status = await this.options.delegationState(account, session.currentNetwork);
        /*
         * A delegated account always batches; an undelegated one upgrades only when the page
         * requires atomicity — a `none` account with `atomicRequired: false` stays sequential.
         */
        if (
          status.state === "ours" ||
          (status.supported && status.state === "none" && atomicRequired)
        ) {
          const tracked = await this.submitBatch(caller, session, account, calls);
          txIds.push(tracked.id);
        } else if (atomicRequired) {
          throw new ProviderError(5760, "atomicity is not supported on this account");
        } else {
          atomic = false;
          for (const [index, tx] of calls.entries()) {
            try {
              // oxlint-disable-next-line eslint/no-await-in-loop -- each call is approved separately, in order
              const tracked = await this.submitCall(caller, session, account, tx);
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
      origin: caller.origin,
      id,
      network: session.currentNetwork,
      atomic,
      txIds,
      /* One atomic transaction for the batch/single paths; one per call for sequential. */
      expected: atomic ? 1 : calls.length,
      createdAt: this.options.now(),
    });
    return { id };
  }

  /** One call through the `evm-sign` transaction path — its own approval. */
  private async submitCall(
    caller: ConnectionOrigin,
    session: ConnectionSession,
    account: AccountRef,
    call: { to: string; data: string; value: string },
  ): Promise<TrackedTransaction> {
    const chainId = evmChainId(session.currentNetwork);
    const pending = await this.options.requests.prepare({
      method: "evm-sign",
      origin: caller,
      account,
      network: session.currentNetwork,
      request: {
        kind: "evm.transaction",
        network: session.currentNetwork,
        account,
        tx: this.txSkeleton(chainId ?? 0, {
          gas: "0x0",
          value: call.value,
          data: call.data,
          to: call.to,
        }),
      },
    });
    const result = await this.options.requests.outcome(pending.id);
    await this.options.connections.touch(caller.origin);
    if (!("id" in result)) {
      throw internalError("the transaction has no tracked id");
    }
    return result;
  }

  /** ≥2 calls through `evm-batch` with the page's origin. */
  private async submitBatch(
    caller: ConnectionOrigin,
    session: ConnectionSession,
    account: AccountRef,
    calls: ReadonlyArray<{ to: string; data: string; value: string }>,
  ): Promise<TrackedTransaction> {
    const pending = await this.options.requests.prepare({
      method: "evm-batch",
      origin: caller,
      account,
      network: session.currentNetwork,
      calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })),
      fee: "normal",
    });
    const result = await this.options.requests.outcome(pending.id);
    await this.options.connections.touch(caller.origin);
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
    const pending = txs.some((tx) => LIVE_TX_STATES.has(tx.state));
    const allConfirmed =
      txs.length === record.expected && txs.every((tx) => tx.state === "confirmed");
    const noneLanded = txs.length > 0 && txs.every(notOnChain);
    const allReverted = txs.length > 0 && txs.every(reverted);
    const status = pending ? 100 : allConfirmed ? 200 : noneLanded ? 400 : allReverted ? 500 : 600;
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

const LIVE_TX_STATES: ReadonlySet<string> = new Set(["draft", "signed", "submitted", "pending"]);

/* Broadcast then dropped/replaced/failed-before-landing never landed; failed with a hash did revert. */
const notOnChain = (tx: TrackedTransaction): boolean =>
  tx.state === "rejected" ||
  tx.state === "dropped" ||
  tx.state === "replaced" ||
  (tx.state === "failed" && tx.hash === undefined);

const reverted = (tx: TrackedTransaction): boolean =>
  tx.state === "failed" && tx.hash !== undefined;

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
