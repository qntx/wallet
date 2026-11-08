import { requestBase } from "../account-ref.ts";
import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { isRecord, networkChainId, normalizeEvmTransaction } from "./transaction.ts";
import { domainChainId, parseTypedData } from "./typed-data.ts";

export { EVM_NATIVE_ASSET } from "./assets.ts";
export { isEvmAddress, checksumEvmAddress, evmAddressFromPublicKey } from "./address.ts";
export {
  networkChainId,
  normalizeEvmTransaction,
  canonicalHex,
  isCanonicalHex,
} from "./transaction.ts";
export { PERMIT2_ADDRESS } from "./approval.ts";
export { decodeEvm, verifiabilityEvm } from "./decode.ts";
export { DELEGATION_MANAGER, ENTRY_POINT_V08, assertNoExecutionGrant } from "./grants.ts";
export { SAFE_MULTISEND_CALL_ONLY } from "./safe.ts";
export { recoverEvmSigner } from "./recover.ts";
export { parseTypedData } from "./typed-data.ts";
export { evmTokenTable, lookupEvmToken } from "./tokens.ts";
export type { EvmToken, EvmTokenTable } from "./tokens.ts";

/**
 * Normalizes a SignRequest for the EVM family: exact key sets, chainId vs the CAIP-2 `network`,
 * canonical quantities and EIP-55 addresses. Idempotent.
 */
export const normalizeEvm = (request: unknown): SignRequest => {
  if (!isRecord(request) || typeof request["kind"] !== "string") {
    throw new ChainError("invalid-request", "request must be an object with a kind");
  }
  const { network, account } = requestBase(request);
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
    const { json } = parseTypedData(typedData);
    const domainChain = domainChainId(json.domain);
    if (domainChain !== undefined && domainChain !== chainId) {
      throw new ChainError(
        "chain-id-mismatch",
        `typed-data domain.chainId ${domainChain} does not match network ${network}`,
      );
    }
    return { kind: "evm.typed-data", network, account, typedData };
  }
  throw new ChainError("unsupported", `unsupported sign request kind: ${request["kind"]}`);
};
