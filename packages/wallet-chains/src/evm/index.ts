import { ChainError } from "../index.ts";
import type { AccountRef, SignRequest } from "../index.ts";
import { isRecord, networkChainId, normalizeEvmTransaction } from "./transaction.ts";
import { parseTypedData } from "./typed-data.ts";

export { isEvmAddress, checksumEvmAddress, evmAddressFromPublicKey } from "./address.ts";
export {
  networkChainId,
  normalizeEvmTransaction,
  canonicalHex,
  isCanonicalHex,
} from "./transaction.ts";
export { decodeEvm, verifiabilityEvm } from "./decode.ts";
export { recoverEvmSigner } from "./recover.ts";
export { parseTypedData } from "./typed-data.ts";
export { evmTokenTable, lookupEvmToken } from "./tokens.ts";
export type { EvmToken, EvmTokenTable } from "./tokens.ts";

/**
 * Normalizes a SignRequest for the EVM family: exact key sets, chainId vs the CAIP-2 `network`,
 * canonical quantities and EIP-55 addresses. Idempotent.
 */
const isAccountRef = (value: unknown): value is AccountRef => {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    return false;
  }
  if (value["kind"] === "hd") {
    return (
      typeof value["walletId"] === "string" &&
      typeof value["groupIndex"] === "number" &&
      typeof value["template"] === "string"
    );
  }
  if (value["kind"] === "imported") {
    return typeof value["keyId"] === "string" && typeof value["family"] === "string";
  }
  return false;
};

export const normalizeEvm = (request: unknown): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  const { network } = request;
  const { account } = request;
  if (typeof network !== "string") {
    throw new ChainError("invalid-request", "request.network must be a string");
  }
  if (!isAccountRef(account)) {
    throw new ChainError("invalid-request", "request.account must be an AccountRef");
  }
  const chainId = networkChainId(network);
  if (request["kind"] === "evm.transaction") {
    const tx = normalizeEvmTransaction(request["tx"]);
    if (tx.chainId !== chainId) {
      throw new ChainError(
        "chain-id-mismatch",
        `tx.chainId ${tx.chainId} does not match network ${network}`,
      );
    }
    return { kind: "evm.transaction", network, account, tx };
  }
  if (request["kind"] === "evm.personal-message") {
    const { message } = request;
    if (!(message instanceof Uint8Array)) {
      throw new ChainError("invalid-request", "personal-message payload must be bytes");
    }
    return { kind: "evm.personal-message", network, account, message };
  }
  if (request["kind"] === "evm.typed-data") {
    const { typedData } = request;
    if (typeof typedData !== "string") {
      throw new ChainError("invalid-request", "typed-data payload must be the JSON source string");
    }
    parseTypedData(typedData, network);
    return { kind: "evm.typed-data", network, account, typedData };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};
