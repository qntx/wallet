import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { ChainError } from "@qntx/wallet-chains";
import {
  isTronAddress,
  tronAddressToHex,
  tronRawDataFromJson,
  tronTypedDataFromArgs,
} from "@qntx/wallet-chains/tron";

import { networkById } from "../networks/registry.ts";
import {
  InvalidTokenError,
  OriginBusyError,
  RequestEndedError,
  SignInOriginError,
} from "../requests/controller.ts";
import type { RequestController } from "../requests/controller.ts";
import { BroadcastRefusedError } from "../transactions/broadcast.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type { ConnectionController, ConnectionSession } from "./controller.ts";
import { sessionAccounts } from "./controller.ts";
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

/**
 * The TronLink-style (`window.tron` / `window.tronLink`) handler — the bridge routes `provider:
 * "tron"` messages here.
 */
export type TronRequest = {
  readonly method: string;
  readonly params?: unknown;
};

export type TronHandler = {
  readonly handle: (origin: string, request: TronRequest) => Promise<unknown>;
  readonly subscribe: (listener: (event: TronEvent) => void) => () => void;
};

/** The address pair `tron_getProviderState` and `tronWeb.defaultAddress` report. */
export type TronProviderAddress = { readonly base58: string; readonly hex: string };

/** The injected provider's state: the page mirrors it on `defaultAddress`/`ready`/events. */
export type TronProviderState = {
  readonly address: TronProviderAddress | false;
  readonly chainId: string;
  /** The network's genesis block id — `trx.getBlockByNumber(0)` reports it as `blockID`. */
  readonly genesis: string;
};

export type TronEvent = {
  readonly name: "tronStateChanged";
  readonly origin: string;
  readonly state: TronProviderState;
};

type TronConnections = Pick<
  ConnectionController,
  | "checkOrigin"
  | "session"
  | "authorize"
  | "sessionAccounts"
  | "setTronNetwork"
  | "request"
  | "touch"
  | "revoke"
  | "getState"
  | "store"
>;

type TronRequests = Pick<RequestController, "prepare" | "outcome">;

type Options = {
  readonly connections: TronConnections;
  readonly requests: TronRequests;
  readonly transactions: Pick<TransactionController, "submitDappTron">;
  /** The enabled TRON networks (`tron:` CAIP-2 ids) — every one is in a `tron` grant's scopes. */
  readonly tronNetworks: () => ReadonlyArray<string>;
  /** The default TRON network — the current one until a session picks another. */
  readonly tronNetwork: () => string;
  /** Whether the TRC-20 contract at `address` on `network` is already tracked. */
  readonly isTracked: (network: string, address: string) => boolean;
};

/** `raw_data_hex` must fit a broadcastable TRON transaction; 500 KiB is far above the node limit. */
const TRON_RAW_DATA_HEX_MAX = 500 * 1024 * 2;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isBytesEnvelope = (v: unknown): v is { __bytes: string } =>
  isObject(v) && typeof v["__bytes"] === "string";

/** `tron:728126428` → `0x2b6653dc` — the CAIP-2 decimal reference in lowercase hex. */
const tronChainId = (network: string): string | undefined => {
  const ref = /^tron:(\d+)$/.exec(network)?.[1];
  return ref === undefined ? undefined : `0x${BigInt(ref).toString(16)}`;
};

const bytesOf = (value: unknown, name: string): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string" && /^[0-9a-fA-F]+$/.test(value)) {
    return hexToBytes(value);
  }
  if (isBytesEnvelope(value) && /^[0-9a-fA-F]+$/.test(value.__bytes)) {
    return hexToBytes(value.__bytes);
  }
  throw invalidParams(`${name} must be Uint8Array bytes or hex`);
};

