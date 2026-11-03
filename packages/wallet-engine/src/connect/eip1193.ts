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
import { OriginBusyError, RequestEndedError } from "../requests/controller.ts";
import type { RequestController } from "../requests/controller.ts";
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
};

/** Refused outright, whatever the session. */
const REFUSED: ReadonlySet<string> = new Set([
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTransaction",
  "eth_sendRawTransaction",
]);

/** Planned for later layers; answered `4200` until then. */
const DEFERRED: ReadonlySet<string> = new Set([
  "wallet_addEthereumChain",
  "wallet_watchAsset",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_getCapabilities",
  "wallet_showCallsStatus",
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
    const bytes = hexToBytes(value.slice(2));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ProviderError(4200, "blind signing is not enabled: the message is not UTF-8 text");
    }
    return bytes;
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
  private readonly listeners = new Set<(event: Eip1193Event) => void>();
  private unsubscribe: (() => void) | undefined;

  constructor(options: Eip1193HandlerOptions) {
    this.options = options;
  }

  /** Events for the host to forward to pages; derived from changes to the sessions. */
  subscribe(listener: (event: Eip1193Event) => void): () => void {
    this.listeners.add(listener);
    if (this.unsubscribe === undefined) {
      let previous = this.options.connections.getState().sessions;
      this.unsubscribe = this.options.connections.store.subscribe((state) => {
        for (const event of diffSessions(previous, state.sessions)) {
          for (const l of this.listeners) {
            l(event);
          }
        }
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

  async handle(origin: string, request: Eip1193Request): Promise<unknown> {
    const { connections } = this.options;
    connections.checkOrigin(origin);
    const { method } = request;
    const params = paramList(request.params);
    if (REFUSED.has(method) || DEFERRED.has(method)) {
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
      case "personal_sign":
        return this.personalSign(origin, params);
      case "eth_signTypedData_v4":
        return this.typedData(origin, params);
      case "eth_sendTransaction":
        return this.sendTransaction(origin, params[0]);
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
      await connections.request(origin, "connect");
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
      await connections.request(origin, "network", network);
    } else if (session.currentNetwork !== network) {
      await connections.setCurrentNetwork(origin, network);
    }
    return null;
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
    build: (account: SignRequest["account"]) => SignRequest,
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
    }
  }
  return events;
}
