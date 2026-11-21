import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import { bitcoinStandardChain } from "../connect/bitcoin.ts";
import type { SessionAccounts } from "../connect/controller.ts";
import { ProviderError, internalError, invalidParams, toProviderError } from "../connect/errors.ts";
import type { WalletConnectOrigin } from "../requests/types.ts";
import type { TrackedTransaction } from "../transactions/route.ts";
import type { NamespaceRow, WalletConnectCall, WalletConnectEngine } from "./namespaces.ts";
import { bytesField, recordsList, recordsListField } from "./results.ts";

const isParams = (params: unknown): params is Record<string, unknown> =>
  typeof params === "object" && params !== null;

const base64Of = (value: unknown, name: string): Uint8Array => {
  if (typeof value !== "string") {
    throw invalidParams(`${name} must be a base64 string`);
  }
  try {
    return base64.decode(value);
  } catch {
    throw invalidParams(`${name} is not valid base64`);
  }
};

/**
 * The session's Bitcoin binding — every bip122 method needs it up front: falling through to a
 * handler would open a connect prompt the WalletConnect flow must never raise.
 */
const requireBinding = (call: WalletConnectCall, engine: WalletConnectEngine): SessionAccounts => {
  const binding = engine.connections.sessionAccounts(call.origin.origin, call.network);
  if (binding === undefined) {
    throw new ProviderError(4100, "no bitcoin account for this origin");
  }
  return binding;
};

/**
 * `params.account` names the session's WalletConnect account — the payment (BIP-84) address, the
 * only address the namespace advertises.
 */
const requireAccount = (params: Record<string, unknown>, binding: SessionAccounts): string => {
  const [payment] = binding.addresses;
  if (params["account"] !== payment || payment === undefined) {
    throw new ProviderError(4100, "account is not the connected account");
  }
  return payment;
};

type AddressEntry = {
  readonly address: string;
  readonly publicKey: string;
  readonly intention: "payment" | "ordinal";
};

/** `bitcoin:connect` for the given purposes — the session is bound, so no prompt can open. */
const addressesFor = async (
  engine: WalletConnectEngine,
  origin: WalletConnectOrigin,
  network: string,
  purposes: ReadonlyArray<"payment" | "ordinals">,
): Promise<AddressEntry[]> => {
  const result = await engine.bitcoinWallet.handle(origin, {
    method: "bitcoin:connect",
    params: { purposes: [...purposes] },
    network,
  });
  return recordsListField(result, "accounts").map((account, index) => {
    if (typeof account["address"] !== "string" || !(account["publicKey"] instanceof Uint8Array)) {
      throw internalError("the connect result has no account address and key");
    }
    return {
      address: account["address"],
      publicKey: bytesToHex(account["publicKey"]),
      intention: purposes[index] === "ordinals" ? "ordinal" : "payment",
    };
  });
};

/** The `bip122_addressesChanged` payload — the getAccountAddresses result for both purposes. */
export const bip122Addresses = async (
  engine: WalletConnectEngine,
  origin: WalletConnectOrigin,
  network: string,
): Promise<AddressEntry[]> => addressesFor(engine, origin, network, ["payment", "ordinals"]);

const INTENTION_PURPOSES: Readonly<Record<string, "payment" | "ordinals">> = {
  payment: "payment",
  ordinal: "ordinals",
};

const getAccountAddresses = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const binding = requireBinding(call, engine);
  requireAccount(params, binding);
  const raw = params["intentions"];
  if (raw !== undefined && !Array.isArray(raw)) {
    throw invalidParams("intentions must be an array of payment/ordinal");
  }
  const purposes =
    raw === undefined || raw.length === 0
      ? (["payment", "ordinals"] as const)
      : raw.map((intention) => {
          const purpose = INTENTION_PURPOSES[String(intention)];
          if (purpose === undefined) {
            throw invalidParams(`unknown intention ${String(intention)}`);
          }
          return purpose;
        });
  return addressesFor(engine, call.origin, call.network, purposes);
};

const signMessage = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const binding = requireBinding(call, engine);
  requireAccount(params, binding);
  // The engine's bitcoin-sign message path signs BIP-322 simple only — the spec's default
  // (absent protocol means ecdsa) is refused rather than silently answered differently.
  if (params["protocol"] !== "bip322") {
    throw new ProviderError(4200, "only BIP-322 message signatures are supported");
  }
  const { address: named, message } = params;
  if (named !== undefined && typeof named !== "string") {
    throw invalidParams("address must be a string");
  }
  if (typeof message !== "string") {
    throw invalidParams("signMessage needs a message string");
  }
  const address = named ?? requireAccount(params, binding);
  const result = await engine.bitcoinWallet.handle(call.origin, {
    method: "bitcoin:signMessage",
    params: { account: address, message: utf8ToBytes(message) },
    network: call.network,
  });
  return { address, signature: bytesToHex(bytesField(result, "signature")) };
};

const sigHashOf = (value: unknown): "ALL" | "SINGLE|ANYONECANPAY" => {
  if (value === undefined) {
    return "ALL";
  }
  if (!Array.isArray(value)) {
    throw invalidParams("sighashTypes must be an array of sighash bytes");
  }
  if (value.length === 1 && value[0] === 1) {
    return "ALL";
  }
  if (value.length === 1 && value[0] === 131) {
    return "SINGLE|ANYONECANPAY";
  }
  throw invalidParams("sighashTypes must be exactly [1] or [131]");
};