const toProviderError = (error: unknown): ProviderError => {
  if (error instanceof ProviderError) {
    return error;
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
};

/**
 * The Wallet-Standard-like TronLink handler: `tron_requestAccounts`/`eth_requestAccounts` authorize
 * the `tron` scope, signing goes through `tron-sign`, `tronStateChanged` carries the provider state
 * the injected script turns into `accountsChanged`/`chainChanged`/`connect`.
 */
export class TronWalletHandler implements TronHandler {
  readonly options: Options;
  private readonly events: SessionEvents<TronEvent>;

  constructor(options: Options) {
    this.options = options;
    this.events = new SessionEvents(options.connections, (before, after) =>
      diffSessions(before, after).map(({ origin, session }): TronEvent => ({
        name: "tronStateChanged",
        origin,
        state: this.providerState(session),
      })),
    );
  }

  /** `tronStateChanged` per origin — derived from changes to the sessions. */
  subscribe(listener: (event: TronEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async handle(origin: string, request: TronRequest): Promise<unknown> {
    const checked = this.options.connections.checkOrigin(origin);
    switch (request.method) {
      case "tron_getProviderState":
        return this.providerState(this.options.connections.session(checked.origin));
      case "eth_requestAccounts":
        return this.requestAccounts(checked, false);
      case "tron_requestAccounts":
        return this.requestAccounts(checked, true);
      case "wallet_switchEthereumChain":
        return this.switchChain(checked, request.params);
      case "wallet_watchAsset":
        return this.watchAsset(checked, request.params);
      case "tron_signTransaction":
        return this.signTransaction(checked, request.params);
      case "tron_sendRawTransaction":
        return this.sendRawTransaction(checked, request.params);
      case "tron_signMessageV2":
        return this.signMessage(checked, request.params);
      case "tron_signTypedData":
        return this.signTypedData(checked, request.params);
      default:
        throw unsupportedMethod(request.method);
    }
  }

  /** The injected provider's state for the session's TRON network (or the default when absent). */
  private providerState(session: ConnectionSession | undefined): TronProviderState {
    const network = session?.tronNetwork ?? this.options.tronNetwork();
    const binding = sessionAccounts(session, network);
    const base58 = binding?.addresses[0];
    return {
      address:
        base58 === undefined ? false : { base58, hex: tronAddressToHex(base58).toLowerCase() },
      chainId: tronChainId(network) ?? "0x0",
      genesis: networkById(network)?.genesisHash ?? "",
    };
  }

  /**
   * `eth_requestAccounts` resolves `[base58]`; the legacy `tron_requestAccounts` resolves a `{code,
   * message}` result instead of rejecting — 200 on success, 4001 when the user refused, 4000 for
   * anything else (TronLink's own convention).
   */
  private async requestAccounts(
    checked: { readonly kind: "browser"; readonly origin: string },
    legacy: boolean,
  ): Promise<unknown> {
    try {
      const session = this.options.connections.session(checked.origin);
      const network = session?.tronNetwork;
      const binding =
        network === undefined
          ? undefined
          : this.options.connections.sessionAccounts(checked.origin, network);
      const address = binding?.addresses[0];
      if (address !== undefined) {
        await this.options.connections.touch(checked.origin);
        return legacy ? { code: 200, message: "wallet authorized" } : [address];
      }
      await this.options.connections.request(checked.origin, {
        kind: "connect",
        namespace: "tron",
      });
      const granted = this.options.connections.session(checked.origin);
      const grantedNetwork = granted?.tronNetwork;
      const grantedBinding =
        grantedNetwork === undefined
          ? undefined
          : this.options.connections.sessionAccounts(checked.origin, grantedNetwork);
      const grantedAddress = grantedBinding?.addresses[0];
      if (grantedAddress === undefined) {
        throw unauthorized("the wallet is not connected");
      }
      return legacy ? { code: 200, message: "wallet authorized" } : [grantedAddress];
    } catch (error) {
      if (!legacy) {
        throw toProviderError(error);
      }
      const code =
        error instanceof ProviderError && error.code === 4001
          ? 4001
          : error instanceof ProviderError && error.code === -32002
            ? 4000
            : 4000;
      return { code, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The session's current TRON network and its binding — every signing method requires both. */
  private signingSession(
    checked: { readonly kind: "browser"; readonly origin: string },
    method: string,
  ): {
    readonly network: string;
    readonly binding: NonNullable<ReturnType<TronConnections["sessionAccounts"]>>;
  } {
    const session = this.options.connections.session(checked.origin);
    const network = session?.tronNetwork;
    if (network === undefined) {
      throw unauthorized("the wallet is not connected");
    }
    this.options.connections.authorize(checked.origin, network, method);
    const binding = this.options.connections.sessionAccounts(checked.origin, network);
    if (binding === undefined || binding.addresses[0] === undefined) {
      throw unauthorized("no TRON account is bound to the session");
    }
    return { network, binding };
  }

  /**
   * A `wallet_switchEthereumChain` on `window.tron` switches the session's TRON network: a chain id
   * that names no enabled TRON network is 4902, no session is 4100.
   */
  private async switchChain(
    checked: { readonly kind: "browser"; readonly origin: string },
    params: unknown,
  ): Promise<unknown> {
    const param: unknown = Array.isArray(params) ? params[0] : undefined;
    const chainId = isObject(param) ? param["chainId"] : undefined;
    if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId)) {
      throw invalidParams("params must be [{ chainId: '0x…' }]");
    }
    const network = this.options
      .tronNetworks()
      .find((n) => tronChainId(n)?.toLowerCase() === chainId.toLowerCase());
    if (network === undefined) {
      throw unrecognizedChain(`${chainId} is not an enabled TRON chain`);
    }
    if (this.options.connections.session(checked.origin) === undefined) {
      throw unauthorized("the wallet is not connected");
    }
    await this.options.connections.setTronNetwork(checked.origin, network);
    return null;
  }

  /** The TRC-20 `wallet_watchAsset`: other token kinds are 4200, malformed params invalid. */
  private async watchAsset(
    checked: { readonly kind: "browser"; readonly origin: string },
    params: unknown,
  ): Promise<void> {
    if (!isObject(params) || params["type"] !== "trc20" || !isObject(params["options"])) {
      if (isObject(params) && (params["type"] === "trc10" || params["type"] === "trc721")) {
        throw unsupportedMethod(`${params["type"]} watch-asset`);
      }
      throw invalidParams("params must be { type: 'trc20', options: { address } }");
    }
    const { address } = params["options"];
    if (typeof address !== "string" || !isTronAddress(address)) {
      throw invalidParams("options.address must be a TRON address");
    }
    const { network, binding } = this.signingSession(checked, "wallet_watchAsset");
    if (this.options.isTracked(network, address)) {
      return;
    }
    try {
      const pending = await this.options.requests.prepare({
        method: "watch-asset",
        origin: checked,
        account: { kind: "hd", ...binding.group, template: "tron.bip44" },
        network,
        address,
      });
      await this.options.requests.outcome(pending.id);
      await this.options.connections.touch(checked.origin);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  /**
   * The dApp transaction shape checks every `tron_sign*`/`tron_send*` call shares: the declared
   * `txID` must be the sha256 of `raw_data_hex`, and a `raw_data` JSON must encode to exactly those
   * bytes — the wallet never signs bytes the page could misrepresent.
   */
  private transactionOf(
    params: unknown,
    signaturePolicy: "absent" | "one",
  ): {
    readonly transaction: Record<string, unknown>;
    readonly rawData: Uint8Array;
    readonly signature: string | undefined;
  } {
    if (!isObject(params) || !isObject(params["transaction"])) {
      throw invalidParams("params must be { transaction }");
    }
    const { transaction } = params;
    if (signaturePolicy === "absent" && transaction["signature"] !== undefined) {
      throw invalidParams("the transaction is already signed");
    }
    const signatures = transaction["signature"];
    if (
      signaturePolicy === "one" &&
      (!Array.isArray(signatures) ||
        signatures.length !== 1 ||
        signatures.some((s) => typeof s !== "string" || !/^[0-9a-fA-F]{130}$/.test(s)))
    ) {
      throw invalidParams("transaction.signature must be exactly one 65-byte hex signature");
    }
    const rawDataHex = transaction["raw_data_hex"];
    if (
      typeof rawDataHex !== "string" ||
      rawDataHex.length % 2 !== 0 ||
      rawDataHex.length > TRON_RAW_DATA_HEX_MAX ||
      !/^[0-9a-fA-F]*$/.test(rawDataHex)
    ) {
      throw invalidParams("transaction.raw_data_hex must be even-length hex within 500 KiB");
    }
    const { txID } = transaction;
    if (typeof txID !== "string" || !/^[0-9a-fA-F]{64}$/.test(txID)) {
      throw invalidParams("transaction.txID must be 64 hex characters");
    }
    if (transaction["visible"] !== undefined && typeof transaction["visible"] !== "boolean") {
      throw invalidParams("transaction.visible must be a boolean");
    }
    const rawData = hexToBytes(rawDataHex);
    if (bytesToHex(sha256(rawData)) !== txID.toLowerCase()) {
      throw invalidParams("transaction.txID does not match raw_data_hex");
    }
    if (transaction["raw_data"] !== undefined) {
      if (!isObject(transaction["raw_data"])) {
        throw invalidParams("transaction.raw_data must be an object");
      }
      let encoded: Uint8Array;
      try {
        encoded = tronRawDataFromJson(transaction["raw_data"], transaction["visible"] === true);
      } catch (error) {
        throw error instanceof ChainError ? invalidParams(error.message) : error;
      }
      if (bytesToHex(encoded) !== rawDataHex.toLowerCase()) {
        throw invalidParams("raw_data does not match raw_data_hex");
      }
    }
    const signature =
      Array.isArray(signatures) && typeof signatures[0] === "string" ? signatures[0] : undefined;
    return { transaction, rawData, signature };
  }

  private async tronSign(
    checked: { readonly kind: "browser"; readonly origin: string },
    network: string,
    binding: NonNullable<ReturnType<TronConnections["sessionAccounts"]>>,
    request: Parameters<TronRequests["prepare"]>[0] extends infer I
      ? I extends { method: "tron-sign"; request: infer R }
        ? R
        : never
      : never,
  ): Promise<Awaited<ReturnType<TronRequests["outcome"]>>> {
    try {
      const pending = await this.options.requests.prepare({
        method: "tron-sign",
        origin: checked,
        account: { kind: "hd", ...binding.group, template: "tron.bip44" },
        network,
        request,
      });
      return await this.options.requests.outcome(pending.id);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  /** `trx.sign(tx)` — signs the exact `raw_data` bytes; the page broadcasts them itself. */
  private async signTransaction(
    checked: { readonly kind: "browser"; readonly origin: string },
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const { transaction, rawData } = this.transactionOf(params, "absent");
    const { network, binding } = this.signingSession(checked, "tron_signTransaction");
    const outcome = await this.tronSign(checked, network, binding, {
      kind: "tron.transaction",
      network,
      account: { kind: "hd", ...binding.group, template: "tron.bip44" },
      rawData,
    });
    const signature =
      "tron" in outcome && outcome.tron !== undefined ? outcome.tron.dappSignature : undefined;
    if (typeof signature !== "string") {
      throw internalError("the tron-sign request settled unexpectedly");
    }
    return { ...transaction, signature: [signature] };
  }

  /** `trx.sendRawTransaction(tx)` — broadcasts a transaction this wallet already signed. */
  private async sendRawTransaction(
    checked: { readonly kind: "browser"; readonly origin: string },
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const { transaction, rawData, signature } = this.transactionOf(params, "one");
    const { network } = this.signingSession(checked, "tron_sendRawTransaction");
    const txid = typeof transaction["txID"] === "string" ? transaction["txID"] : "";
    try {
      await this.options.transactions.submitDappTron(network, rawData, hexToBytes(signature ?? ""));
      return { result: true, txid, transaction };
    } catch (error) {
      if (error instanceof BroadcastRefusedError) {
        const { cause } = error;
        const code =
          isObject(cause) && typeof cause["code"] === "string" ? cause["code"] : "REFUSED";
        return { result: false, code, message: error.message, txid, transaction };
      }
      throw toProviderError(error);
    }
  }

  /** `trx.signMessageV2(m)` — a TIP-191 personal-sign of arbitrary bytes. */
  private async signMessage(
    checked: { readonly kind: "browser"; readonly origin: string },
    params: unknown,
  ): Promise<string> {
    const message = isObject(params) ? params["message"] : undefined;
    if (message === undefined) {
      throw invalidParams("params must be { message }");
    }
    const bytes = bytesOf(message, "message");
    const { network, binding } = this.signingSession(checked, "tron_signMessageV2");
    const outcome = await this.tronSign(checked, network, binding, {
      kind: "tron.message",
      network,
      account: { kind: "hd", ...binding.group, template: "tron.bip44" },
      message: bytes,
    });
    if (!("signature" in outcome) || !(outcome.signature instanceof Uint8Array)) {
      throw internalError("the tron-sign request settled unexpectedly");
    }
    return `0x${bytesToHex(outcome.signature)}`;
  }

  /** `trx.signTypedData`/`_signTypedData` — a TIP-712 typed-data signature. */
  private async signTypedData(
    checked: { readonly kind: "browser"; readonly origin: string },
    params: unknown,
  ): Promise<string> {
    if (
      !isObject(params) ||
      !isObject(params["domain"]) ||
      !isObject(params["types"]) ||
      params["message"] === undefined
    ) {
      throw invalidParams("params must be { domain, types, message }");
    }
    let typedData: string;
    try {
      typedData = tronTypedDataFromArgs(params["domain"], params["types"], params["message"]);
    } catch (error) {
      throw error instanceof ChainError ? invalidParams(error.message) : error;
    }
    const { network, binding } = this.signingSession(checked, "tron_signTypedData");
    const outcome = await this.tronSign(checked, network, binding, {
      kind: "tron.typed-data",
      network,
      account: { kind: "hd", ...binding.group, template: "tron.bip44" },
      typedData,
    });
    if (!("signature" in outcome) || !(outcome.signature instanceof Uint8Array)) {
      throw internalError("the tron-sign request settled unexpectedly");
    }
    return `0x${bytesToHex(outcome.signature)}`;
  }
}

const byOrigin = (
  sessions: Readonly<Record<string, ConnectionSession>>,
): Map<string, ConnectionSession> =>
  new Map(Object.values(sessions).map((s) => [s.origin.origin, s]));

const tronAccounts = (session: ConnectionSession): ReadonlyArray<string> =>
  Object.entries(session.scopes)
    .filter(([network]) => network.startsWith("tron:"))
    .flatMap(([, scope]) => scope.accounts.map((a) => a.slice(a.lastIndexOf(":") + 1)));

const tronFingerprint = (session: ConnectionSession): string =>
  `${tronAccounts(session).join(",")}@${session.tronNetwork ?? ""}`;

/**
 * The origins whose TRON scope accounts or current TRON network changed between the two snapshots,
 * each with the session after the write (`undefined` when the session is gone).
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
    if (now === undefined || tronFingerprint(session) !== tronFingerprint(now)) {
      events.push({ origin, session: now });
    }
  }
  for (const [origin, session] of next) {
    if (!prev.has(origin) && tronAccounts(session).length > 0) {
      events.push({ origin, session });
    }
  }
  return events;
}
