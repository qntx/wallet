import { base58, base64 } from "@scure/base";
import { address, getTransactionDecoder } from "@solana/kit";

import { ProviderError, internalError, invalidParams } from "../connect/errors.ts";
import { walletStandardChain } from "../connect/solana.ts";
import type { NamespaceRow, WalletConnectCall, WalletConnectEngine } from "./namespaces.ts";
import { bytesField, bytesListField } from "./results.ts";

const isParams = (params: unknown): params is Record<string, unknown> =>
  typeof params === "object" && params !== null;

const pubkeyOf = (params: Record<string, unknown>): string | undefined => {
  const { pubkey } = params;
  if (pubkey !== undefined && typeof pubkey !== "string") {
    throw invalidParams("pubkey must be a base58 address");
  }
  return pubkey;
};

const base58Of = (value: unknown, name: string): Uint8Array => {
  if (typeof value !== "string") {
    throw invalidParams(`${name} must be a base58 string`);
  }
  try {
    return base58.decode(value);
  } catch {
    throw invalidParams(`${name} is not valid base58`);
  }
};

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

/** The session's Solana address — the signer whose slot the returned signature is read from. */
const sessionAddress = (call: WalletConnectCall, engine: WalletConnectEngine): string => {
  const [bound] =
    engine.connections.sessionAccounts(call.origin.origin, call.network)?.addresses ?? [];
  if (bound === undefined) {
    throw new ProviderError(4100, "no solana account for this origin");
  }
  return bound;
};

const signMessage = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const pubkey = pubkeyOf(params);
  if (pubkey === undefined) {
    throw invalidParams("solana_signMessage needs the signing pubkey");
  }
  const result = await engine.solanaWallet.handle(call.origin, {
    method: "solana:signMessage",
    params: { message: base58Of(params["message"], "message"), accounts: [pubkey] },
    network: call.network,
  });
  return { signature: base58.encode(bytesField(result, "signature")) };
};

const signTransaction = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const pubkey = pubkeyOf(params);
  const chain = walletStandardChain(call.network);
  if (chain === undefined) {
    throw internalError(`network ${call.network} has no Wallet Standard chain id`);
  }
  const result = await engine.solanaWallet.handle(call.origin, {
    method: "solana:signTransaction",
    // The spec's deprecated legacy fields are ignored — the transaction is the only input.
    params: {
      transactions: [base64Of(params["transaction"], "transaction")],
      accounts: pubkey === undefined ? [] : [pubkey],
      chains: [chain],
    },
    network: call.network,
  });
  const [signed] = bytesListField(result, "signedTransactions");
  if (signed === undefined) {
    throw internalError("the sign request returned no transaction");
  }
  const signature =
    getTransactionDecoder().decode(signed).signatures[address(sessionAddress(call, engine))];
  if (signature === null || signature === undefined) {
    throw internalError("the signed transaction has no signature for the session account");
  }
  return {
    signature: base58.encode(new Uint8Array(signature)),
    transaction: base64.encode(signed),
  };
};

const signAllTransactions = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const raw = params["transactions"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidParams("solana_signAllTransactions needs a non-empty transactions array");
  }
  const chain = walletStandardChain(call.network);
  if (chain === undefined) {
    throw internalError(`network ${call.network} has no Wallet Standard chain id`);
  }
  const result = await engine.solanaWallet.handle(call.origin, {
    method: "solana:signTransaction",
    params: {
      transactions: raw.map((tx) => base64Of(tx, "each transaction")),
      chains: raw.map(() => chain),
    },
    network: call.network,
  });
  return {
    transactions: bytesListField(result, "signedTransactions").map((tx) => base64.encode(tx)),
  };
};

const signAndSend = async (
  call: WalletConnectCall,
  engine: WalletConnectEngine,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const pubkey = pubkeyOf(params);
  const chain = walletStandardChain(call.network);
  if (chain === undefined) {
    throw internalError(`network ${call.network} has no Wallet Standard chain id`);
  }
  const result = await engine.solanaWallet.handle(call.origin, {
    method: "solana:signAndSendTransaction",
    // sendOptions is ignored: the engine broadcasts with its own commitment and polling.
    params: {
      transactions: [base64Of(params["transaction"], "transaction")],
      accounts: pubkey === undefined ? [] : [pubkey],
      chains: [chain],
    },
    network: call.network,
  });
  const [signature] = bytesListField(result, "signatures");
  if (signature === undefined) {
    throw internalError("the broadcast returned no signature");
  }
  return { signature: base58.encode(signature) };
};

const dispatch = async (call: WalletConnectCall, engine: WalletConnectEngine): Promise<unknown> => {
  const params = isParams(call.params) ? call.params : {};
  switch (call.method) {
    case "solana_signMessage":
      return signMessage(call, engine, params);
    case "solana_signTransaction":
      return signTransaction(call, engine, params);
    case "solana_signAllTransactions":
      return signAllTransactions(call, engine, params);
    case "solana_signAndSendTransaction":
      return signAndSend(call, engine, params);
    default:
      throw new ProviderError(-32601, `unsupported solana method ${call.method}`);
  }
};

/**
 * The solana namespace: every request is translated into a `solana:*` Wallet Standard call on the
 * shared handler with the request's CAIP-2 chain as its network — base58/base64 wire codecs are
 * adapted here, strict-decoded to `invalidParams` failures.
 */
export const solanaRow: NamespaceRow = {
  namespace: "solana",
  methods: {
    solana_signMessage: ["solana:signMessage"],
    solana_signTransaction: ["solana:signTransaction"],
    solana_signAllTransactions: ["solana:signTransaction"],
    solana_signAndSendTransaction: ["solana:signAndSendTransaction"],
  },
  events: ["accountsChanged", "chainChanged"],
  serves: (network) => walletStandardChain(network) !== undefined,
  accounts: (scope) => scope.accounts,
  dispatch,
};