const signPsbt = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const binding = requireBinding(call, engine);
  requireAccount(params, binding);
  const { broadcast } = params;
  if (broadcast !== undefined && typeof broadcast !== "boolean") {
    throw invalidParams("broadcast must be a boolean");
  }
  const raw = params["signInputs"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidParams("signPsbt needs a non-empty signInputs array");
  }
  // Group the sign entries by (address, sigHash), first-seen — the handler's wire shape.
  const groups = new Map<string, { address: string; signingIndexes: number[]; sigHash: string }>();
  for (const entry of raw) {
    const { address, index, sighashTypes } = isParams(entry) ? entry : {};
    if (
      typeof address !== "string" ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw invalidParams("each signInput needs an address and a non-negative index");
    }
    const sigHash = sigHashOf(sighashTypes);
    const key = `${address} ${sigHash}`;
    const group = groups.get(key) ?? { address, signingIndexes: [], sigHash };
    group.signingIndexes.push(index);
    groups.set(key, group);
  }
  const chain = bitcoinStandardChain(call.network);
  if (chain === undefined) {
    throw internalError(`network ${call.network} has no Bitcoin Wallet Standard chain id`);
  }
  const result = await engine.bitcoinWallet.handle(call.origin, {
    method: broadcast === true ? "bitcoin:signAndSendTransaction" : "bitcoin:signTransaction",
    params: {
      inputs: [
        {
          psbt: base64Of(params["psbt"], "psbt"),
          chain,
          inputsToSign: [...groups.values()],
        },
      ],
    },
    network: call.network,
  });
  const [first] = recordsList(result);
  if (first === undefined) {
    throw internalError("the sign request returned no PSBT");
  }
  const txid = first["txId"];
  if (txid !== undefined && typeof txid !== "string") {
    throw internalError("the sign request returned a non-string txid");
  }
  return txid === undefined
    ? { psbt: base64.encode(bytesField(first, "signedPsbt")) }
    : { psbt: base64.encode(bytesField(first, "signedPsbt")), txid };
};

const MAX_SATS = 2_100_000_000_000_000;

const sendTransfer = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const binding = requireBinding(call, engine);
  requireAccount(params, binding);
  const { memo, recipientAddress, amount, changeAddress } = params;
  // The engine's sends never carry an OP_RETURN output — refuse rather than drop the memo.
  if (typeof memo === "string" && memo !== "") {
    throw new ProviderError(4200, "OP_RETURN memos are not supported");
  }
  if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > MAX_SATS) {
    throw invalidParams("amount must be a positive satoshi count");
  }
  if (typeof recipientAddress !== "string") {
    throw invalidParams("recipientAddress must be a string");
  }
  // A change address is validated but otherwise unused — the engine picks change inside the
  // same account regardless.
  if (
    changeAddress !== undefined &&
    !(typeof changeAddress === "string" && binding.addresses.includes(changeAddress))
  ) {
    throw invalidParams("changeAddress is not one of the session's addresses");
  }
  engine.connections.authorize(call.origin.origin, call.network, "sendTransfer");
  let tx: TrackedTransaction;
  try {
    const pending = await engine.requests.prepare({
      method: "send",
      origin: call.origin,
      account: {
        kind: "hd",
        walletId: binding.group.walletId,
        groupIndex: binding.group.groupIndex,
        template: "btc.bip84",
      },
      network: call.network,
      to: recipientAddress,
      amount: BigInt(amount),
      fee: "normal",
    });
    const outcome = await engine.requests.outcome(pending.id);
    if (!("hash" in outcome)) {
      throw internalError("the send request settled unexpectedly");
    }
    tx = outcome;
  } catch (error) {
    throw toProviderError(error);
  }
  if (tx.hash === undefined) {
    throw internalError("the broadcast has no transaction id");
  }
  await engine.connections.touch(call.origin.origin);
  return { txid: tx.hash };
};

const dispatch = async (call: WalletConnectCall, engine: WalletConnectEngine): Promise<unknown> => {
  const params = isParams(call.params) ? call.params : {};
  switch (call.method) {
    case "getAccountAddresses":
      return getAccountAddresses(call, engine, params);
    case "signMessage":
      return signMessage(call, engine, params);
    case "signPsbt":
      return signPsbt(call, engine, params);
    case "sendTransfer":
      return sendTransfer(call, engine, params);
    default:
      throw new ProviderError(-32601, `unsupported bip122 method ${call.method}`);
  }
};

/**
 * The bip122 namespace: requests translate into `bitcoin:*` Wallet Standard calls (or the shared
 * `send` pipeline for sendTransfer) with the request's CAIP-2 chain as its network. The session
 * advertises only the payment address — WalletConnect's Bitcoin spec has dApps display the first
 * external address; ordinals stays reachable through getAccountAddresses.
 */
export const bip122Row: NamespaceRow = {
  namespace: "bip122",
  methods: {
    getAccountAddresses: ["bitcoin:connect"],
    signMessage: ["bitcoin:signMessage"],
    signPsbt: ["bitcoin:signTransaction", "bitcoin:signAndSendTransaction"],
    sendTransfer: ["sendTransfer"],
  },
  events: ["accountsChanged", "chainChanged", "bip122_addressesChanged"],
  serves: (network) => bitcoinStandardChain(network) !== undefined,
  accounts: (scope) => scope.accounts.slice(0, 1),
  dispatch,
};
