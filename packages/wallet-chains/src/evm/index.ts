import { ChainError } from "../index.ts";
import type { SignRequest } from "../index.ts";
import { networkChainId, normalizeEvmTransaction } from "./transaction.ts";
import { parseTypedData } from "./typed-data.ts";

export { isEvmAddress, checksumEvmAddress } from "./address.ts";
export {
  networkChainId,
  normalizeEvmTransaction,
  canonicalHex,
  isCanonicalHex,
} from "./transaction.ts";
export { decodeEvm, verifiabilityEvm } from "./decode.ts";
export { parseTypedData } from "./typed-data.ts";
export { evmTokenTable, lookupEvmToken } from "./tokens.ts";
export type { EvmToken, EvmTokenTable } from "./tokens.ts";

/**
 * Normalizes a SignRequest for the EVM family: exact key sets, chainId vs the CAIP-2 `network`,
 * canonical quantities and EIP-55 addresses. Idempotent.
 */
export const normalizeEvm = (request: SignRequest): SignRequest => {
  const { network } = request;
  const chainId = networkChainId(network);
  if (request.kind === "evm.transaction") {
    const tx = normalizeEvmTransaction(request.tx);
    if (tx.chainId !== chainId) {
      throw new ChainError(
        "chain-id-mismatch",
        `tx.chainId ${tx.chainId} does not match network ${network}`,
      );
    }
    return { ...request, tx };
  }
  if (request.kind === "evm.personal-message") {
    if (!(request.message instanceof Uint8Array)) {
      throw new ChainError("invalid-request", "personal-message payload must be bytes");
    }
    return request;
  }
  if (request.kind === "evm.typed-data") {
    if (typeof request.typedData !== "string") {
      throw new ChainError("invalid-request", "typed-data payload must be the JSON source string");
    }
    parseTypedData(request.typedData, network);
    return request;
  }
  throw new ChainError(
    "unsupported",
    `unsupported sign request kind: ${(request as { kind: string }).kind}`,
  );
};
